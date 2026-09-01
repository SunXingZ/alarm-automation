const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

// 浏览器持久化数据目录：保存登录态，之后运行无需重复登录。
// 必须放在可写目录（app.getPath('userData')）——打包后 __dirname 位于只读的
// app.asar 内，不能把登录态写进 asar。
// 若 userData 被杀软/权限锁住（Windows EPERM），降级到系统临时目录（登录态不持久，但流程可用）
let warned = false;
function getUserDataDir() {
    const preferred = path.join(app.getPath('userData'), 'chrome-profile');
    try {
        fs.mkdirSync(preferred, { recursive: true });
        const probe = path.join(preferred, `.write_probe_${Date.now()}`);
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        return preferred;
    } catch (e) {
        const fallback = path.join(os.tmpdir(), 'alarm-automation-chrome-profile');
        if (!warned) {
            warned = true;
            console.warn(`浏览器数据目录 ${preferred} 不可写（${e.message}），降级使用临时目录 ${fallback}（登录态不会跨次保存）`);
        }
        fs.mkdirSync(fallback, { recursive: true });
        return fallback;
    }
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
    return CHROME_CANDIDATES.filter(p => {
        try { return fs.existsSync(p); } catch (e) { return false; }
    });
}

class BrowserManager {
    constructor() {
        this.browser = null;
    }

    async launch(headless = true) {
        const baseOpts = {
            headless,   // puppeteer >= 22 已移除 'new' 字符串值，true 即新的无头模式
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            defaultViewport: { width: 1366, height: 768 }
        };
        const errors = [];
        // Windows 上可能出现浏览器进程启动即退出（code 0，无 stderr）：残损的 profile 锁、
        // 杀软拦截、exe 是跳板程序等。因此每个候选都做两级尝试：首选 userDataDir，
        // 失败再换全新临时目录，仍失败则换下一个候选。
        const tryLaunch = async (opts) => {
            try {
                this.browser = await puppeteer.launch(opts);
                return true;
            } catch (e) {
                errors.push(`${opts.executablePath || ('channel:' + opts.channel)}: ${e.message.split('\n')[0]}`);
                return false;
            }
        };
        // 1. 系统已安装的浏览器（按路径，优先 Chrome 后 Edge）
        for (const exe of resolveChromeExecutable()) {
            if (await tryLaunch({ ...baseOpts, executablePath: exe, userDataDir: getUserDataDir() })) return;
            if (await tryLaunch({ ...baseOpts, executablePath: exe, userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'aa-chrome-')) })) return;
        }
        // 2. 按 channel 让 puppeteer 自动解析（Windows 几乎都自带 Edge）
        for (const channel of ['msedge', 'chrome']) {
            if (await tryLaunch({ ...baseOpts, channel, userDataDir: getUserDataDir() })) return;
            if (await tryLaunch({ ...baseOpts, channel, userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'aa-chrome-')) })) return;
        }
        throw new Error('未能启动浏览器，已尝试的候选均失败：\n' + errors.join('\n') +
            '\n请确认已安装 Chrome 或 Edge，或被杀毒软件拦截');
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
