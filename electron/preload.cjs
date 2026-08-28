const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('crossEasyShop', {
  version: '1.0.0',
  desktop: true
});
