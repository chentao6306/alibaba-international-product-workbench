const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kuaYipu', {
  loadCredentials: () => ipcRenderer.invoke('credentials:load'),
  clearCredentials: () => ipcRenderer.invoke('credentials:clear'),
  activationStatus: (username) => ipcRenderer.invoke('activation:status', username),
  login: (payload) => ipcRenderer.invoke('auth:login', payload),
  enter: () => ipcRenderer.invoke('auth:enter'),
  session: () => ipcRenderer.invoke('auth:session'),
  heartbeat: () => ipcRenderer.invoke('auth:heartbeat'),
  openSource: (url) => ipcRenderer.invoke('alibaba:open-source', url)
});
