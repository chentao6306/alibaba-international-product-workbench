const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kuaYipu', {
  loadCredentials: () => ipcRenderer.invoke('credentials:load'),
  clearCredentials: () => ipcRenderer.invoke('credentials:clear'),
  activationStatus: (username) => ipcRenderer.invoke('activation:status', username),
  login: (payload) => ipcRenderer.invoke('auth:login', payload),
  onLoginStatus: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('auth:login-status', listener);
    return () => ipcRenderer.removeListener('auth:login-status', listener);
  },
  enter: () => ipcRenderer.invoke('auth:enter'),
  session: () => ipcRenderer.invoke('auth:session'),
  heartbeat: () => ipcRenderer.invoke('auth:heartbeat'),
  showLogin: () => ipcRenderer.invoke('auth:show-login'),
  connection: () => ipcRenderer.invoke('auth:connection'),
  updateState: () => ipcRenderer.invoke('update:state'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  cancelUpdate: () => ipcRenderer.invoke('update:cancel'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openSource: (url) => ipcRenderer.invoke('alibaba:open-source', url)
});
