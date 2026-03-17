const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voicetype', {
  setSoap: (on) => ipcRenderer.send('soap-toggle', on)
});
