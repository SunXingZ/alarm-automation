const browserManager = require('./browser-manager');

// 运输车辆监控平台
const SITE_NAME = '运输车辆监控平台';
const LOGIN_URL = 'http://114.80.138.167:6385/index.html';                          // 登录/主界面入口
const ALARM_URL = 'http://114.80.138.167:6385/driveAls/view/alarm/index.html';      // 报警数据页

// 未登录时报警数据接口会返回 500 的路径关键字（用于判断会话是否有效）
const UNAUTH_API_KEYS = ['fieldDisplay', 'queryUserAlarmList'];

// 将用户输入规整为 yyyy-MM-dd HH:mm:ss
// 支持粘贴（含 /、T 分隔或只写日期）；缺省时间时按开始=00:00:00、结束=23:59:59 补齐
function normalizeToDatetime(value, isEnd) {
    const s = String(value || '').trim();
    if (!s) return '';
    const v = s.replace(/\//g, '-').replace('T', ' ');
    const m = v.match(/^(\d{4}-\d{1,2}-\d{1,2})(?:[ ]+(\d{1,2}:\d{1,2}(?::\d{1,2})?))?/);
    if (!m) return '';
    const pad = (n) => String(n).padStart(2, '0');
    let out = m[1].split('-').map(pad).join('-');
    if (m[2]) {
        let t = m[2];
        if (t.split(':').length === 2) t += ':00'; // 补秒
        out += ' ' + t;
    } else {
        out += isEnd ? ' 23:59:59' : ' 00:00:00';
    }
    return out;
}

// 设置 EasyUI 控件值。控件未初始化时直接调用会报
// “cannot read properties of undefined (reading 'options')”，
// 故自动重试直至成功（或超时后跳过并警告），避免整段流程崩溃
async function setWidgetValue(page, selector, widget, method, value, log) {
    for (let i = 0; i < 20; i++) {
        const ok = await page.evaluate(({ selector, widget, method, value }) => {
            try {
                const el = document.querySelector(selector);
                if (!el) return false;
                $(selector)[widget](method, value);
                return true;
            } catch (e) {
                return false; // 控件未就绪，稍后重试
            }
        }, { selector, widget, method, value }).catch(() => false);
        if (ok) return true;
        await new Promise(r => setTimeout(r, 500));
    }
    if (log) log(`警告: 设置 ${selector} 失败（控件未就绪），已跳过该条件`);
    return false;
}

// 等待弹窗中的报警详情 iframe 加载到指定报警 id，并返回该 frame
async function waitDetailFrame(page, alarmId) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        const f = page.frames().find(x => x.url().includes('alarm_detail.html') && x.url().includes('id=' + alarmId));
        if (f) return f;
        await new Promise(r => setTimeout(r, 500));
    }
    return null;
}

class ServiceB {
    constructor(log = console.log) {
        this.log = log;
    }

    // 表格是否为空（记录总数缺失/为 0，或数据行数为 0）
    async tableIsEmpty(page) {
        return await page.evaluate(() => {
            const t = (document.querySelector('#table_data_count') || {}).textContent || '';
            const m = t.match(/(\d+)/);
            const total = m ? parseInt(m[1], 10) : 0;
            const rows = document.querySelectorAll('.datagrid-body tr').length;
            return total === 0 || rows === 0;
        }).catch(() => true);
    }

    // 打开报警数据页并确保已登录：
    // 仅当报警数据接口返回 500 且表格为空时判定未登录，前往登录页等待手动登录后返回
    async ensureLoggedInAlarm(page) {
        let saw500 = false;
        const onResp = (res) => {
            const u = res.url();
            if (res.status() === 500 && UNAUTH_API_KEYS.some(k => u.includes(k))) saw500 = true;
        };
        page.on('response', onResp);

        const openAlarm = async () => {
            saw500 = false;
            await page.goto(ALARM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 4000)); // 等待数据接口返回
        };

        await openAlarm();
        const needLogin = saw500 && (await this.tableIsEmpty(page));
        page.off('response', onResp);
        if (!needLogin) {
            this.log(`检测到 ${SITE_NAME} 已登录，继续`);
            return;
        }
        // 未登录：前往登录页等待手动登录
        this.log(`未检测到有效登录（报警接口 500 且表格为空），请在弹出的浏览器窗口中手动完成 ${SITE_NAME} 登录（含验证码），登录成功后自动继续...`);
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await page.waitForFunction(() => {
            const userSpan = (document.querySelector('span.user') || {}).textContent || '';
            const hasLogout = Array.from(document.querySelectorAll('span, a, li')).some(el => {
                const t = (el.textContent || '').trim().replace(/\s+/g, '');
                return t === '登出';
            });
            const menuOk = Array.from(document.querySelectorAll('a')).some(a =>
                (a.textContent || '').trim() === '预警中心' || /menu-hd/.test((a.className || '').toString())
            );
            return !!userSpan.trim() || hasLogout || menuOk;
        }, { timeout: 600000 });
        this.log(`检测到 ${SITE_NAME} 已登录，重新进入报警数据页`);
        // 登录成功后重新进入报警数据页并复核
        page.on('response', onResp);
        await openAlarm();
        page.off('response', onResp);
        if (saw500 && (await this.tableIsEmpty(page))) {
            this.log('警告: 重新进入报警数据页后仍出现接口 500 且表格为空，可能仍需登录');
        }
    }

    // 采集第 idx 行“查看照片”弹窗内的人脸截图 URL
    async collectRowPhotos(page, idx) {
        // 读取该行“查看照片”按钮中的报警 id
        const alarmId = await page.evaluate((i) => {
            const els = document.querySelectorAll('a[title="查看照片"]');
            const onclick = els[i] ? els[i].getAttribute('onclick') : '';
            const m = onclick && onclick.match(/'(\d+)'/);
            return m ? m[1] : null;
        }, idx);
        if (!alarmId) return [];

        // 点击该行“查看照片”
        await page.evaluate((i) => {
            const els = document.querySelectorAll('a[title="查看照片"]');
            if (els[i]) els[i].click();
        }, idx);

        // 等待详情 iframe 加载到当前报警
        const frame = await waitDetailFrame(page, alarmId);
        if (!frame) return [];

        // 等待人脸截图出现（非站点本地资源的真实图片）
        try {
            await frame.waitForFunction(() => {
                const site = location.origin;
                return Array.from(document.querySelectorAll('img')).some(im => {
                    const s = im.src || '';
                    return s.startsWith('http') && !s.startsWith(site) && !s.startsWith('data:') && im.complete && im.naturalWidth > 0;
                });
            }, { timeout: 10000 });
        } catch (e) {
            // 无照片或加载超时
        }

        const srcs = await frame.evaluate(() => {
            const site = location.origin;
            return Array.from(document.querySelectorAll('img'))
                .map(im => im.src)
                .filter(s => s && s.startsWith('http') && !s.startsWith(site) && !s.startsWith('data:'));
        });
        return [...new Set(srcs)];
    }

    // 采集当前页所有含“查看照片”的行的人脸截图
    async collectCurrentPagePhotos(page) {
        const photoCount = await page.evaluate(() => document.querySelectorAll('a[title="查看照片"]').length);
        const urls = [];
        for (let i = 0; i < photoCount; i++) {
            try {
                urls.push(...await this.collectRowPhotos(page, i));
            } catch (e) {
                this.log(`第 ${i + 1} 行获取照片失败: ${e.message}`);
            }
        }
        return urls;
    }

    // 按车牌 + 起止时间查询报警数据，分页采集所有“查看照片”里的人脸截图 URL
    // filters: { alarmTypes: [], riskLevels: [], repairStatus: [] }，为空则不限制
    async searchAndGetScreenshots(plate, startDate, endDate, filters = {}) {
        // 浏览器已在主流程中启动（有头模式），直接复用
        if (!browserManager.browser) await browserManager.launch(false);
        const page = await browserManager.newPage();

        // 打开报警数据页并确保已登录（接口 500/无预警中心导航栏则先手动登录）
        await this.ensureLoggedInAlarm(page);
        // 等待报警页脚本就绪
        await page.waitForFunction(() => typeof window.doSearch === 'function', { timeout: 20000 });

        // 规整起止时间（支持时分秒与粘贴），并设置筛选条件后查询第 1 页
        const startVal = normalizeToDatetime(startDate, false);
        const endVal = normalizeToDatetime(endDate, true);
        this.log(`${SITE_NAME}查询: ${plate}，${startVal || startDate} ~ ${endVal || endDate}`);
        // 逐控件设置值（内部自动等待控件初始化并重试，避免 “reading 'options'” 报错）
        await setWidgetValue(page, '#ss', 'searchbox', 'setValue', plate, this.log);
        if (startVal) await setWidgetValue(page, '#startTime', 'datetimebox', 'setValue', startVal, this.log);
        if (endVal) await setWidgetValue(page, '#endTime', 'datetimebox', 'setValue', endVal, this.log);
        if (filters.alarmTypes && filters.alarmTypes.length) {
            await setWidgetValue(page, '#alarmtype', 'combotree', 'setValues', filters.alarmTypes, this.log);
        }
        if (filters.riskLevels && filters.riskLevels.length) {
            await setWidgetValue(page, '#alarmClassification', 'combobox', 'setValues', filters.riskLevels, this.log);
        }
        if (filters.repairStatus && filters.repairStatus.length) {
            await setWidgetValue(page, '#repairStatus', 'combobox', 'setValues', filters.repairStatus, this.log);
        }
        // 触发查询（数据表格若未就绪 doSearch 内部也会抛同类错误，同样重试）
        for (let i = 0; i < 20; i++) {
            const ok = await page.evaluate(() => {
                try {
                    if (typeof doSearch === 'function') { doSearch(1); return true; }
                    return false;
                } catch (e) {
                    return false;
                }
            }).catch(() => false);
            if (ok) break;
            await new Promise(r => setTimeout(r, 500));
        }
        await new Promise(r => setTimeout(r, 3000));

        // 读取记录总数与每页条数，计算总页数
        const pager = await page.evaluate(() => {
            const totalText = (document.querySelector('#table_data_count') || {}).textContent || '';
            const m = totalText.match(/(\d+)/);
            const total = m ? parseInt(m[1], 10) : 0;
            const sizeSel = document.querySelector('.pagination-page-list');
            const pageSize = sizeSel ? parseInt(sizeSel.value, 10) : 20;
            return { total, pageSize: pageSize || 20, totalPages: Math.max(1, Math.ceil(total / (pageSize || 20))) };
        });
        this.log(`${SITE_NAME}命中 ${pager.total} 条报警，共 ${pager.totalPages} 页`);

        // 逐页采集（第 1 页已加载；后续页点击“下一页”）
        const urls = [];
        for (let pageNum = 1; pageNum <= pager.totalPages; pageNum++) {
            if (pageNum > 1) {
                const prevInfo = await page.evaluate(() => (document.querySelector('.pagination-info') || {}).textContent || '');
                const clicked = await page.evaluate(() => {
                    const next = Array.from(document.querySelectorAll('a')).find(a =>
                        a.querySelector('.pagination-next') && !a.classList.contains('l-btn-disabled')
                    );
                    if (next) { next.click(); return true; }
                    return false;
                });
                if (!clicked) break;
                // 等待分页信息变化（进入下一页）
                await page.waitForFunction((prev) =>
                    ((document.querySelector('.pagination-info') || {}).textContent || '') !== prev,
                    { timeout: 10000 }, prevInfo
                ).catch(() => {});
                await new Promise(r => setTimeout(r, 1500)); // 等待数据行渲染
            }
            const pageUrls = await this.collectCurrentPagePhotos(page);
            this.log(`第 ${pageNum} 页采集到 ${pageUrls.length} 张截图`);
            urls.push(...pageUrls);
        }

        await page.close();
        return urls;
    }
}

module.exports = ServiceB;
