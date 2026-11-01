// 处理监控报表：导入 GPS 监控日报表 -> 逐车进入车辆监控 -> 读取车辆信息 -> 回填到表格
const XLSX = require('xlsx');
const path = require('path');
const browserManager = require('./browser-manager');

// 运输车辆监控平台
const PLATFORM_URL = 'http://114.80.138.167:6385/index.html';

// 报表必须包含的表头
const REQUIRED_HEADERS = ['车辆牌号'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/[-\s]/g, '');

function cellText(ws, r, c) {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    return cell ? String(XLSX.utils.format_cell(cell)).trim() : '';
}

// 解析报表：定位表头行与列，读取“车辆牌号”非空的数据行
function readMonitorReport(filePath) {
    const wb = XLSX.readFile(filePath, { cellStyles: true });
    for (const sheetName of wb.SheetNames) {
        const ws = wb.Sheets[sheetName];
        if (!ws || !ws['!ref']) continue;
        const range = XLSX.utils.decode_range(ws['!ref']);
        for (let r = range.s.r; r <= range.e.r; r++) {
            const columns = {};
            for (let c = range.s.c; c <= range.e.c; c++) {
                const t = cellText(ws, r, c).replace(/\s+/g, '');
                if (t) columns[t] = c;
            }
            if (columns['车辆牌号'] === undefined) continue;
            if (!REQUIRED_HEADERS.every(k => columns[k] !== undefined)) continue;

            const rows = [];
            for (let rr = r + 1; rr <= range.e.r; rr++) {
                const plate = cellText(ws, rr, columns['车辆牌号']).replace(/\s+/g, '');
                if (!plate) continue;
                rows.push({
                    rowIndex: rr,
                    plate,
                    line: columns['线路'] !== undefined ? cellText(ws, rr, columns['线路']) : ''
                });
            }
            return { filePath, sheetName, headerRow: r, columns, rows };
        }
    }
    throw new Error('未找到监控报表表头，表格需包含：' + REQUIRED_HEADERS.join('、'));
}

// 输出文件：原目录下生成“原文件名_已处理.扩展名”
function outputPathFor(filePath) {
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    return path.join(path.dirname(filePath), `${base}_已处理${ext}`);
}

// 将车辆信息回填到报表：
// 速度 -> 【速度】列（只填数字）；状态 -> 【车辆状态】列（在线行驶=营，否则=停）；
// 通讯时间 -> 【监控时段】列（时:分）；位置 -> 【车辆地理位置】列（列名容错，没有则忽略）
function fillVehicleInfo(wb, parsed, rowIndexes, info) {
    const ws = wb.Sheets[parsed.sheetName];
    if (!ws || !info) return [];
    // 列名容错查找：先精确匹配，再按关键字模糊匹配（如“车辆地里位置”/“车辆位置”）
    const findCol = (exact, subs) => {
        for (const n of exact) {
            if (parsed.columns[n] !== undefined) return parsed.columns[n];
        }
        for (const key of Object.keys(parsed.columns)) {
            if (subs.some(s => key.includes(s))) return parsed.columns[key];
        }
        return undefined;
    };
    const cols = {
        speed: findCol(['速度'], ['速度', '车速']),
        status: findCol(['车辆状态'], ['状态']),
        time: findCol(['监控时段'], ['时段']),
        position: findCol(['车辆地理位置', '车辆地里位置', '车辆位置', '地理位置', '地里位置'], ['位置'])
    };

    // 营/停规则：离线为停；在线且行驶（状态含“行驶”或速度>0）为营，其余（在线停车/熄火等）为停
    const statusText = String(info.status || '');
    const speedNum = parseFloat(info.speed || '0') || 0;
    const ying = !/离线/.test(statusText) &&
        (/行驶/.test(statusText) || (/在线/.test(statusText) && speedNum > 0));
    const statusValue = ying ? '营' : '停';

    const pending = [
        { name: '速度', c: cols.speed, v: info.speed ? String(parseFloat(info.speed)) : '' },
        { name: '车辆状态', c: cols.status, v: statusText ? statusValue : '' },
        { name: '监控时段', c: cols.time, v: info.commTime || '' },
        { name: '车辆地理位置', c: cols.position, v: String(info.position || '').slice(0, 120) }
    ];
    const filled = [];
    for (const item of pending) {
        if (item.c === undefined || !item.v) continue;
        for (const r of rowIndexes) {
            const addr = XLSX.utils.encode_cell({ r, c: item.c });
            const old = ws[addr] || {};
            ws[addr] = { ...old, t: 's', v: item.v };
        }
        filled.push(`${item.name}=${item.v.length > 20 ? item.v.slice(0, 20) + '…' : item.v}`);
    }
    return filled;
}

class MonitorReportFlow {
    constructor({ log = console.log, onProgress = () => {} } = {}) {
        this.log = log;
        this.onProgress = onProgress;
    }

    // 打开平台并确保已登录，然后进入车辆监控页
    async openPlatform() {
        await browserManager.launch(false);
        const page = await browserManager.newPage();
        await page.goto(PLATFORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await sleep(3000);
        await this.ensureLoggedIn(page);
        await this.enterMonitor(page);
        return page;
    }

    async ensureLoggedIn(page) {
        const isLoggedIn = () => page.evaluate(() => {
            const t = document.body.innerText || '';
            return /登\s*出/.test(t) || !!document.querySelector('span.user');
        }).catch(() => false);

        if (await isLoggedIn()) return;
        this.log('未检测到平台登录状态，请在弹出的浏览器窗口中手动登录（登录成功后自动继续）...');
        const deadline = Date.now() + 10 * 60 * 1000;
        let lastTip = Date.now();
        while (Date.now() < deadline) {
            await sleep(2000);
            if (await isLoggedIn()) {
                this.log('检测到已登录，继续');
                await sleep(3000);
                return;
            }
            if (Date.now() - lastTip > 60000) {
                lastTip = Date.now();
                this.log('仍在等待登录...');
            }
        }
        throw new Error('等待平台登录超时（10 分钟）');
    }

    // 点击顶部“车辆监控”标签，等待车辆监控 iframe 可见
    async enterMonitor(page) {
        const clickTab = async () => {
            for (const frame of page.frames()) {
                try {
                    const ok = await frame.evaluate(() => {
                        const els = Array.from(document.querySelectorAll('.tabs-title, span, a, li'))
                            .filter(e => (e.innerText || '').trim().replace(/\s+/g, '') === '车辆监控');
                        if (!els.length) return false;
                        const el = els.find(e => String(e.className).includes('tabs-title')) || els[0];
                        el.click();
                        return true;
                    });
                    if (ok) return true;
                } catch (e) { /* frame 可能已失效 */ }
            }
            return false;
        };

        let frame = null;
        for (let attempt = 0; attempt < 3 && !frame; attempt++) {
            await clickTab();
            for (let i = 0; i < 20; i++) {
                await sleep(1000);
                const f = page.frames().find(x => x.url().includes('/cljk/index.html'));
                if (!f) continue;
                try {
                    const el = await f.frameElement();
                    const box = el ? await el.boundingBox() : null;
                    if (box && box.width > 100 && box.height > 100) { frame = f; break; }
                } catch (e) { /* ignore */ }
            }
        }
        if (!frame) throw new Error('无法进入车辆监控页面');
        await sleep(3000);
        return frame;
    }

    // 当前可见的车辆监控 frame
    async getMonitorFrame(page) {
        const f = page.frames().find(x => x.url().includes('/cljk/index.html'));
        if (!f) return await this.enterMonitor(page);
        try {
            const el = await f.frameElement();
            const box = el ? await el.boundingBox() : null;
            if (box && box.width > 100 && box.height > 100) return f;
        } catch (e) { /* ignore */ }
        return await this.enterMonitor(page);
    }

    // 左侧车牌筛选 -> 点击搜索结果框里的车牌
    async searchAndSelect(frame, plate) {
        const searched = await frame.evaluate((p) => {
            const box = Array.from(document.querySelectorAll('.search_box'))
                .find(b => b.getBoundingClientRect().width > 10);
            if (!box) return 'no-search-box';
            const input = box.querySelector('input[placeholder="请输入"]');
            if (!input) return 'no-input';
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(input, p);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            const icon = box.querySelector('.el-icon-search');
            if (icon) icon.click();
            return 'ok';
        }, plate);
        if (searched !== 'ok') return { status: 'failed', detail: `车牌搜索失败(${searched})` };

        for (let i = 0; i < 15; i++) {
            const clicked = await frame.evaluate((p) => {
                const target = String(p).replace(/[-\s]/g, '');
                const items = Array.from(document.querySelectorAll('.car-tree .el-card .text.item'))
                    .filter(e => e.getBoundingClientRect().width > 10 &&
                        String(e.innerText || '').replace(/[-\s]/g, '').includes(target));
                if (!items.length) return false;
                items[0].click();
                return true;
            }, plate);
            if (clicked) {
                // 等待右侧车辆详情弹窗出现，并等车辆状态加载完成（状态文字为空时继续等）
                let statusText = '';
                for (let k = 0; k < 30; k++) {
                    const state = await this.readDetailState(frame);
                    statusText = state.statusText;
                    // 弹窗里的车牌也要匹配，避免读到上一辆车残留的状态
                    const plateOk = !state.detailPlate || norm(state.detailPlate) === norm(plate);
                    if (state.visible && plateOk && statusText) break;
                    await sleep(500);
                }
                return { status: 'selected', statusText };
            }
            await sleep(1000);
        }
        return { status: 'notfound', detail: '车辆列表中未找到该车牌' };
    }

    // 读取右侧车辆详情弹窗：车牌号与车辆状态
    async readDetailState(frame) {
        return await frame.evaluate(() => {
            const visible = (e) => {
                const r = e.getBoundingClientRect();
                return r.width > 2 && r.height > 2;
            };
            const detail = Array.from(document.querySelectorAll('.car-detail')).find(visible);
            const text = detail ? String(detail.innerText || '') : '';
            const plateM = text.match(/车\s*牌\s*号\s*[:：]\s*([^\s]+)/);
            // 优先匹配车辆信息块里的“状态”，避免读到其他区块里残留的“离线”
            const statusM = text.match(/车\s*牌\s*号\s*[:：][\s\S]{0,120}?状\s*态\s*[:：]\s*([^\s]+)/)
                || text.match(/状\s*态\s*[:：]\s*([^\s]+)/);
            return {
                visible: !!detail,
                detailPlate: plateM ? plateM[1] : '',
                statusText: statusM ? statusM[1] : ''
            };
        }).catch(() => ({ visible: false, detailPlate: '', statusText: '' }));
    }

    // 读取弹窗第一个Tab【车辆信息】：速度、状态、通讯时间、位置
    // 弹窗默认展示车辆信息Tab；轮询等待内容加载完成（车牌匹配且字段已出现）
    async readVehicleInfo(frame, plate) {
        let last = null;
        for (let i = 0; i < 10; i++) {
            const info = await frame.evaluate(() => {
                const visible = (e) => {
                    const r = e.getBoundingClientRect();
                    return r.width > 2 && r.height > 2;
                };
                const detail = Array.from(document.querySelectorAll('.car-detail')).find(visible);
                if (!detail) return null;
                const text = String(detail.innerText || '');
                if (!text) return null;

                const plateM = text.match(/车\s*牌\s*号\s*[:：]\s*([^\s]+)/);
                // 速度：如“速度：77公里/小时”，只取数字
                const speedM = text.match(/速\s*度\s*[:：]\s*(\d+(?:\.\d+)?)\s*(?:公\s*里|km|KM)?/);
                const statusM = text.match(/车\s*牌\s*号\s*[:：][\s\S]{0,150}?状\s*态\s*[:：]\s*([^\s]+)/)
                    || text.match(/状\s*态\s*[:：]\s*([^\s]+)/);
                // 通讯时间：如“2026-10-27 10:32:56”，只取时:分
                const timeM = text.match(/通讯时间\s*[:：]\s*([^\n\r]{1,40})/);
                const commTime = timeM ? ((timeM[1].match(/(\d{1,2}:\d{2})/) || [])[1] || '') : '';
                // 位置较长时会折行，合并后续不以“标签：”开头的行，遇到下一个字段标签为止
                const posM = text.match(/位\s*置\s*[:：]\s*[^\n\r]+(?:\r?\n\s*(?![\u4e00-\u9fa5A-Za-z]{1,8}\s*[:：])[^\n\r]+)*/);
                const position = posM ? posM[0].replace(/^[^:：]*[:：]\s*/, '').replace(/\s*\r?\n\s*/g, '').trim() : '';
                return {
                    plate: plateM ? plateM[1] : '',
                    speed: speedM ? speedM[1] : '',
                    status: statusM ? statusM[1] : '',
                    commTime,
                    position
                };
            }).catch(() => null);
            if (info) {
                // 弹窗车牌必须匹配当前车，避免读到上一辆车残留信息
                const plateOk = !info.plate || !plate || norm(info.plate) === norm(plate);
                if (plateOk) {
                    last = info;
                    if (info.speed || info.commTime || info.status) return info;
                }
            }
            await sleep(500);
        }
        return last;
    }

    // 处理单个车牌：搜索 -> 选中 -> 读取车辆信息
    async processPlate(page, plate) {
        const frame = await this.getMonitorFrame(page);

        const selected = await this.searchAndSelect(frame, plate);
        if (selected.status !== 'selected') return selected;

        // 弹窗默认展示第一个Tab【车辆信息】，读取速度/状态/通讯时间/位置用于回填
        const info = await this.readVehicleInfo(frame, plate);
        if (!info) return { status: 'failed', detail: '未读取到车辆信息' };

        const brief = `速度${info.speed || '未知'}，状态${info.status || '未知'}，通讯时间${info.commTime || '未知'}`;
        this.log(`  车辆信息：${brief}${info.position ? `，位置：${info.position.slice(0, 30)}` : ''}`);
        return { status: 'done', detail: '已回填车辆信息', info };
    }

    async run(filePath) {
        const parsed = readMonitorReport(filePath);
        if (!parsed.rows.length) throw new Error('报表中没有可处理的车辆（车辆牌号列为空）');
        this.log(`读取到 ${parsed.rows.length} 行车辆数据（工作表：${parsed.sheetName}）`);

        const wb = XLSX.readFile(filePath, { cellStyles: true });
        const page = await this.openPlatform();

        try {
            // 同一车牌可能出现在多行，只查询一次，结果写到所有对应行
            const groups = new Map();
            for (const row of parsed.rows) {
                const key = norm(row.plate);
                if (!groups.has(key)) groups.set(key, { plate: row.plate, rows: [] });
                groups.get(key).rows.push(row);
            }

            let index = 0;
            for (const group of groups.values()) {
                index++;
                const rowIndexes = group.rows.map(r => r.rowIndex);
                this.log(`[${index}/${groups.size}] 车牌 ${group.plate}`);
                this.onProgress({ rowIndexes, status: 'processing', detail: '处理中' });

                let result;
                try {
                    result = await this.processPlate(page, group.plate);
                } catch (e) {
                    this.log(`  处理失败：${e.message}`);
                    result = { status: 'failed', detail: e.message };
                }

                if (result.status === 'done') {
                    this.log('  已读取车辆信息');
                } else if (result.status === 'notfound') {
                    this.log('  车辆列表中未找到该车牌，跳过');
                } else {
                    this.log(`  处理失败：${result.detail || '未知错误'}`);
                }

                // 回填车辆信息（速度/车辆状态/监控时段/车辆地理位置）
                if (result.info) {
                    const filled = fillVehicleInfo(wb, parsed, rowIndexes, result.info);
                    if (filled.length) this.log(`  已回填车辆信息：${filled.join('，')}`);
                }

                this.onProgress({
                    rowIndexes,
                    status: result.status,
                    detail: result.detail || ''
                });
            }

            const outputPath = outputPathFor(filePath);
            XLSX.writeFile(wb, outputPath);
            this.log(`处理完成，结果已保存：${outputPath}`);
            return { success: true, outputPath, outputDir: path.dirname(outputPath), total: parsed.rows.length };
        } finally {
            try { await page.close(); } catch (e) { /* ignore */ }
        }
    }
}

module.exports = { readMonitorReport, outputPathFor, MonitorReportFlow, fillVehicleInfo };
