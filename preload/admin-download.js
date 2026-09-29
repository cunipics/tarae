const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('fcmsDownloads', {
    saveResultJson: payload => ipcRenderer.invoke('save-result-json', payload)
  });
}
