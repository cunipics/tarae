const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('fcmsDownloads', {
    saveResultJson: payload => ipcRenderer.invoke('save-result-json', payload)
  });

  contextBridge.exposeInMainWorld('taraeUpdater', {
    getStatus: () => ipcRenderer.invoke('updater:get-status'),
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    openReleases: () => ipcRenderer.invoke('updater:open-releases'),
    onStatus: callback => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('updater:status', listener);
      return () => ipcRenderer.removeListener('updater:status', listener);
    }
  });
}
