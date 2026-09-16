const BrowserManager = require('./browser-manager');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { app } = require('electron');

// ==================== 网站地址 ====================
// 网站1：道路运输车辆运营监测分析应用（报警申诉列表）
const SITE1_NAME = '道路运输车辆运营监测分析应用';
const SITE1_COMPLAINT_URL = 'http://183.192.65.93:8807/gps/complaint';
// 网站2：中安GPS/BD运输车辆监控平台（门户 + 车辆监控 iframe）
const SITE2_NAME = '运输车辆监控平台';
const SITE2_LOGIN_URL = 'http://114.80.138.167:6385/index.html';

// 人工登录最长等待（验证码 / 短信均人工处理）
const LOGIN_TIMEOUT = 600000;

// 调试开关：true = 跳过网站1采集，直接使用下面的模拟数据测试网站2导出流程（正式流程必须为 false）
const USE_MOCK_COMPLAINTS = false;
const MOCK_COMPLAINTS = [
    { plate: '沪GB7688', startTime: '2026-09-14 12:13:24', endTime: '2026-09-14 17:37:24', orderNo: '22166819' },
    { plate: '沪FB1527', startTime: '2026-09-14 16:16:00', endTime: '2026-09-15 00:33:49', orderNo: '22166748' },
    { plate: '沪GQ6585', startTime: '2026-09-14 18:30:13', endTime: '2026-09-14 23:11:03', orderNo: '22166705' },
    { plate: '沪GQ6585', startTime: '2026-09-14 00:56:27', endTime: '2026-09-14 06:03:09', orderNo: '22166732' },
    { plate: '沪FB1527', startTime: '2026-09-14 07:05:30', endTime: '2026-09-14 15:47:26', orderNo: '22166700' }
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sanitize = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '-').trim();

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
    }

    // ==================== 对外入口 ====================
    async run() {
        try {
            await BrowserManager.launch(false);
            this.log('浏览器已启动');

            // ---- 第一步：网站1 采集“待处理”申诉（调试模式跳过）----
            let complaints = [];
            if (USE_MOCK_COMPLAINTS) {
                complaints = MOCK_COMPLAINTS.map(c => ({ ...c }));
                this.log(`【调试模式】跳过网站1，使用 ${complaints.length} 条模拟申诉数据`);
            } else {
                const page1 = await BrowserManager.newPage();
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
            }

            // ---- 第二步：网站2 逐条导出轨迹表格（门户 + iframe 内接口调用）----
            const page2 = await BrowserManager.newPage();
            const results = [];
            try {
                let frame = await this.ensureSite2LoggedIn(page2);

                // 页面级异常（车辆树未加载/会话失效等）连续出现时：
                // 重新走门户链路恢复后重试当前条；连续 2 条异常则中止整批
                let pageFailures = 0;
                let aborted = false;
                for (let i = 0; i < complaints.length; i++) {
                    const c = complaints[i];
                    const item = { ...c, status: 'exporting', filePath: '', error: '' };
                    results.push(item);
                    this.emitProgress(i, complaints.length, item);
                    try {
                        const filePath = await this.exportTrack(page2, frame, c);
                        item.status = 'exported';
                        item.filePath = filePath;
                        pageFailures = 0;
                        this.log(`[${i + 1}/${complaints.length}] ${c.plate} 导出成功: ${path.basename(filePath)}`);
                    } catch (e) {
                        const msg = e.message || '';
                        if (msg.includes('车辆树未加载') || msg.includes('会话') || msg.includes('车辆监控')) {
                            pageFailures++;
                            if (pageFailures >= 2) {
                                this.log(`[${i + 1}/${complaints.length}] ${c.plate} 导出失败: ${msg}`);
                                this.log('车辆监控页连续异常，中止本次导出（已导出的结果保留）。请确认平台可正常访问后重新点击“开始导出”');
                                aborted = true;
                                break;
                            }
                            this.log(`[${i + 1}/${complaints.length}] ${c.plate} 页面异常，强制重新登录后重试该条...`);
                            try {
                                frame = await this.ensureSite2LoggedIn(page2, { forceRelogin: true });
                                const filePath = await this.exportTrack(page2, frame, c);
                                item.status = 'exported';
                                item.filePath = filePath;
                                pageFailures = 0;
                                this.log(`[${i + 1}/${complaints.length}] ${c.plate} 重试导出成功: ${path.basename(filePath)}`);
                                this.emitProgress(i, complaints.length, item);
                                continue;
                            } catch (e2) {
                                item.status = 'failed';
                                item.error = e2.message;
                                this.log(`[${i + 1}/${complaints.length}] ${c.plate} 重试仍失败: ${e2.message}`);
                                this.emitProgress(i, complaints.length, item);
                                continue;
                            }
                        }
                        item.status = 'failed';
                        item.error = msg;
                        this.log(`[${i + 1}/${complaints.length}] ${c.plate} 导出失败: ${msg}`);
                    }
                    this.emitProgress(i, complaints.length, item);
                }

                const okCount2 = results.filter(r => r.status === 'exported').length;
                if (aborted) {
                    this.log(`导出中止：成功 ${okCount2}/${results.length}`);
                    return { success: true, results, aborted: true };
                }
            } finally {
                await page2.close().catch(() => {});
            }

            const okCount = results.filter(r => r.status === 'exported').length;
            this.log(`导出完成：成功 ${okCount}/${results.length}`);
            return { success: true, results };
        } finally {
            // 浏览器保持运行（不关闭），登录态跨次运行保留；应用退出时统一关闭
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

    // ==================== 网站2：门户 + iframe 接口调用 ====================
    // 确保车辆监控 iframe 真正可用（已登录且车辆树加载出真实数据）。
    // 实测结论（重要）：
    // 1. cljk 页面的会话上下文由门户登录建立 —— 不经过门户直接打开 cljk 会渲染空壳树
    //    （节点仅 “(0/0)”）且不会自愈，严重时页面提示“系统错误，请联系管理员”，
    //    因此必须走正常链路：门户(index.html) 登录 → 点《车辆监控》菜单 → cljk iframe
    // 2. 车辆树接口可能延迟数十秒，必须等“带企业名称的真实节点”出现（空壳节点仅 “(0/0)”）
    // 返回 cljk 的 Frame 句柄（后续接口调用都在该 iframe 上下文内执行）
    // forceRelogin=true：先点击“登出”清掉当前（可能已损坏的）会话，强制人工重新登录
    async ensureSite2LoggedIn(page, { forceRelogin = false } = {}) {
        const MAX_ATTEMPTS = 3;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            // ---- 第一步：门户登录（cljk 的会话上下文由门户建立）----
            await page.goto(SITE2_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
            await sleep(2000);
            if (forceRelogin) {
                // 会话可能已损坏：主动登出，确保下面的等待是真正的新登录
                page.once('dialog', d => d.accept().catch(() => {})); // 登出若有确认框自动接受
                await page.evaluate(() => {
                    const els = Array.from(document.querySelectorAll('button, span, a, li'))
                        .filter(el => (el.textContent || '').trim().replace(/\s+/g, '') === '登出');
                    els.forEach(el => el.click());
                }).catch(() => {});
                await sleep(2500);
            }
            const portalNeedLogin = await page.evaluate(() => {
                const pwd = document.querySelector('input[type="password"]');
                return !!(pwd && pwd.offsetHeight > 0);
            }).catch(() => true);

            if (portalNeedLogin) {
                this.log('请在弹出的浏览器窗口中完成登录（已自动填入记住的账号密码，只需输入验证码后点击登录）...');
                // 自动填入门户“记住我”保存的账号密码（只填空字段，不覆盖用户输入）
                await page.evaluate(() => {
                    let saved = null;
                    try { saved = JSON.parse(localStorage.getItem('loginUser') || 'null'); } catch (e) { return; }
                    if (!saved || !saved.userName) return;
                    const vis = (el) => el && el.offsetHeight > 0;
                    const setVal = (el, v) => {
                        if (!el) return;
                        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                    };
                    const user = Array.from(document.querySelectorAll('input[type="text"]')).find(vis);
                    const pwd = Array.from(document.querySelectorAll('input[type="password"]')).find(vis);
                    if (user && !user.value) setVal(user, saved.userName);
                    if (pwd && !pwd.value) setVal(pwd, saved.passWord || '');
                }).catch(() => {});
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
                this.log('登录完成');
            } else {
                this.log(`检测到 ${SITE2_NAME} 门户会话有效`);
            }

            // ---- 第二步：点击《车辆监控》菜单，打开 cljk iframe（正常链路）----
            // 注意：必须点击菜单里的 <a> 链接（点 LI 外层元素不会触发打开标签页）
            const clicked = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'))
                    .filter(el => (el.textContent || '').trim() === '车辆监控' && el.offsetHeight > 0);
                if (links.length) { links[0].click(); return true; }
                return false;
            }).catch(() => false);
            if (!clicked) {
                this.log(`未在门户中找到《车辆监控》菜单`);
            }
            let frame = null;
            try {
                await page.waitForSelector('iframe[src*="cljk"]', { timeout: 30000 });
                frame = page.frames().find(f => f.url().includes('/cljk/'));
            } catch (e) { /* iframe 未出现，走重试 */ }

            // ---- 第三步：iframe 内等车辆树数据就绪（会话健康校验）----
            if (frame && await this.waitTreeLoaded(frame, 45000)) {
                // 关闭登录后可能弹出的“消息中心”等对话框（会遮挡菜单/标签栏）
                await this.closePortalDialogs(page);
                // 静默接管下载：导出轨迹会触发 blob 下载，重定向到临时目录避免保存弹窗
                await this.enableSilentDownloads(page, path.join(os.tmpdir(), 'alarm-automation-downloads'));
                this.log('车辆监控页数据加载正常');
                return frame;
            }
            this.log(`车辆监控页数据未加载（可能显示“系统错误”或会话过期），重试（${attempt}/${MAX_ATTEMPTS}）...`);
        }
        throw new Error('车辆监控页连续 3 次未能加载数据（页面提示“系统错误”或会话过期）。请先用普通浏览器确认该平台能正常查看车辆监控后，再重新点击“开始导出”');
    }

    // 等待车辆树加载出真实数据：至少 1 个节点，且根节点带名称（异常/未加载时的空壳节点仅有 “(0/0)”）
    async waitTreeLoaded(context, timeout) {
        return await context.waitForFunction(() => {
            const tree = document.querySelector('.el-tree');
            if (!tree) return false;
            const nodes = tree.querySelectorAll('.el-tree-node');
            if (nodes.length === 0) return false;
            const first = (nodes[0].textContent || '').trim();
            // 去掉尾部在线/总数标记后应剩下企业名称
            const name = first.replace(/\(\d+\/\d+\)\s*$/, '').trim();
            return name.length > 0;
        }, { timeout, polling: 1000 }).then(() => true).catch(() => false);
    }

    // ==================== 导出（正常链路：iframe 内页面操作 + 响应拦截） ====================
    // 导出单个申诉的轨迹表格，返回保存的文件路径。
    // 流程（全部在 cljk iframe 内、与真实用户操作一致）：
    //   搜索车牌 → 拦截 searchByVehOrCorp 响应拿车辆ID
    //   → 路由跳转轨迹回放页（时间随 URL 自动带入）
    //   → 点“导出轨迹” → 拦截 replayExcel 响应拿 xls 字节流 → 落盘
    async exportTrack(page, frame, complaint) {
        const { plate, startTime, endTime } = complaint;
        if (!startTime || !endTime) throw new Error('缺少开始/结束时间');

        // 0. 确保 iframe 处于车辆监控路由且车辆树数据就绪（上一条导出后可能停在轨迹回放路由）
        await this.ensureCarsMonitorRoute(frame);

        // 1. 页面搜索拿车辆ID / vehType / deviceType
        const veh = await this.uiSearchVehicle(page, frame, plate);

        // 2. 跳轨迹回放页 → 点导出轨迹 → 拦截响应
        const buf = await this.uiExportFallback(page, frame, veh, startTime, endTime);

        // 3. 落盘到程序内部目录（不出现在输出根目录；处理成功后归档到车牌文件夹，“下载表格”可另存）
        const exportDir = path.join(app.getPath('userData'), 'exported_tables');
        fs.ensureDirSync(exportDir);
        const day = String(startTime).slice(0, 10).replace(/-/g, '_');
        let filePath = path.join(exportDir, `${sanitize(veh.veh_code || plate)}_${day}.xls`);
        let n = 1;
        while (fs.existsSync(filePath)) {
            filePath = path.join(exportDir, `${sanitize(veh.veh_code || plate)}_${day}(${n++}).xls`);
        }
        await fs.writeFile(filePath, buf);
        return filePath;
    }

    // 确保 iframe 回到车辆监控路由且车辆树数据就绪
    async ensureCarsMonitorRoute(frame) {
        const onMonitor = await frame.evaluate(() => location.hash.includes('CarsMonitor')).catch(() => false);
        if (onMonitor && await this.waitTreeLoaded(frame, 5000)) return;
        await frame.evaluate(() => { window.location.hash = '#/index/CarsMonitor'; }).catch(() => {});
        if (!(await this.waitTreeLoaded(frame, 30000))) {
            throw new Error('车辆树未加载（页面可能异常或会话已失效），请重试');
        }
    }

    // 关闭门户登录后弹出的对话框（消息中心等）
    async closePortalDialogs(page) {
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('.el-dialog__headerbtn'))
                .filter(b => b.offsetParent !== null);
            btns.forEach(b => b.click());
        }).catch(() => {});
        await sleep(500);
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

    // 页面搜索回退：在 iframe 内以页面自身方式搜索（与应用发起的请求完全一致），捕获响应拿车辆信息。
    // 填值用原生 setter + input 事件（Vue v-model 可识别），点击直接派发（不依赖元素可点击性）
    async uiSearchVehicle(page, frame, plate) {
        const respPromise = page.waitForResponse(r => r.url().includes('searchByVehOrCorp'), { timeout: 30000 });
        await frame.evaluate((plate) => {
            const inp = document.querySelector('input[placeholder="请输入"]');
            if (!inp) throw new Error('未找到车牌筛选输入框');
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(inp, plate);
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            const icon = document.querySelector('i.el-icon-search');
            if (icon) icon.click();
        }, plate).catch(e => { throw new Error('页面搜索操作失败: ' + e.message); });
        const resp = await respPromise;
        // 记录应用真实请求头（诊断直调失败差异用）
        const headers = resp.request().headers();
        this.log(`[诊断] 页面搜索请求头: ${JSON.stringify({ token: headers.token, Authorization: headers.Authorization, crossDomain: headers.crossDomain, withCredentials: headers.withCredentials })}`);
        const j = await resp.json().catch(() => null);
        const list = (j && j.data) || [];
        const v = list.find(x => x.veh_code === plate) ||
                  list.find(x => (x.veh_code || '').startsWith(plate));
        if (!v) throw new Error(`页面搜索未找到该车牌（响应: ${j ? (j.msg || j.code) : '无数据'}）`);
        return { ok: true, found: true, id: v.id, vehType: v.vehType, deviceType: v.deviceType, veh_code: v.veh_code };
    }

    // 导出回退：iframe 内路由跳转到轨迹回放页（时间自动带入）→ 点“导出轨迹” → 拦截响应
    async uiExportFallback(page, frame, veh, startTime, endTime) {
        const enc = (t) => encodeURIComponent(String(t || '').trim()).replace(/%3A/g, ':');
        const hash = '#/index/trackBack/' + veh.id + '/' + enc(startTime) + '/' + enc(endTime) + '/' +
            encodeURIComponent(veh.veh_code || '') + '?vehType=' + veh.vehType + '&deviceType=' + veh.deviceType;
        await frame.evaluate((h) => { window.location.hash = h; }, hash);
        // 等待时间输入框带入申诉时间（页面就绪标志）
        const startDay = String(startTime).slice(0, 10);
        const endDay = String(endTime).slice(0, 10);
        await frame.waitForFunction((s, e) => {
            const ins = Array.from(document.querySelectorAll('input[placeholder="选择日期时间"]'))
                .filter(i => i.offsetParent !== null);
            if (ins.length < 2) return false;
            return ins[0].value.includes(s) && ins[1].value.includes(e);
        }, { timeout: 45000, polling: 500 }, startDay, endDay);

        const respPromise = page.waitForResponse(
            r => r.url().includes('replayExcel') && r.request().method() === 'POST',
            { timeout: 180000 }
        );
        await frame.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'))
                .filter(b => b.offsetParent !== null && b.textContent.replace(/\s/g, '') === '导出轨迹');
            btns[0].click();
        });
        const resp = await respPromise;
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        if (ct.includes('application/json')) {
            const text = await resp.text().catch(() => '');
            let msg = text;
            try { msg = JSON.parse(text).msg || msg; } catch (e) { /* 保留原文 */ }
            throw new Error(`导出接口返回错误: ${msg.slice(0, 200)}`);
        }
        const buf = await resp.buffer();
        if (!buf || buf.length < 512) throw new Error(`导出内容异常（${buf ? buf.length : 0} 字节）`);
        return buf;
    }
}

module.exports = ExportFlow;
