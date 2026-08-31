import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('kuaYipu', {
  loadCredentials: () => ipcRenderer.invoke('credentials:load'),
  clearCredentials: () => ipcRenderer.invoke('credentials:clear'),
  login: (payload) => ipcRenderer.invoke('auth:login', payload),
  enter: () => ipcRenderer.invoke('auth:enter'),
  session: () => ipcRenderer.invoke('auth:session'),
  heartbeat: () => ipcRenderer.invoke('auth:heartbeat')
});
