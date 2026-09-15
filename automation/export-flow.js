const BrowserManager = require('./browser-manager');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { app } = require('electron');

// ==================== 网站地址 ====================
// 网站1：道路运输车辆运营监测分析应用（报警申诉列表）
const SITE1_NAME = '道路运输车辆运营监测分析应用';
const SITE1_COMPLAINT_URL = 'http://183.192.65.93:8807/gps/complaint';
// 网站2：中安GPS/BD运输车辆监控平台（车辆监控 / 轨迹回放 / 导出轨迹）
const SITE2_NAME = '运输车辆监控平台';
const SITE2_LOGIN_URL = 'http://114.80.138.167:6385/index.html';
const SITE2_CLJK_URL = 'http://114.80.138.167:6385/cljk/index.html#/index/CarsMonitor';

// 人工登录最长等待（验证码 / 短信均人工处理）
const LOGIN_TIMEOUT = 600000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sanitize = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '-').trim();

// 时间字符串 URL 编码：空格 → %20，冒号保持原样（与站点路由格式一致）
const encodeTime = (t) => encodeURIComponent(String(t || '').trim()).replace(/%3A/g, ':');

class ExportFlow {
    /**
     * @param {object} opts
     * @param {function} opts.log        日志输出（发送到渲染进程）
     * @param {string}   opts.outputDir  输出根目录（导出表格存放于此）
     * @param {function} [opts.onProgress] 每条申诉进度回调 { index, total, ...result }
     */
    constructor({ log = console.log, outputDir, onProgress } = {}) {
        this.log = log;
        this.outputDir = outputDir;
        this.onProgress = onProgress;
        this.trackUrlCache = new Map(); // plate -> 轨迹回放路由 URL（同车牌复用，跳过查找）
    }

    // ==================== 对外入口 ====================
    async run() {
        try {
            await BrowserManager.launch(false);
            this.log('浏览器已启动');

            // ---- 第一步：网站1 采集“待处理”申诉 ----
            const page1 = await BrowserManager.newPage();
            let complaints = [];
            try {
                complaints = await this.collectComplaints(page1);
            } finally {
                await page1.close().catch(() => {});
            }

            if (!complaints.length) {
                this.log('没有找到“待处理”的申诉，任务结束');
                return { success: true, results: [] };
            }
            this.log(`共找到 ${complaints.length} 条待处理申诉，开始在 ${SITE2_NAME} 导出轨迹表格`);

            // ---- 第二步：网站2 逐条导出轨迹表格 ----
            const page2 = await BrowserManager.newPage();
            const results = [];
            try {
                await this.ensureSite2LoggedIn(page2);
                // 静默接管下载：站点点击“导出轨迹”后自身会触发 blob 下载，
                // 重定向到临时目录避免弹出保存对话框（真正保存走响应拦截）
                const silentDir = path.join(os.tmpdir(), 'alarm-automation-downloads');
                await this.enableSilentDownloads(page2, silentDir);

                for (let i = 0; i < complaints.length; i++) {
                    const c = complaints[i];
                    const item = { ...c, status: 'exporting', filePath: '', error: '' };
                    results.push(item);
                    this.emitProgress(i, complaints.length, item);
                    try {
                        const filePath = await this.exportTrack(page2, c);
                        item.status = 'exported';
                        item.filePath = filePath;
                        this.log(`[${i + 1}/${complaints.length}] ${c.plate} 导出成功: ${path.basename(filePath)}`);
                    } catch (e) {
                        item.status = 'failed';
                        item.error = e.message;
                        this.log(`[${i + 1}/${complaints.length}] ${c.plate} 导出失败: ${e.message}`);
                    }
                    this.emitProgress(i, complaints.length, item);
                }
            } finally {
                await page2.close().catch(() => {});
            }

            const okCount = results.filter(r => r.status === 'exported').length;
            this.log(`导出完成：成功 ${okCount}/${results.length}`);
            return { success: true, results };
        } finally {
            await BrowserManager.close();
        }
    }

    emitProgress(index, total, item) {
        if (this.onProgress) {
            try { this.onProgress({ index, total, ...item }); } catch (e) { /* 进度回调异常不阻塞流程 */ }
        }
    }

    // ==================== 网站1：报警申诉列表 ====================
    // 采集过程中若掉登录/切换账号：等待新账号登录成功后，丢弃已采集数据并从头重新采集
    async collectComplaints(page) {
        const MAX_RELOGIN = 5; // 最多重新登录次数，防止无限循环
        let reloginCount = 0;

        while (true) {
            // ---- 登录并进入申诉列表 ----
            await page.goto(SITE1_COMPLAINT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
            await sleep(2000);

            // 登录判定：URL 在 /login 或页面存在账号输入框
            const needLogin = await page.evaluate(() =>
                location.pathname.includes('/login') ||
                !!Array.from(document.querySelectorAll('input')).find(i =>
                    (i.placeholder || '').includes('账号') && i.offsetHeight > 0)
            ).catch(() => true);

            if (needLogin) {
                this.log(`请在弹出的浏览器窗口中手动完成 ${SITE1_NAME} 登录（含验证码），登录成功后自动继续...`);
                await page.waitForFunction(() => !location.pathname.includes('/login'), { timeout: LOGIN_TIMEOUT, polling: 1000 });
                this.log('登录成功，进入报警申诉列表');
                await page.goto(SITE1_COMPLAINT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
            } else {
                this.log(`检测到 ${SITE1_NAME} 已登录，直接读取报警申诉列表`);
            }

            // 等待表格渲染
            await page.waitForSelector('.el-table__body-wrapper table', { timeout: 60000 }).catch(() => {});
            await sleep(2000);

            // 尝试把每页条数调到 100，减少翻页次数（失败则按默认条数翻页）
            await this.trySetPageSize100(page);

            // ---- 分页采集 ----
            const { rows, loginLost } = await this.readAllComplaintPages(page);
            if (!loginLost) return rows;

            // 登录失效/切换账号：等待重新登录，然后丢弃数据、从头采集
            reloginCount++;
            if (reloginCount > MAX_RELOGIN) {
                throw new Error('申诉网站登录多次失效，已停止导出，请检查账号状态后重试');
            }
            this.log('检测到登录已失效（采集过程中可能切换了账号）');
            this.log('请在弹出的浏览器窗口中完成新账号登录，登录成功后将从第一页重新采集（已采集数据全部丢弃）...');
            await page.waitForFunction(() => !location.pathname.includes('/login'), { timeout: LOGIN_TIMEOUT, polling: 1000 });
            this.log('新账号登录成功，丢弃已采集数据，重新采集');
        }
    }

    // 分页读取申诉列表全部“待处理”数据；返回 { rows, loginLost }
    // loginLost=true 表示采集过程中被踢回登录页（rows 为空，由调用方重新采集）
    async readAllComplaintPages(page) {
        const all = [];
        const seen = new Set();
        let collected = 0;
        let pageNum = 1;
        while (true) {
            // 采集过程中检测登录失效（用户可能在采集期间退出登录/切换账号）
            if (page.url().includes('/login')) {
                return { rows: [], loginLost: true };
            }
            const { rows, total } = await page.evaluate(() => {
                // 表头列名 → 单元格下标映射（不依赖列顺序）
                const headers = Array.from(document.querySelectorAll('.el-table__header-wrapper th'))
                    .map(th => (th.innerText || '').trim().split('\n')[0]);
                const trs = Array.from(document.querySelectorAll('.el-table__body-wrapper tbody tr'));
                const rows = [];
                for (const tr of trs) {
                    const tds = Array.from(tr.querySelectorAll('td'));
                    const obj = {};
                    headers.forEach((h, i) => {
                        if (h && h !== '—') obj[h] = (tds[i] ? tds[i].innerText : '').trim();
                    });
                    // 状态列渲染为两行（如 “待处理\n等待企业申诉(进行中)”），取第一行
                    if (obj['申诉项状态']) obj['申诉项状态'] = obj['申诉项状态'].split('\n')[0].trim();
                    if (obj['车牌号'] || obj['车辆牌号']) rows.push(obj);
                }
                const totalEl = document.querySelector('.el-pagination__total');
                const m = totalEl ? (totalEl.textContent || '').match(/(\d+)/) : null;
                return { rows, total: m ? parseInt(m[1], 10) : rows.length };
            }).catch(() => ({ rows: [], total: 0 }));

            const pending = rows.filter(r => (r['申诉项状态'] || '').startsWith('待处理'));
            for (const r of pending) {
                const key = [r['监管工单号'], r['车牌号'] || r['车辆牌号'], r['开始时间'], r['结束时间']].join('|');
                if (seen.has(key)) continue;
                seen.add(key);
                all.push({
                    plate: (r['车牌号'] || r['车辆牌号'] || '').trim(),
                    startTime: (r['开始时间'] || '').trim(),
                    endTime: (r['结束时间'] || '').trim(),
                    orderNo: (r['监管工单号'] || '').trim()
                });
            }
            this.log(`第 ${pageNum} 页：${rows.length} 行，其中待处理 ${pending.length} 条（累计 ${all.length}）`);

            collected += rows.length;
            const hasNext = await page.evaluate(() => {
                const btn = document.querySelector('.el-pagination .btn-next');
                return !!(btn && !btn.disabled);
            }).catch(() => false);
            if (!hasNext || (total > 0 && collected >= total)) break;

            const clicked = await page.evaluate(() => {
                const btn = document.querySelector('.el-pagination .btn-next');
                if (btn && !btn.disabled) { btn.click(); return true; }
                return false;
            }).catch(() => false);
            if (!clicked) break;
            pageNum++;
            await sleep(2500); // 等待分页数据加载
        }

        // 过滤掉关键字段缺失的行
        const valid = all.filter(r => r.plate && /^\d{4}-\d{2}-\d{2}/.test(r.startTime));
        if (valid.length !== all.length) {
            this.log(`警告: ${all.length - valid.length} 条申诉缺少车牌号或时间，已跳过`);
        }
        return { rows: valid, loginLost: false };
    }

    // 将申诉列表每页条数调整为 100
    async trySetPageSize100(page) {
        try {
            const sel = await page.$('.el-pagination .el-select');
            if (!sel) return;
            await sel.click();
            await sleep(800);
            const clicked = await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('.el-select-dropdown__item'))
                    .filter(el => el.getBoundingClientRect().height > 0);
                const target = items.find(el => el.textContent.trim().startsWith('100'));
                if (target) { target.click(); return true; }
                return false;
            });
            if (clicked) {
                this.log('已将列表每页条数设置为 100');
                await sleep(2500);
            }
        } catch (e) { /* 调整失败不影响流程 */ }
    }

    // ==================== 网站2：登录 / 导出 ====================
    async ensureSite2LoggedIn(page) {
        await page.goto(SITE2_CLJK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await sleep(3000);
        const needLogin = await page.evaluate(() => {
            const pwd = document.querySelector('input[type="password"]');
            return !!(pwd && pwd.offsetHeight > 0);
        }).catch(() => true);

        if (!needLogin) {
            this.log(`检测到 ${SITE2_NAME} 已登录`);
            return;
        }
        this.log(`请在弹出的浏览器窗口中手动完成 ${SITE2_NAME} 登录（含验证码），登录成功后自动继续...`);
        await page.goto(SITE2_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        const deadline = Date.now() + LOGIN_TIMEOUT;
        while (Date.now() < deadline) {
            await sleep(2000);
            const state = await page.evaluate(() => {
                const pwd = document.querySelector('input[type="password"]');
                const pwdVisible = !!(pwd && pwd.offsetHeight > 0);
                const hasLogout = Array.from(document.querySelectorAll('button, span, a, li'))
                    .some(el => (el.textContent || '').trim().replace(/\s+/g, '') === '登出');
                return { pwdVisible, hasLogout, url: location.href };
            }).catch(() => ({ pwdVisible: true, hasLogout: false, url: '' }));
            if (!state.pwdVisible && !state.url.includes('login')) break;
        }
        this.log('登录完成，进入车辆监控页');
        await page.goto(SITE2_CLJK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await sleep(3000);
    }

    // 静默下载：站点的 blob 下载被重定向到指定目录，不再弹出保存对话框
    async enableSilentDownloads(page, downloadDir) {
        try {
            fs.ensureDirSync(downloadDir);
            const client = await page.createCDPSession();
            await client.send('Browser.setDownloadBehavior', {
                behavior: 'allowAndName',
                downloadPath: downloadDir,
                eventsEnabled: true
            });
        } catch (e) {
            this.log(`警告: 静默下载设置失败（${e.message}），如弹出保存框请手动确认`);
        }
    }

    // 导出单个申诉的轨迹表格，返回保存的文件路径
    async exportTrack(page, complaint) {
        const { plate, startTime, endTime } = complaint;
        if (!startTime || !endTime) throw new Error('缺少开始/结束时间');

        // attempt: 缓存路由优先；无缓存则走“搜索 → 车辆树 → 轨迹回放”完整流程
        const attempt = async () => {
            let trackUrl = this.trackUrlCache.get(plate);
            if (!trackUrl) {
                await this.openMonitorPage(page);
                await this.searchPlate(page, plate);
                const simId = await this.findTreeVehicle(page, plate);
                trackUrl = await this.enterTrackBack(page, plate);
                if (!trackUrl) {
                    if (!simId) throw new Error('车辆树中未找到该车牌（可能不属于当前账号）');
                    throw new Error('未能进入轨迹回放页面');
                }
                this.trackUrlCache.set(plate, trackUrl);
                this.log(`${plate} 已定位轨迹回放页面 (simId=${simId || '未知'})`);
            }
            // 用申诉的开始/结束时间改写路由 URL 并进入轨迹回放页（筛选条件自动带入）
            await this.gotoTrackBackWithTime(page, trackUrl, startTime, endTime);
            // 点击导出轨迹，拦截 replayExcel 响应字节直接落盘
            return await this.doExport(page, plate, startTime);
        };

        try {
            return await attempt();
        } catch (e) {
            // 缓存的路由可能因会话刷新失效：清缓存后完整流程重试一次
            if (this.trackUrlCache.has(plate)) {
                this.log(`${plate} 缓存路由失效（${e.message}），重新定位车辆`);
                this.trackUrlCache.delete(plate);
                return await attempt();
            }
            throw e;
        }
    }

    async openMonitorPage(page) {
        await page.goto(SITE2_CLJK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await page.waitForFunction(() => !!document.querySelector('input[placeholder="请输入"]'),
            { timeout: 60000, polling: 500 }).catch(() => {});
        await sleep(1000);
    }

    // 筛选条填入车牌并点击搜索
    async searchPlate(page, plate) {
        const inp = await page.$('input[placeholder="请输入"]');
        if (!inp) throw new Error('未找到车牌筛选输入框');
        await inp.click({ clickCount: 3 });
        await inp.type(plate, { delay: 60 });
        await sleep(500);
        await page.evaluate(() => {
            const icon = document.querySelector('i.el-icon-search');
            if (icon) icon.click();
        });
        await sleep(2000);
    }

    // 层层展开车辆树直到找到目标车牌节点，返回 simId（节点 class 中 veh<simId>）
    async findTreeVehicle(page, plate) {
        const deadline = Date.now() + 60000;
        let simId = null;
        while (Date.now() < deadline) {
            simId = await page.evaluate((p) => {
                const nodes = Array.from(document.querySelectorAll('.el-tree-node__content'));
                const node = nodes.find(n => {
                    const car = n.querySelector('.carTree');
                    // 节点文本形如 “沪EE2709【BD】”，按前缀匹配车牌
                    const label = car ? car.querySelector('span[title]') : null;
                    return label && label.textContent.trim().startsWith(p);
                });
                if (!node) return null;
                const car = node.querySelector('.carTree');
                const m = (car.className || '').match(/veh(\d+)/);
                return m ? m[1] : '';
            }, plate).catch(() => null);
            if (simId !== null) return simId;

            // 未找到：展开一层未展开的节点
            const clicked = await page.evaluate(() => {
                const icons = Array.from(document.querySelectorAll('.el-tree-node__expand-icon'))
                    .filter(i => i.className.includes('caret-right') && !i.className.includes('expanded'));
                icons.forEach(i => i.click());
                return icons.length;
            }).catch(() => 0);
            if (!clicked) break;
            await sleep(1500);
        }
        return null;
    }

    // 通过行内“轨迹回放”快捷图标进入轨迹回放页；失败回退：弹窗 → 轨迹回放标签 → 回放按钮
    // 返回捕获到的轨迹回放路由 URL
    async enterTrackBack(page, plate) {
        // 路径1：点击车辆节点行内的轨迹回放图标（最快路径）
        await page.evaluate((p) => {
            const nodes = Array.from(document.querySelectorAll('.el-tree-node__content'));
            const node = nodes.find(n => {
                const car = n.querySelector('.carTree');
                const label = car ? car.querySelector('span[title]') : null;
                return label && label.textContent.trim().startsWith(p);
            });
            if (!node) return false;
            const icon = node.querySelector('img[title="轨迹回放"]');
            if (icon) { icon.click(); return true; }
            return false;
        }, plate).catch(() => false);

        let trackUrl = await this.waitTrackUrl(page, 8000);
        if (trackUrl) return trackUrl;

        // 路径2：点击车牌 → 弹窗 → 轨迹回放标签 → 回放
        await page.evaluate((p) => {
            const nodes = Array.from(document.querySelectorAll('.el-tree-node__content'));
            const node = nodes.find(n => {
                const car = n.querySelector('.carTree');
                const label = car ? car.querySelector('span[title]') : null;
                return label && label.textContent.trim().startsWith(p);
            });
            const label = node ? node.querySelector('.carTree span[title]') : null;
            if (label) label.click();
        }, plate).catch(() => {});
        await sleep(2500);
        await page.evaluate(() => {
            const tabs = Array.from(document.querySelectorAll('.car-detail .navigation button'));
            const t = tabs.find(b => b.textContent.includes('轨迹回放'));
            if (t) t.click();
        }).catch(() => {});
        await sleep(1500);
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('.car-detail button'))
                .filter(b => b.offsetParent !== null && b.textContent.replace(/\s/g, '') === '回放');
            if (btns.length) btns[0].click();
        }).catch(() => {});
        return await this.waitTrackUrl(page, 20000);
    }

    // 等待页面路由切换到轨迹回放页，返回 URL
    async waitTrackUrl(page, timeout) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const u = page.url();
            if (u.includes('#/index/trackBack/')) return u;
            await sleep(500);
        }
        return null;
    }

    // 将轨迹回放路由中的时间替换为申诉时间后跳转（筛选条件由路由参数自动带入）
    async gotoTrackBackWithTime(page, trackUrl, startTime, endTime) {
        const m = trackUrl.match(/#\/index\/trackBack\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
        if (!m) throw new Error('轨迹回放路由格式异常');
        const plateAndQuery = m[4];
        const qi = plateAndQuery.indexOf('?');
        const platePart = qi >= 0 ? plateAndQuery.slice(0, qi) : plateAndQuery;
        const queryPart = qi >= 0 ? plateAndQuery.slice(qi) : '';
        const base = trackUrl.split('#')[0];
        const newUrl = `${base}#/index/trackBack/${m[1]}/${encodeTime(startTime)}/${encodeTime(endTime)}/${platePart}${queryPart}`;
        await page.goto(newUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        // 仅 hash 变化时 goto 不触发重载，强制刷新确保组件按新参数挂载
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

        // 校验页面时间输入框已带入申诉时间
        const startDay = String(startTime).slice(0, 10);
        const endDay = String(endTime).slice(0, 10);
        const ok = await page.waitForFunction((s, e) => {
            const ins = Array.from(document.querySelectorAll('input[placeholder="选择日期时间"]'))
                .filter(i => i.offsetParent !== null);
            if (ins.length < 2) return false;
            return ins[0].value.includes(s) && ins[1].value.includes(e);
        }, { timeout: 30000, polling: 500 }, startDay, endDay).catch(() => null);
        if (!ok) throw new Error('轨迹回放页时间带入校验失败');
    }

    // 点击导出轨迹，拦截 replayExcel 响应并保存为 xls 文件
    async doExport(page, plate, startTime) {
        // 等待导出按钮出现
        await page.waitForFunction(() => {
            const btns = Array.from(document.querySelectorAll('button'))
                .filter(b => b.offsetParent !== null && b.textContent.replace(/\s/g, '') === '导出轨迹');
            return btns.length > 0;
        }, { timeout: 30000, polling: 500 });

        const respPromise = page.waitForResponse(
            r => r.url().includes('replayExcel') && r.request().method() === 'POST',
            { timeout: 180000 }
        );
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'))
                .filter(b => b.offsetParent !== null && b.textContent.replace(/\s/g, '') === '导出轨迹');
            btns[0].click();
        });
        const resp = await respPromise;
        const contentType = (resp.headers()['content-type'] || '').toLowerCase();
        if (contentType.includes('application/json')) {
            // 接口返回 JSON 时一般是错误信息（如无轨迹数据）
            const text = await resp.text().catch(() => '');
            let msg = text;
            try { msg = JSON.parse(text).msg || text; } catch (e) { /* 保留原文 */ }
            throw new Error(`导出接口返回错误: ${msg.slice(0, 200)}`);
        }
        const buf = await resp.buffer();
        if (!buf || buf.length < 512) throw new Error(`导出内容异常（${buf ? buf.length : 0} 字节）`);

        // 保存到输出目录，文件名与站点下载保持一致：{车牌}_{开始日期}.xls，重名追加序号
        const exportDir = this.outputDir;
        fs.ensureDirSync(exportDir);
        const day = String(startTime).slice(0, 10).replace(/-/g, '_');
        let filePath = path.join(exportDir, `${sanitize(plate)}_${day}.xls`);
        let n = 1;
        while (fs.existsSync(filePath)) {
            filePath = path.join(exportDir, `${sanitize(plate)}_${day}(${n++}).xls`);
        }
        await fs.writeFile(filePath, buf);
        return filePath;
    }
}

module.exports = ExportFlow;
