const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voicetype', {
  setSoap: (on) => ipcRenderer.send('soap-toggle', on),
  setSkill: (idx) => ipcRenderer.send('skill-select', idx),
  pushToTalkStart: () => ipcRenderer.send('push-to-talk-start'),
  pushToTalkStop: () => ipcRenderer.send('push-to-talk-stop'),
  // Browser-based audio recording (fallback when SoX is not installed)
  sendAudioData: (wavArrayBuffer) => ipcRenderer.send('browser-audio-data', wavArrayBuffer),
  onStartBrowserRecording: (cb) => ipcRenderer.on('start-browser-recording', cb),
  onStopBrowserRecording: (cb) => ipcRenderer.on('stop-browser-recording', cb)
});
