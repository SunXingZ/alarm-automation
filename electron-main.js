const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

// 加载自动化模块（内含 onnxruntime-node / sharp 原生模块）。
// 部分电脑缺少或版本过旧的 VC++ 运行库时，require 会抛
// "A dynamic link library (DLL) initialization routine failed"（错误 1114）并直接崩溃；
// 这里改为弹出可操作的提示后退出，而不是无说明地闪退
let runAutomation, BrowserManager, getSpreadsheetTimeRange;
try {
    ({ runAutomation } = require('./automation/index'));
    BrowserManager = require('./automation/browser-manager');
    ({ getSpreadsheetTimeRange } = require('./automation/stop-finder'));
} catch (e) {
    dialog.showErrorBox(
        '程序初始化失败',
        `原生模块加载失败：${e.message}\n\n` +
        '最常见原因是系统缺少或未安装最新版 Microsoft Visual C++ 2015-2022 运行库（x64），\n' +
        '请从微软官网下载安装后重新运行本程序：\n' +
        'https://aka.ms/vs/17/release/vc_redist.x64.exe\n\n' +
        '（新版安装包已内置该运行库，重新安装本软件通常也可解决）'
    );
    process.exit(1);
}

// 跨平台打开目录：macOS 用 open 命令（能确保 Finder 弹出并置前）
function openDirInOS(dir) {
    const cmd = process.platform === 'darwin' ? `open "${dir}"`
        : process.platform === 'win32' ? `explorer "${dir}"`
        : `xdg-open "${dir}"`;
    return new Promise((resolve) => {
        exec(cmd, (err, stdout, stderr) => resolve(err ? (stderr || err.message) : ''));
    });
}

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 680,
        height: 760,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// 读取表格首末行 GPS 时间，供渲染进程自动填充查询条件
ipcMain.handle('get-spreadsheet-range', async (event, filePath) => {
    try {
        return getSpreadsheetTimeRange(filePath);
    } catch (e) {
        return { error: e.message };
    }
});

// 监听来自渲染进程的“开始”请求
ipcMain.handle('start-automation', async (event, payload) => {
    // 将日志发送到渲染进程
    const log = (message) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('log-message', message);
        }
    };

    // 输出目录可以动态设置，例如使用 app.getPath('documents')
    const outputDir = path.join(app.getPath('documents'), 'AlarmAutomationOutput');

    const { plate, startDate, endDate, alarmTypes, riskLevels, repairStatus, spreadsheetPath, faceThreshold } = payload;
    const result = await runAutomation({ outputDir, plate, startDate, endDate, alarmTypes, riskLevels, repairStatus, spreadsheetPath, faceThreshold }, log);
    // 任务完成后自动打开保存目录（优先打开实际保存人脸的“车牌_日期”子目录）
    if (result.success && result.outputDir) {
        const openDir = (result.savedDirs && result.savedDirs.length)
            ? result.savedDirs[result.savedDirs.length - 1]
            : result.outputDir;
        try {
            fs.ensureDirSync(openDir);
            const err = await openDirInOS(openDir);
            if (err) log(`自动打开保存目录失败: ${err}`);
            else log(`已打开保存目录: ${openDir}`);
        } catch (e) {
            log(`自动打开保存目录出错: ${e.message}`);
        }
    }
    return result;
});

// 单实例锁：防止重复打开（如 Windows 双击两次）导致浏览器登录态目录被占用
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(createWindow);

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });

    // 退出应用时兜底关闭浏览器，避免 Chrome 残留
    app.on('before-quit', () => {
        BrowserManager.close();
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
}