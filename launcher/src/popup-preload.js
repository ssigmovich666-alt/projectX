const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('popup', {
  onNotify: callback => ipcRenderer.on('popup:notify', (_event, value) => callback(value)),
  onTheme: callback => ipcRenderer.on('popup:theme', (_event, value) => callback(value)),
  resize: height => ipcRenderer.send('popup:resize', height),
  open: event => ipcRenderer.send('popup:open', event)
});
