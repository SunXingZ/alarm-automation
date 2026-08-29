const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    startAutomation: (payload) => ipcRenderer.invoke('start-automation', payload),
    onLogMessage: (callback) => ipcRenderer.on('log-message', (event, message) => callback(message))
});
