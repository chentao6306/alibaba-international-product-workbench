const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('crossEasyShop', {
  version: '1.0.0',
  desktop: true,
  alibabaLogin: (payload) => ipcRenderer.invoke('auth:alibaba-login', payload),
  quit: () => ipcRenderer.invoke('app:quit')
});
