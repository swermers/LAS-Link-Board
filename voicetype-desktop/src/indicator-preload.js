const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voicetype', {
  setSoap: (on) => ipcRenderer.send('soap-toggle', on),
  setSkill: (idx) => ipcRenderer.send('skill-select', idx),
  pushToTalkStart: () => ipcRenderer.send('push-to-talk-start'),
  pushToTalkStop: () => ipcRenderer.send('push-to-talk-stop'),
  hidePill: () => ipcRenderer.send('indicator-hide'),
  // Resize window for dropdown open/close
  resizePill: (width, height) => ipcRenderer.send('indicator-resize', width, height),
  // Browser-based audio recording (fallback when SoX is not installed)
  sendAudioData: (wavArrayBuffer) => ipcRenderer.send('browser-audio-data', wavArrayBuffer),
  onStartBrowserRecording: (cb) => ipcRenderer.on('start-browser-recording', cb),
  onStopBrowserRecording: (cb) => ipcRenderer.on('stop-browser-recording', cb),
  // Voice Notes mode
  toggleVoiceNotesMode: () => ipcRenderer.send('toggle-voice-notes-mode'),
  onVoiceNotesModeChanged: (cb) => ipcRenderer.on('voice-notes-mode-changed', (_e, enabled) => cb(enabled))
});
