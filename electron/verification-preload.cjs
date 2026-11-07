const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('verification', {
  refresh: () => ipcRenderer.invoke('verification:refresh'),
  pause: () => ipcRenderer.invoke('verification:pause'),
  onStatus: (callback) => ipcRenderer.on('verification:status', (_event, message) => callback(String(message)))
});
