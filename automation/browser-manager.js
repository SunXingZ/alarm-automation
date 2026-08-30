const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// 浏览器持久化数据目录：保存登录态，之后运行无需重复登录。
// 必须放在可写目录（app.getPath('userData')）——打包后 __dirname 位于只读的
// app.asar 内，不能把登录态写进 asar。
function getUserDataDir() {
    return path.join(app.getPath('userData'), 'chrome-profile');
}

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
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    // Windows 自带的 Edge（多数 Windows 机器未安装 Google Chrome）
    process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.PROGRAMFILES + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe'
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
        this.headless = headless; // 记住模式，重启时保持一致
        const executablePath = resolveChromeExecutable();
        const baseOpts = {
            headless,   // puppeteer >= 22 已移除 'new' 字符串值，true 即新的无头模式
            // 反自动化检测参数：部分站点会检测无头/自动化特征（navigator.webdriver、--enable-automation 痕迹等），
            // 检测到后可能不下发数据/脚本，导致 doSearch 等页面函数不定义（表现为 “Waiting failed” 超时）
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled', // 关闭自动化控制特征
                '--disable-infobars',
                '--no-first-run',
                '--no-default-browser-check'
            ],
            defaultViewport: { width: 1366, height: 768 },
            userDataDir: getUserDataDir()
        };
        // 优先使用系统浏览器路径（Chrome / Edge）
        if (executablePath) {
            this.browser = await puppeteer.launch({ ...baseOpts, executablePath });
            return;
        }
        // 找不到具体路径时，按 channel 让 puppeteer 自动解析：
        // Windows 几乎都自带 Edge，其次 Chrome
        for (const channel of ['msedge', 'chrome']) {
            try {
                this.browser = await puppeteer.launch({ ...baseOpts, channel });
                return;
            } catch (e) {
                console.warn(`使用 channel=${channel} 启动浏览器失败: ${e.message}`);
            }
        }
        throw new Error('未找到可用的 Chromium 浏览器（Chrome/Edge），无法启动自动化');
    }

    // 无头模式反检测：隐藏 navigator.webdriver 自动化标记，并移除 UA 中的无头标记，
    // 降低站点识别为自动化浏览器的概率（识别后可能不下发数据，表现为 Waiting failed 超时）
    async stealthifyPage(page) {
        // 在页面任何脚本执行前注入，覆盖自动化检测常用的几个特征
        page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            if (window.chrome && window.chrome.runtime) {
                Object.defineProperty(window.chrome, 'runtime', { get: () => undefined });
            }
        });
        // 新无头模式 UA 本身已不含 HeadlessChrome，这里仅作兜底（旧无头/个别版本）
        try {
            const ua = await page.browser().userAgent();
            await page.setUserAgent(ua.replace('HeadlessChrome', 'Chrome').replace(/Headless/, ''));
        } catch (e) { /* UA 覆盖失败不影响主流程 */ }
    }

    async newPage() {
        // 浏览器未启动，或已被用户手动关闭/断开：先尝试复用，失败则自动重启。
        // 不依赖 isConnected()（不同 puppeteer 版本 API 不同），直接 try/catch newPage()
        if (this.browser) {
            try {
                const page = await this.browser.newPage();
                await this.stealthifyPage(page);
                return page;
            } catch (e) {
                // 浏览器已关闭/断开，继续重建
            }
        }
        // 重建：保留原来的可见/无头模式，并对刚关闭进程的配置文件锁做短暂重试
        this.browser = null;
        for (let i = 0; i < 5; i++) {
            try {
                await this.launch(this.headless !== false);
                const page = await this.browser.newPage();
                await this.stealthifyPage(page);
                return page;
            } catch (e) {
                await new Promise(r => setTimeout(r, 800));
            }
        }
        throw new Error('浏览器已关闭，自动重新启动失败');
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
