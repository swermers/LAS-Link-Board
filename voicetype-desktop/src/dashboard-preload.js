const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dashboard', {
  openLinkBoard: () => ipcRenderer.send('dashboard-open-linkboard'),
  refreshSettings: () => ipcRenderer.send('dashboard-refresh-settings'),
  toggleAutoSubmit: (on) => ipcRenderer.send('dashboard-toggle-autosubmit', on),
  selectSkill: (idx) => ipcRenderer.send('dashboard-select-skill', idx),
  togglePill: (on) => ipcRenderer.send('dashboard-toggle-pill', on),
  setMode: (mode) => ipcRenderer.send('dashboard-set-mode', mode),
  quitApp: () => ipcRenderer.send('dashboard-quit'),

  // Skill CRUD
  createSkill: (skill) => ipcRenderer.invoke('dashboard-create-skill', skill),
  updateSkill: (skill) => ipcRenderer.invoke('dashboard-update-skill', skill),
  deleteSkill: (id) => ipcRenderer.invoke('dashboard-delete-skill', id),

  // Listen for skill updates (from periodic sync)
  onSkillsUpdated: (callback) => ipcRenderer.on('skills-updated', (_e, skills) => callback(skills))
});
