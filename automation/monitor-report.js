// 处理监控报表：导入 GPS 监控日报表 -> 逐车进入车辆监控视频点播 -> 判断各通道是否黑屏 -> 在对应列打勾
const XLSX = require('xlsx');
const fs = require('fs-extra');
const path = require('path');
const sharp = require('sharp');
const browserManager = require('./browser-manager');

// 运输车辆监控平台
const PLATFORM_URL = 'http://114.80.138.167:6385/index.html';

// 平台通道名 -> 报表列名
// ADAS 朝车头前方 -> 前方位；DSM 驾驶员监控 -> 驾驶座；
// 通道 车厢过道 -> 前车厢；前门 上车门 -> 上客门。左/右行李箱不参与填表。
const CHANNEL_COLUMN = {
    'ADAS': '前方位',
    'DSM': '驾驶座',
    '通道': '前车厢',
    '前门': '上客门'
};

// 报表必须包含的表头
const REQUIRED_HEADERS = ['车辆牌号', '前方位', '驾驶座', '前车厢', '上客门'];

// 等待通道出流的最长时间（实测部分通道需要约 50 秒才出画面）
const VIDEO_READY_TIMEOUT = 60000;

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

// 在指定行的对应列写入 √
function markBlackChannels(wb, parsed, rowIndexes, blackChannels) {
    const ws = wb.Sheets[parsed.sheetName];
    if (!ws) return;
    for (const channel of blackChannels) {
        const colName = CHANNEL_COLUMN[channel];
        if (!colName || parsed.columns[colName] === undefined) continue;
        const c = parsed.columns[colName];
        for (const r of rowIndexes) {
            const addr = XLSX.utils.encode_cell({ r, c });
            const old = ws[addr] || {};
            ws[addr] = { ...old, t: 's', v: '√' };
        }
    }
    if (!ws['!ref']) return;
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (const r of rowIndexes) {
        if (r > range.e.r) range.e.r = r;
    }
    ws['!ref'] = XLSX.utils.encode_range(range);
}

// 画面统计：亮度、黑色像素占比、颜色数；截图含播放器控制条，黑屏时黑色占比仍会 > 90%
async function imageStats(buffer) {
    const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    const total = info.width * info.height;
    let sum = 0, sum2 = 0, black = 0;
    const colors = new Set();
    for (let i = 0; i < data.length; i += ch) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        sum += l; sum2 += l * l;
        if (l < 14) black++;
        if (colors.size < 20000) colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
    }
    const mean = sum / total;
    return {
        mean,
        std: Math.sqrt(Math.max(0, sum2 / total - mean * mean)),
        blackRatio: black / total,
        colors: colors.size
    };
}

// 两帧差异：黑屏时画面几乎不变
async function frameDiff(bufA, bufB) {
    const a = await sharp(bufA).resize(320).greyscale().raw().toBuffer({ resolveWithObject: true });
    const b = await sharp(bufB).resize(320).greyscale().raw().toBuffer({ resolveWithObject: true });
    const n = Math.min(a.data.length, b.data.length);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.abs(a.data[i] - b.data[i]);
    return n ? sum / n : 0;
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

    // 读取右侧车辆详情状态：车辆状态文字、视频点播 Tab 是否存在/可用
    // 不依赖固定 class 容器：在可见的车辆详情弹窗内按文字“视频点播”定位
    async readDetailState(frame) {
        return await frame.evaluate(() => {
            const visible = (e) => {
                const r = e.getBoundingClientRect();
                return r.width > 2 && r.height > 2;
            };
            const detail = Array.from(document.querySelectorAll('.car-detail')).find(visible);
            const scope = detail || document;

            // 页面上可能有多个“视频点播”（Tab 与底部按钮），排除 primary / 底部按钮容器
            const isVideoText = (t) => t.startsWith('视频点播') && t.length <= 12;
            const candidates = Array.from(scope.querySelectorAll('button, span, div, a, li'))
                .filter(e => isVideoText((e.innerText || '').trim()) && visible(e));
            const area = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height; };
            const tabCandidate = candidates
                .filter(e => {
                    const btn = e.closest('button') || e;
                    const cls = String(btn.className || '');
                    return !cls.includes('el-button--primary') && !e.closest('.t-a-c');
                })
                .sort((a, b) => area(a) - area(b))[0] || candidates.sort((a, b) => area(a) - area(b))[0];
            const tabBtn = tabCandidate ? (tabCandidate.closest('button') || tabCandidate) : null;

            const text = detail ? String(detail.innerText || '') : '';
            const plateM = text.match(/车\s*牌\s*号\s*[:：]\s*([^\s]+)/);
            // 优先匹配车辆信息块里的“状态”，避免读到其他区块里残留的“离线”
            const statusM = text.match(/车\s*牌\s*号\s*[:：][\s\S]{0,120}?状\s*态\s*[:：]\s*([^\s]+)/)
                || text.match(/状\s*态\s*[:：]\s*([^\s]+)/);
            return {
                visible: !!detail,
                detailPlate: plateM ? plateM[1] : '',
                statusText: statusM ? statusM[1] : '',
                tabFound: !!tabBtn,
                tabDisabled: tabBtn ? !!tabBtn.disabled : false,
                diagnostics: {
                    detailText: text.replace(/\s+/g, ' ').slice(0, 200),
                    candidates: candidates.slice(0, 8).map(e => {
                        const r = e.getBoundingClientRect();
                        const btn = e.closest('button') || e;
                        return {
                            tag: e.tagName,
                            cls: String(btn.className || '').slice(0, 60),
                            disabled: !!btn.disabled,
                            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
                        };
                    })
                }
            };
        }).catch(() => ({ visible: false, statusText: '', tabFound: false, tabDisabled: false, diagnostics: null }));
    }

    // 点击视频点播 Tab，返回底部“视频点播”按钮状态
    async openVideoTab(frame, plate) {
        // 等详情更新为当前车牌，并等 Tab 变为可用（最多 15 秒）
        // 在线车辆刚选中时 Tab 可能短暂禁用，不能据此直接判离线
        let state = { visible: false, detailPlate: '', statusText: '', tabFound: false, tabDisabled: false };
        for (let i = 0; i < 30; i++) {
            state = await this.readDetailState(frame);
            const plateOk = !plate || !state.detailPlate || norm(state.detailPlate) === norm(plate);
            if (plateOk && state.tabFound && !state.tabDisabled) break;
            await sleep(500);
        }
        if (!state.tabFound) return { found: false, statusText: state.statusText, diagnostics: state.diagnostics };
        if (state.tabDisabled) {
            return { found: true, disabled: true, reason: 'disabled', statusText: state.statusText, diagnostics: state.diagnostics };
        }

        const clicked = await frame.evaluate(() => {
            const visible = (e) => {
                const r = e.getBoundingClientRect();
                return r.width > 2 && r.height > 2;
            };
            const detail = Array.from(document.querySelectorAll('.car-detail')).find(visible);
            const scope = detail || document;
            const isVideoText = (t) => t.startsWith('视频点播') && t.length <= 12;
            const area = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height; };
            const candidates = Array.from(scope.querySelectorAll('button, span, div, a, li'))
                .filter(e => isVideoText((e.innerText || '').trim()) && visible(e));
            const tab = candidates
                .filter(e => {
                    const b = e.closest('button') || e;
                    const cls = String(b.className || '');
                    return !cls.includes('el-button--primary') && !e.closest('.t-a-c');
                })
                .sort((a, b) => area(a) - area(b))[0];
            const btn = tab ? (tab.closest('button') || tab) : null;
            if (!btn) return false;
            btn.click();
            return true;
        });
        if (!clicked) return { found: false, statusText: state.statusText, diagnostics: state.diagnostics };
        await sleep(1500);

        // 等底部“视频点播”按钮出现（按文字定位，避免依赖固定 class）
        let disabledResult = null;
        for (let i = 0; i < 20; i++) {
            const d = await frame.evaluate(() => {
                const visible = (e) => {
                    const r = e.getBoundingClientRect();
                    return r.width > 2 && r.height > 2;
                };
                const list = Array.from(document.querySelectorAll('button'))
                    .filter(visible)
                    .filter(b => {
                        const t = (b.innerText || '').trim();
                        return t.startsWith('视频点播') && t.length <= 12 &&
                            !String(b.className).includes('el-button--text') &&
                            !b.closest('.navigation');
                    });
                const box = Array.from(document.querySelectorAll('.t-a-c.on-demand')).find(visible);
                const boxBtn = box ? box.querySelector('button') : null;
                const candidates = [boxBtn, ...list].filter(Boolean);
                // 优先使用可用按钮，避免读到临时禁用态
                const btn = candidates.find(b => !b.disabled) || candidates[0];
                if (!btn) return { found: false };
                const channelNames = Array.from(document.querySelectorAll('.vedio-button'))
                    .filter(visible)
                    .map(b => (b.innerText || '').trim())
                    .filter(Boolean);
                return { found: true, disabled: !!btn.disabled, channelNames };
            });
            if (d.found && !d.disabled) return { ...d, statusText: state.statusText };
            if (d.found) disabledResult = { ...d, statusText: state.statusText };
            await sleep(500);
        }
        if (disabledResult) return disabledResult;
        return { found: false, statusText: state.statusText, diagnostics: state.diagnostics };
    }

    // 首次点击视频点播会弹“使用新/旧视频控件”，选择新控件并确定
    async confirmVideoControl(frame) {
        for (let i = 0; i < 10; i++) {
            const state = await frame.evaluate(() => {
                const dialog = Array.from(document.querySelectorAll('.el-dialog'))
                    .find(e => e.getBoundingClientRect().width > 2 && String(e.innerText || '').includes('视频播放控件'));
                if (!dialog) return 'none';
                const radio = Array.from(dialog.querySelectorAll('.el-radio'))
                    .find(e => String(e.innerText || '').includes('使用新视频控件'));
                if (radio && !String(radio.className).includes('is-checked')) radio.click();
                const ok = Array.from(dialog.querySelectorAll('button'))
                    .find(b => (b.innerText || '').trim() === '确定');
                if (!ok) return 'no-ok';
                ok.click();
                return 'confirmed';
            });
            if (state === 'none') return false;
            if (state === 'confirmed') { await sleep(1000); return true; }
            await sleep(500);
        }
        return false;
    }

    // 确保所有通道都处于选中状态
    async selectAllChannels(frame) {
        await frame.evaluate(() => {
            Array.from(document.querySelectorAll('.vedio-button'))
                .filter(b => b.getBoundingClientRect().width > 2 && !String(b.className).includes('select'))
                .forEach(b => b.click());
        }).catch(() => {});
    }

    // 点击“开始点播”
    async clickStart(frame) {
        for (let i = 0; i < 20; i++) {
            const ok = await frame.evaluate(() => {
                const btn = Array.from(document.querySelectorAll('button'))
                    .find(b => (b.innerText || '').trim() === '开始点播' && b.getBoundingClientRect().width > 2);
                if (!btn) return false;
                btn.click();
                return true;
            });
            if (ok) return true;
            await sleep(500);
        }
        return false;
    }

    // 读取每个通道的名称与出流状态
    async readVideoStates(frame) {
        return await frame.evaluate(() => Array.from(document.querySelectorAll('video')).map((v, i) => {
            let el = v;
            let name = '';
            for (let k = 0; k < 8 && el; k++) {
                const m = String(el.innerText || '').replace(/\s+/g, ' ').match(/通道名[:：]\s*([^\s]+)/);
                if (m) { name = m[1]; break; }
                el = el.parentElement;
            }
            const r = v.getBoundingClientRect();
            return {
                i, name,
                ready: v.readyState,
                vw: v.videoWidth,
                vh: v.videoHeight,
                visible: r.width > 2 && r.height > 2
            };
        })).catch(() => []);
    }

    // 读取视频页顶部通道按钮名（作为通道顺序的兜底来源）
    async readChannelButtons(frame) {
        return await frame.evaluate(() => {
            const visible = (e) => {
                const r = e.getBoundingClientRect();
                return r.width > 2 && r.height > 2;
            };
            return Array.from(document.querySelectorAll('.vedio-button'))
                .filter(visible)
                .map(b => (b.innerText || '').trim())
                .filter(Boolean);
        }).catch(() => []);
    }

    // 监听页面里“通道XX未获取到视频流”这类报错（包括短暂出现的提示）
    // 同时把上一辆车遗留、未消失的报错标记为过期，避免串到下一辆车
    async installStreamErrorWatcher(frame) {
        await frame.evaluate(() => {
            const re = /未获取到视频流|未获取视频流|获取视频流失败|视频流获取失败|无视频流/;
            window.__streamErrors = [];

            // 标记当前已存在的报错为过期（上一辆车遗留）
            document.querySelectorAll('div,span,p,label,i').forEach(el => {
                const t = (el.innerText || '').trim();
                if (t && t.length < 80 && re.test(t)) {
                    el.setAttribute('data-streamerr-stale', '1');
                    el.setAttribute('data-streamerr-text', t.replace(/\s+/g, ' '));
                }
            });

            const record = (text) => {
                const t = String(text || '').replace(/\s+/g, ' ').trim();
                if (t && t.length < 80 && re.test(t) && !window.__streamErrors.includes(t)) {
                    window.__streamErrors.push(t);
                }
            };
            const scan = () => {
                document.querySelectorAll('div,span,p,label,i').forEach(el => {
                    const t = (el.innerText || '').trim();
                    if (!t || t.length >= 80 || !re.test(t)) return;
                    // 只取最内层，避免同一提示被父容器重复记录
                    if (Array.from(el.children).some(c => re.test((c.innerText || '').trim()))) return;
                    const clean = t.replace(/\s+/g, ' ');
                    if (el.getAttribute('data-streamerr-stale') === '1') {
                        if (el.getAttribute('data-streamerr-text') === clean) return; // 旧提示，忽略
                        el.removeAttribute('data-streamerr-stale'); // 文本变了，视为新提示
                    }
                    record(clean);
                });
            };
            scan();
            if (window.__streamErrObs) window.__streamErrObs.disconnect();
            let timer = null;
            const schedule = () => {
                if (timer) return;
                timer = setTimeout(() => { timer = null; scan(); }, 300);
            };
            const obs = new MutationObserver(schedule);
            obs.observe(document.body, { childList: true, subtree: true, characterData: true });
            window.__streamErrObs = obs;
        }).catch(() => {});
    }

    // 读取视频流报错：返回 [{ name, message }]
    async readStreamErrors(frame) {
        return await frame.evaluate(() => {
            const re = /未获取到视频流|未获取视频流|获取视频流失败|视频流获取失败|无视频流/;
            const visible = (e) => {
                const r = e.getBoundingClientRect();
                return r.width > 2 && r.height > 2;
            };
            const texts = new Set(window.__streamErrors || []);
            document.querySelectorAll('div,span,p,label,i').forEach(el => {
                if (!visible(el)) return;
                const t = (el.innerText || '').trim();
                if (!t || t.length >= 80 || !re.test(t)) return;
                // 只取最内层，避免父容器重复
                if (Array.from(el.children).some(c => re.test((c.innerText || '').trim()))) return;
                const clean = t.replace(/\s+/g, ' ');
                // 上一辆车遗留且文字未变化的报错，忽略
                if (el.getAttribute('data-streamerr-stale') === '1') {
                    if (el.getAttribute('data-streamerr-text') === clean) return;
                    el.removeAttribute('data-streamerr-stale');
                }
                texts.add(clean);
            });

            const known = ['ADAS', 'DSM', '通道', '前门', '左行李箱', '右行李箱', '左侧', '右侧'];
            const out = [];
            for (const raw of texts) {
                const clean = raw.replace(/\s+/g, ' ').trim();
                let name = '';
                const m = clean.match(/通道\s*([A-Za-z0-9\u4e00-\u9fa5]+?)\s*(?:未获取|无视频|视频流)/);
                if (m) name = m[1];
                if (!name) {
                    // 从报错元素向上找“通道名：X”
                    const el = Array.from(document.querySelectorAll('div,span,p,label,i'))
                        .find(e => visible(e) && String(e.innerText || '').trim() === clean);
                    let p = el;
                    for (let k = 0; k < 8 && p; k++) {
                        const hm = String(p.innerText || '').replace(/\s+/g, ' ').match(/通道名[:：]\s*([^\s]+)/);
                        if (hm) { name = hm[1]; break; }
                        p = p.parentElement;
                    }
                }
                if (!name) {
                    const hit = known.find(k => clean.includes(k));
                    if (hit) name = hit;
                }
                out.push({ name, message: clean });
            }
            return out;
        }).catch(() => []);
    }

    // 等待通道出流或出现“未获取到视频流”报错
    async waitForVideos(frame, expectedNames = [], timeoutMs = VIDEO_READY_TIMEOUT) {
        const deadline = Date.now() + timeoutMs;
        let states = [];
        let errors = [];
        let resolved = false;
        while (Date.now() < deadline) {
            states = await this.readVideoStates(frame);
            errors = await this.readStreamErrors(frame);
            const errorNames = new Set(errors.map(e => e.name).filter(Boolean));

            if (expectedNames.length) {
                const unresolved = expectedNames.filter((name, i) => {
                    const st = states[i];
                    const ready = st && st.ready >= 2 && st.vw > 0;
                    return !ready && !errorNames.has(name);
                });
                resolved = unresolved.length === 0;
            } else {
                resolved = states.length > 0 && states.every(s => s.ready >= 2 && s.vw > 0);
            }
            if (resolved) break;
            await sleep(2000);
        }
        // 最后一轮以最新状态为准
        states = await this.readVideoStates(frame);
        errors = await this.readStreamErrors(frame);
        return { states, errors, resolved };
    }

    // 分析每个通道画面，返回黑屏通道名（channelNames 为弹窗通道按钮顺序，最可靠）
    async analyzeChannels(frame, states, channelNames = [], streamErrors = []) {
        // 对黑屏通道多轮复查：有些通道刚出流时还是黑帧，稍后才出现画面
        const rounds = 3;
        const decisions = new Map(); // name -> { black, detail, error }
        const names = channelNames.length
            ? channelNames.slice()
            : states.map((s, i) => s.name || `通道${i + 1}`);

        const applyErrors = (errors) => {
            for (const e of errors) {
                if (e.name) {
                    decisions.set(e.name, { black: true, detail: '平台报错：' + e.message, error: true });
                }
            }
        };
        applyErrors(streamErrors);

        const firstBlack = new Set();
        const latePicture = new Set();

        for (let round = 0; round < rounds; round++) {
            const currentStates = await this.readVideoStates(frame);
            const currentErrors = await this.readStreamErrors(frame);
            applyErrors(currentErrors);
            const handles = await frame.$$('video');
            let pending = false;

            for (let i = 0; i < names.length; i++) {
                const name = names[i] || (currentStates[i] && currentStates[i].name) || `通道${i + 1}`;
                const decided = decisions.get(name);
                if (decided && decided.error) continue;       // 平台已明确报错
                if (decided && decided.black === false) continue; // 已确认有画面

                const st = currentStates[i];
                if (!st || st.ready < 2 || !st.vw || !handles[i]) {
                    pending = true;
                    continue;
                }

                try {
                    const shotA = await handles[i].screenshot();
                    await sleep(1500);
                    const shotB = await handles[i].screenshot();
                    const sA = await imageStats(shotA);
                    const sB = await imageStats(shotB);
                    const diff = await frameDiff(shotA, shotB);
                    const black = sA.mean < 15 && sA.blackRatio > 0.88 && diff < 1.2;
                    // 两帧之间画面刚出现时，用较亮的一帧统计，日志更准确
                    const useB = !black && sB.mean > sA.mean;
                    const s = useB ? sB : sA;
                    const justAppeared = !black && sA.mean < 15 && sA.blackRatio > 0.88;
                    let detail = `亮度${s.mean.toFixed(1)} 黑占比${(s.blackRatio * 100).toFixed(1)}% 帧差${diff.toFixed(2)}`;
                    if (justAppeared) detail += '，画面刚出现';

                    if (black) {
                        firstBlack.add(name);
                        decisions.set(name, { black: true, detail });
                        pending = true; // 继续下一轮复查，避免“刚出画面”被误判
                    } else {
                        if (firstBlack.has(name)) latePicture.add(name);
                        decisions.set(name, { black: false, detail });
                    }
                } catch (e) {
                    decisions.set(name, { black: true, detail: '截取画面失败: ' + e.message });
                    pending = true;
                }
            }
            if (!pending) break;
            await sleep(2000);
        }

        // 一直没有视频元素的通道按未出流处理
        for (let i = 0; i < names.length; i++) {
            const name = names[i] || `通道${i + 1}`;
            if (!decisions.has(name)) decisions.set(name, { black: true, detail: '未出视频流' });
        }

        for (const e of await this.readStreamErrors(frame)) {
            if (!e.name) this.log(`  检测到视频流报错（未识别通道）：${e.message}`);
        }

        const blackChannels = [];
        for (const name of names) {
            const d = decisions.get(name);
            if (!d) continue;
            const suffix = latePicture.has(name) ? '，等待后出现画面' : '';
            this.log(`  ${name}: ${d.black ? '无画面' : '有画面'}${d.detail ? '（' + d.detail + suffix + '）' : ''}`);
            if (d.black) blackChannels.push(name);
        }
        // 报错里出现、但不在通道顺序里的通道也要算黑屏
        for (const [name, d] of decisions) {
            if (names.includes(name)) continue;
            this.log(`  ${name}: 无画面（${d.detail}）`);
            blackChannels.push(name);
        }
        return [...new Set(blackChannels)];
    }

    // 确保车辆监控页的搜索框可见（视频点播是 SPA 子路由，需要切回 CarsMonitor）
    async ensureMonitorRoute(frame) {
        const visible = () => frame.evaluate(() => Array.from(document.querySelectorAll('.search_box'))
            .some(b => b.getBoundingClientRect().width > 10)).catch(() => false);
        if (await visible()) return true;
        await frame.evaluate(() => { location.hash = '#/index/CarsMonitor'; }).catch(() => {});
        for (let i = 0; i < 20; i++) {
            await sleep(500);
            if (await visible()) return true;
        }
        return false;
    }

    // 停止播放并返回车辆监控页
    async backToMonitor(page, frame) {
        // 停止视频流报错监听，避免在车辆监控页持续扫描
        await frame.evaluate(() => {
            if (window.__streamErrObs) {
                window.__streamErrObs.disconnect();
                window.__streamErrObs = null;
            }
        }).catch(() => {});
        await frame.evaluate(() => {
            const stop = Array.from(document.querySelectorAll('button'))
                .find(b => (b.innerText || '').trim() === '停止全部' && b.getBoundingClientRect().width > 2);
            if (stop) stop.click();
        }).catch(() => {});
        await sleep(1000);

        if (await this.ensureMonitorRoute(frame)) return;

        // 兜底：重新点击顶部“车辆监控”标签
        for (const f of page.frames()) {
            try {
                await f.evaluate(() => {
                    const el = Array.from(document.querySelectorAll('.tabs-title'))
                        .find(e => (e.innerText || '').trim() === '车辆监控');
                    if (el) el.click();
                });
            } catch (e) { /* ignore */ }
        }
        await sleep(2500);
        await this.ensureMonitorRoute(frame);
    }

    // 处理单个车牌：搜索 -> 视频点播 -> 判断通道
    async processPlate(page, plate) {
        let frame = await this.getMonitorFrame(page);
        if (!(await this.ensureMonitorRoute(frame))) {
            frame = await this.enterMonitor(page);
            if (!(await this.ensureMonitorRoute(frame))) {
                return { status: 'failed', detail: '无法回到车辆监控页面' };
            }
        }

        const selected = await this.searchAndSelect(frame, plate);
        if (selected.status !== 'selected') return selected;

        let demand = await this.openVideoTab(frame, plate);
        if (!demand.found) {
            // 可能第一次点击未生效，重试一次
            await sleep(1000);
            demand = await this.openVideoTab(frame, plate);
        }
        if (!demand.found) {
            if (demand.diagnostics) this.log('  未找到底部视频点播按钮，页面诊断：' + JSON.stringify(demand.diagnostics));
            await this.backToMonitor(page, frame);
            return { status: 'failed', detail: `未找到底部视频点播按钮（车辆状态：${demand.statusText || '未知'}）` };
        }
        if (demand.disabled) {
            if (demand.diagnostics) this.log('  视频点播不可用，页面诊断：' + JSON.stringify(demand.diagnostics));
            await this.backToMonitor(page, frame);
            if (/^离线/.test(demand.statusText || '')) {
                return { status: 'offline', detail: '车辆离线，视频点播不可用' };
            }
            return { status: 'failed', detail: `视频点播按钮不可用（车辆状态：${demand.statusText || '未知'}）` };
        }

        await this.selectAllChannels(frame);
        await frame.evaluate(() => {
            const box = Array.from(document.querySelectorAll('.t-a-c.on-demand'))
                .find(b => b.getBoundingClientRect().width > 2);
            const btn = box && box.querySelector('button');
            if (btn && !btn.disabled) btn.click();
        });
        await sleep(3000);

        await this.confirmVideoControl(frame);

        // 安装视频流报错监听（捕获“通道DSM未获取到视频流”等提示）
        await this.installStreamErrorWatcher(frame);

        if (!(await this.clickStart(frame))) {
            await this.backToMonitor(page, frame);
            return { status: 'failed', detail: '未找到开始点播按钮' };
        }

        // 等视频元素创建；若先出现视频流报错则不必继续等
        const createDeadline = Date.now() + 20000;
        while (Date.now() < createDeadline) {
            const count = await frame.evaluate(() => document.querySelectorAll('video').length).catch(() => 0);
            if (count > 0) break;
            const errs = await this.readStreamErrors(frame);
            if (errs.length) break;
            await sleep(1000);
        }

        // 期望通道顺序：弹窗通道按钮 -> 视频页顶部通道按钮
        let expectedNames = demand.channelNames || [];
        if (!expectedNames.length) expectedNames = await this.readChannelButtons(frame);

        let waitRes = await this.waitForVideos(frame, expectedNames, 45000);
        if (!waitRes.resolved) {
            this.log('  部分通道尚未出流，再等待 30 秒...');
            waitRes = await this.waitForVideos(frame, expectedNames, 30000);
        }
        const { states, errors } = waitRes;
        if (!states.length && !errors.length) {
            await this.backToMonitor(page, frame);
            return { status: 'failed', detail: '点播后未出现视频通道' };
        }

        await sleep(2000);
        const latestStates = await this.readVideoStates(frame);
        const latestErrors = await this.readStreamErrors(frame);

        // 通道名优先用弹窗通道按钮顺序；数量对不上时用视频页顶部通道按钮兜底
        let channelNames = expectedNames;
        if (!channelNames.length || channelNames.length !== latestStates.length) {
            const altNames = await this.readChannelButtons(frame);
            if (altNames.length) channelNames = altNames;
        }

        const blackChannels = await this.analyzeChannels(frame, latestStates, channelNames, latestErrors);
        await this.backToMonitor(page, frame);

        return { status: 'done', blackChannels, detail: blackChannels.length ? `黑屏：${blackChannels.join('、')}` : '全部有画面' };
    }

    async run(filePath) {
        const parsed = readMonitorReport(filePath);
        if (!parsed.rows.length) throw new Error('报表中没有可处理的车辆（车辆牌号列为空）');
        this.log(`读取到 ${parsed.rows.length} 行车辆数据（工作表：${parsed.sheetName}）`);

        const wb = XLSX.readFile(filePath, { cellStyles: true });
        const page = await this.openPlatform();

        try {
            // 同一车牌可能出现在多行，只点播一次，结果写到所有对应行
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
                    if (result.blackChannels && result.blackChannels.length) {
                        markBlackChannels(wb, parsed, rowIndexes, result.blackChannels);
                        this.log(`  已打勾：${result.blackChannels.map(c => `${c}→${CHANNEL_COLUMN[c] || '未匹配列'}`).join('，')}`);
                        const unmapped = result.blackChannels.filter(c => !CHANNEL_COLUMN[c]);
                        if (unmapped.length) {
                            this.log(`  注意：${unmapped.join('、')} 在报表中没有对应列，无法打勾`);
                        }
                    } else {
                        this.log('  所有通道均有画面，未打勾');
                    }
                } else if (result.status === 'offline') {
                    this.log('  车辆离线，视频点播不可用，跳过');
                } else if (result.status === 'notfound') {
                    this.log('  车辆列表中未找到该车牌，跳过');
                } else {
                    this.log(`  处理失败：${result.detail || '未知错误'}`);
                }

                this.onProgress({
                    rowIndexes,
                    status: result.status,
                    detail: result.detail || '',
                    blackChannels: result.blackChannels || []
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

module.exports = { readMonitorReport, outputPathFor, MonitorReportFlow, CHANNEL_COLUMN };
