const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    startAutomation: (payload) => ipcRenderer.invoke('start-automation', payload),
    onLogMessage: (callback) => ipcRenderer.on('log-message', (event, message) => callback(message)),
    // 获取本地文件绝对路径（Electron 32+ 用 webUtils.getPathForFile 替代 File.path）
    getFilePath: (file) => webUtils.getPathForFile(file),
    // 读取表格首末行 GPS 时间（用于自动填充查询条件）
    getSpreadsheetRange: (filePath) => ipcRenderer.invoke('get-spreadsheet-range', filePath),
    // ===== 导出申诉表格 =====
    exportComplaintTables: (limit) => ipcRenderer.invoke('export-complaint-tables', { limit: limit || 0 }),
    onExportLogMessage: (callback) => ipcRenderer.on('export-log-message', (event, message) => callback(message)),
    onExportProgress: (callback) => ipcRenderer.on('export-progress', (event, progress) => callback(progress)),
    // 将导出的表格另存到用户指定位置
    saveExportedFile: (srcPath, suggestedName) => ipcRenderer.invoke('save-exported-file', { srcPath, suggestedName }),
    // 打开输出目录
    openOutputDir: (dir) => ipcRenderer.invoke('open-output-dir', dir)
});
