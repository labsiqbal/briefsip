const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('briefsipDesktop', Object.freeze({
  appVersion: () => ipcRenderer.invoke('app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
}));
