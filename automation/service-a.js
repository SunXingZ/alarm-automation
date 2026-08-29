const browserManager = require('./browser-manager');

// 道路运输车辆运营监测分析应用
const SITE_NAME = '道路运输车辆运营监测分析应用';
const LOGIN_URL = 'http://183.192.65.93:8807/login';
const COMPLAINT_URL = 'http://183.192.65.93:8807/gps/complaint';

class ServiceA {
    constructor(log = console.log) {
        this.log = log;
    }

    async getPendingOrders() {
        // 手动登录需要可见浏览器窗口，强制有头模式
        if (!browserManager.browser) await browserManager.launch(false);
        const page = await browserManager.newPage();

        // 打开登录页；若已登录（登录态持久化）会自动跳转，无需再登录
        await page.goto(LOGIN_URL, { waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {});

        const alreadyLoggedIn = await page.evaluate(() => location.pathname !== '/login');
        if (!alreadyLoggedIn) {
            this.log(`请在弹出的浏览器窗口中手动完成 ${SITE_NAME} 登录，登录成功后自动继续...`);
            // 等待用户手动登录：检测 URL 离开 /login（最长 10 分钟）
            await page.waitForFunction(() => location.pathname !== '/login', { timeout: 600000 });
        } else {
            this.log(`检测到 ${SITE_NAME} 已登录，直接获取待处理订单`);
        }

        // 登录成功后进入报警申诉板块（选择器需用真实账号验证）
        // networkidle0 易挂起，用 catch 兜底后交由 waitForSelector 等待页面渲染完成
        await page.goto(COMPLAINT_URL, { waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {});
        await page.waitForSelector('.order-list', { timeout: 30000 });

        // 提取所有待处理订单信息（根据实际 DOM 调整）
        const orders = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.order-item'));
            return items.map(item => ({
                plate: item.querySelector('.plate').textContent.trim(),
                startDate: item.querySelector('.start-date').textContent.trim(),
                endDate: item.querySelector('.end-date').textContent.trim()
            }));
        });

        await page.close();
        return orders;
    }
}

module.exports = ServiceA;
