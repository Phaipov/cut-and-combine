const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  sourcePath: file => file.path || webUtils?.getPathForFile(file) || '',
  saveCutFiles: (sourcePath, files) => ipcRenderer.invoke('save-cut-files', sourcePath, files),
  openSourceFolder: sourcePath => ipcRenderer.invoke('open-source-folder', sourcePath)
});
