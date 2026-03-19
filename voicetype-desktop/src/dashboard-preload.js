const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dashboard', {
  openLinkBoard: () => ipcRenderer.send('dashboard-open-linkboard'),
  refreshSettings: () => ipcRenderer.send('dashboard-refresh-settings'),
  toggleAutoSubmit: (on) => ipcRenderer.send('dashboard-toggle-autosubmit', on),
  selectSkill: (idx) => ipcRenderer.send('dashboard-select-skill', idx),
  togglePill: (on) => ipcRenderer.send('dashboard-toggle-pill', on),
  quitApp: () => ipcRenderer.send('dashboard-quit')
});
