const { app, BrowserWindow, ipcMain } = require('electron');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const { runAutomation } = require('./automation/index');
const BrowserManager = require('./automation/browser-manager');
const { getSpreadsheetTimeRange } = require('./automation/stop-finder');

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

    const { plate, startDate, endDate, alarmTypes, riskLevels, repairStatus, spreadsheetPath, headless } = payload;
    const result = await runAutomation({ outputDir, plate, startDate, endDate, alarmTypes, riskLevels, repairStatus, spreadsheetPath, headless }, log);
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