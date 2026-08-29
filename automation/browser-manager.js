const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// 持久化浏览器数据目录：保存登录态，之后运行无需重复登录
const USER_DATA_DIR = path.join(__dirname, '..', '.chrome-profile');

// 系统 Chrome/Chromium 常见路径，作为 puppeteer 自带浏览器缺失时的兜底
const CHROME_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // macOS
    '/Applications/Chromium.app/Contents/MacOS/Chromium',           // macOS Chromium
    '/usr/bin/google-chrome',                                       // Linux
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',       // Windows
    process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);

function resolveChromeExecutable() {
    for (const p of CHROME_CANDIDATES) {
        try {
            if (fs.existsSync(p)) return p;
        } catch (e) { /* 忽略非法路径 */ }
    }
    return null;
}

class BrowserManager {
    constructor() {
        this.browser = null;
    }

    async launch(headless = true) {
        const executablePath = resolveChromeExecutable();
        // puppeteer >= 22 已移除 'new' 字符串值，headless: true 即新的无头模式
        this.browser = await puppeteer.launch({
            headless,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            defaultViewport: { width: 1366, height: 768 },
            userDataDir: USER_DATA_DIR,
            // 优先使用系统 Chrome；找不到再退回 puppeteer 自带浏览器
            ...(executablePath ? { executablePath } : { channel: 'chrome' })
        });
    }

    async newPage() {
        if (!this.browser) await this.launch();
        return await this.browser.newPage();
    }

    async close() {
        if (!this.browser) return;
        const browser = this.browser;
        this.browser = null;
        // 先优雅关闭
        try {
            await browser.close();
        } catch (e) {
            // 优雅关闭失败时忽略，下面统一强制收尾
        }
        // 无论优雅关闭是否成功，都确保进程真正退出（窗口彻底关闭）后才返回
        try {
            const proc = browser.process && browser.process();
            if (proc && proc.pid) {
                try { proc.kill('SIGKILL'); } catch (e) { /* 进程已退出 */ }
                // 等待进程退出（最多 5 秒）
                for (let i = 0; i < 50; i++) {
                    try {
                        process.kill(proc.pid, 0); // 抛错则进程已不存在
                    } catch (e2) {
                        break;
                    }
                    await new Promise(r => setTimeout(r, 100));
                }
            }
        } catch (e) { /* 忽略 */ }
    }
}

module.exports = new BrowserManager();
