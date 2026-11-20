const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('minarbotDesktop', Object.freeze({
  appVersion: () => ipcRenderer.invoke('app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
}));
