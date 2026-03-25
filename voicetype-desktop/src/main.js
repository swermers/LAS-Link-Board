// ═══════════════════════════════════════
//  VoiceType — Electron Main Process
// ═══════════════════════════════════════

const { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain, screen, session, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { registerHotkey, unregisterAll } = require('./hotkey');
const { syncSettings, saveSettings, storeAuth } = require('./sync');
const { startRecording, stopRecording, checkSoxInstalled, onBrowserAudioData, isBrowserRecording } = require('./recorder');
const { transcribe } = require('./whisper');
const { injectText } = require('./injector');
const { showLoginWindow } = require('./login');
const localWhisper = require('./local-whisper');
const { processTranscription, PRESET_SKILLS } = require('./skill-formatter');
const { isWhisperCppAvailable } = require('./whisper');
const Store = require('electron-store');

const store = new Store({ name: 'voicetype-config' });
let tray = null;
let indicatorWindow = null;
let dashboardWindow = null;
let isRecording = false;
let settings = null;
let userSkills = [];       // user's skill list from Supabase
let selectedSkillIdx = 0;  // index into userSkills for the indicator selector
let pillSkillOverride = false; // true when user explicitly picked a skill on the pill

// Prevent multiple instances — if another instance launches, focus this one
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); } else {
  app.on('second-instance', () => {
    // User tried to open the app again — show the dashboard
    openDashboard();
  });
}

app.on('ready', async () => {
  // Hide dock icon on macOS — shows when dashboard is open
  if (process.platform === 'darwin') {
    app.dock.hide();
  }

  // Auto-grant microphone permission for browser-based recording fallback
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') { callback(true); return; }
    callback(true);
  });

  // Request microphone permission on macOS (required for recording)
  if (process.platform === 'darwin') {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    if (micStatus !== 'granted') {
      await systemPreferences.askForMediaAccess('microphone');
    }
  }

  createTray();
  createIndicatorWindow();
  createDashboardWindow();

  // Check if user is logged in — show login window if not
  const hasToken = store.get('supabase_token') && store.get('user_id');
  if (!hasToken) {
    updateTrayMenu('Awaiting login...');
    try {
      const auth = await showLoginWindow();
      storeAuth(store, auth);
    } catch (e) {
      // User closed login window — continue with defaults
      console.log('Login skipped:', e.message);
    }
  }

  // Load settings and skills from Supabase (or local cache)
  try {
    settings = await syncSettings(store);
    if (settings && settings.hotkey) {
      registerHotkey(settings.hotkey, onHotkeyDown, onHotkeyUp);
    } else {
      registerHotkey('CommandOrControl+Shift+Space', onHotkeyDown, onHotkeyUp);
    }
    // Sync skills and start periodic auto-sync
    await syncSkills();
    startSkillAutoSync();
    updateTrayMenu('Ready');
  } catch (e) {
    console.error('Failed to load settings:', e.message);
    registerHotkey('CommandOrControl+Shift+Space', onHotkeyDown, onHotkeyUp);
    updateTrayMenu('Ready (offline)');
  }

  // Refresh dashboard with latest auth and settings state
  openDashboard();

  // Show the floating push-to-talk button (always visible)
  showFloatingButton();
});

app.on('will-quit', () => {
  stopSkillAutoSync();
  unregisterAll();
});

// Don't quit when all windows close (tray app)
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

// macOS: re-show the app when clicking the dock icon
app.on('activate', () => {
  if (indicatorWindow) {
    showFloatingButton();
  } else {
    createIndicatorWindow();
    showFloatingButton();
  }
  openDashboard();
});

// ─── Tray ───

function createTray() {
  // Use a simple 16x16 template image for the tray
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA' +
    'RklEQVQ4y2NgGAXDAvz//58BH2ZiIBMMaoP+E2MAPgMYSHUB0W4gxgBiXUC0G4g2gFgX' +
    'EG0AsS4g2gBiXUCKAcT4YhQMPAAAJjYJEa3jPFoAAAAASUVORK5CYII='
  );
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('VoiceType');
  updateTrayMenu('Starting...');
}

function updateTrayMenu(statusText) {
  const menu = Menu.buildFromTemplate([
    { label: 'VoiceType', enabled: false },
    { type: 'separator' },
    { label: `Status: ${statusText}`, enabled: false },
    { label: `Hotkey: ${formatHotkey(settings?.hotkey)}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Refresh Settings',
      click: async () => {
        try {
          settings = await syncSettings(store);
          await syncSkills();
          unregisterAll();
          registerHotkey(settings?.hotkey || 'CommandOrControl+Shift+Space', onHotkeyDown, onHotkeyUp);
          updateTrayMenu('Ready');
        } catch (e) {
          updateTrayMenu('Sync failed');
        }
      }
    },
    {
      label: 'Mode: ' + ({ local: 'Local (HIPAA)', groq: 'Groq (Fast)', cloud: 'Cloud' }[settings?.transcription_mode] || 'Cloud'),
      enabled: false
    },
    {
      label: localWhisper.isModelDownloaded()
        ? 'Local Model: Downloaded (' + localWhisper.getModelSize() + ' MB)'
        : 'Download Local Model (~150 MB)',
      click: async () => {
        if (localWhisper.isModelDownloaded()) return;
        updateTrayMenu('Downloading model...');
        try {
          localWhisper.onProgress((data) => {
            if (data.status === 'progress' && data.progress) {
              updateTrayMenu('Model: ' + Math.round(data.progress) + '%');
            }
          });
          await localWhisper.loadPipeline();
          updateTrayMenu('Ready');
        } catch (e) {
          console.error('Model download failed:', e);
          updateTrayMenu('Download failed');
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Open Dashboard',
      click: () => { openDashboard(); }
    },
    {
      label: 'Open LinkBoard (Web)',
      click: () => {
        const { shell } = require('electron');
        shell.openExternal('https://las-link-board.vercel.app');
      }
    },
    {
      label: store.get('user_id') ? 'Sign Out' : 'Sign In',
      click: async () => {
        if (store.get('user_id')) {
          const { clearAuth } = require('./sync');
          clearAuth(store);
          settings = null;
          updateTrayMenu('Signed out');
          openDashboard();
        } else {
          try {
            const auth = await showLoginWindow();
            storeAuth(store, auth);
            settings = await syncSettings(store);
            await syncSkills();
            unregisterAll();
            registerHotkey(settings?.hotkey || 'CommandOrControl+Shift+Space', onHotkeyDown, onHotkeyUp);
            updateTrayMenu('Ready');
            openDashboard();
          } catch (e) {
            // Login window closed
          }
        }
      }
    },
    {
      label: indicatorWindow && indicatorWindow.isVisible() ? 'Hide Floating Pill' : 'Show Floating Pill',
      click: () => {
        if (indicatorWindow && indicatorWindow.isVisible()) {
          indicatorWindow.hide();
        } else {
          showFloatingButton();
        }
        updateTrayMenu(statusText);
      }
    },
    { type: 'separator' },
    { label: 'Quit VoiceType', click: () => {
        // Destroy all windows so the app fully exits
        if (indicatorWindow) { indicatorWindow.destroy(); indicatorWindow = null; }
        if (dashboardWindow) { dashboardWindow.removeAllListeners('close'); dashboardWindow.destroy(); dashboardWindow = null; }
        if (tray) { tray.destroy(); tray = null; }
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
}

function formatHotkey(key) {
  if (!key) return 'Ctrl/Cmd+Shift+Space';
  return key.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl')
    .replace(/\+/g, ' + ');
}

// ─── Floating Push-to-Talk Button (always visible) ───

function createIndicatorWindow() {
  indicatorWindow = new BrowserWindow({
    width: 220,
    height: 54,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'indicator-preload.js')
    }
  });

  // Write indicator HTML to a temp file so it loads from file:// (a secure context).
  // data: URLs are NOT secure contexts, so navigator.mediaDevices.getUserMedia
  // is unavailable — this broke browser-based microphone recording.
  const indicatorHTML = `
    <!DOCTYPE html>
    <html>
    <head><style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
        height: 100vh; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        background: transparent; user-select: none;
        overflow: hidden;
      }
      .container {
        display: flex; flex-direction: column; align-items: center; gap: 4px;
        position: relative;
      }

      /* ── Skill Dropdown (appears above pill) ── */
      .skill-menu {
        display: none; flex-direction: column; gap: 2px;
        background: rgba(11,37,69,0.97); border-radius: 12px;
        padding: 6px; width: 220px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        max-height: 180px; overflow-y: auto;
      }
      .skill-menu.open { display: flex; }
      .skill-menu-item {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 10px; border-radius: 8px;
        cursor: pointer; transition: background 0.15s;
        -webkit-app-region: no-drag;
      }
      .skill-menu-item:hover { background: rgba(26,122,109,0.3); }
      .skill-menu-item.active { background: rgba(26,122,109,0.5); }
      .skill-menu-item .smi-name {
        font-size: 12px; font-weight: 600; color: #fff;
      }
      .skill-menu-item .smi-cat {
        font-size: 9px; font-weight: 600; color: #5CEAD8;
        background: rgba(26,122,109,0.3); border-radius: 3px;
        padding: 1px 5px; margin-left: auto; text-transform: uppercase;
      }

      /* ── Main Pill ── */
      .pill {
        display: flex; align-items: center; gap: 8px;
        background: rgba(11,37,69,0.95); color: #fff;
        border-radius: 24px; padding: 8px 14px; height: 44px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        transition: all 0.2s ease;
        -webkit-app-region: drag;
      }

      /* ── Mic Button ── */
      .mic-btn {
        width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        border: none; cursor: pointer; transition: all 0.15s ease;
        -webkit-app-region: no-drag;
      }
      .mic-btn.idle { background: #1A7A6D; }
      .mic-btn.idle:hover { background: #24a08e; transform: scale(1.08); }
      .mic-btn.recording { background: #e74c3c; animation: pulse 1s ease-in-out infinite; }
      .mic-btn.processing { background: #1A7A6D; animation: spin 1s linear infinite; pointer-events: none; }
      .mic-btn.done { background: #1A7A6D; animation: none; }
      .mic-btn svg { width: 16px; height: 16px; fill: #fff; pointer-events: none; }
      @keyframes pulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(0.9); opacity: 0.6; } }
      @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

      /* ── Label ── */
      .label {
        font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
        white-space: nowrap; overflow: hidden;
        max-width: 0; opacity: 0;
        transition: max-width 0.3s ease, opacity 0.2s ease;
      }
      .label.visible { max-width: 120px; opacity: 1; }

      /* ── Skill Tag (click to open dropdown) ── */
      .skill-tag {
        font-size: 10px; font-weight: 700; color: #5CEAD8;
        background: rgba(26,122,109,0.4); border-radius: 4px;
        padding: 3px 8px; white-space: nowrap; cursor: pointer;
        -webkit-app-region: no-drag; transition: all 0.15s ease;
        max-width: 80px; overflow: hidden; text-overflow: ellipsis;
      }
      .skill-tag:hover { background: rgba(26,122,109,0.7); }

      /* ── Waveform ── */
      .waveform {
        display: none; align-items: center; gap: 2px; height: 16px;
      }
      .waveform.visible { display: flex; }
      .waveform .bar {
        width: 3px; border-radius: 2px; background: #5CEAD8;
        animation: wave 0.6s ease-in-out infinite;
      }
      .waveform .bar:nth-child(1) { height: 6px; animation-delay: 0s; }
      .waveform .bar:nth-child(2) { height: 12px; animation-delay: 0.1s; }
      .waveform .bar:nth-child(3) { height: 8px; animation-delay: 0.2s; }
      .waveform .bar:nth-child(4) { height: 14px; animation-delay: 0.3s; }
      .waveform .bar:nth-child(5) { height: 6px; animation-delay: 0.4s; }
      @keyframes wave {
        0%,100% { transform: scaleY(1); } 50% { transform: scaleY(0.4); }
      }

      /* ── Close Button ── */
      .close-btn {
        position: absolute; top: 2px; right: 2px;
        width: 16px; height: 16px; border-radius: 50%;
        background: rgba(255,255,255,0.15); border: none;
        color: rgba(255,255,255,0.6); font-size: 10px; line-height: 16px;
        text-align: center; cursor: pointer;
        opacity: 0; transition: opacity 0.2s, background 0.15s;
        -webkit-app-region: no-drag; z-index: 10;
        display: flex; align-items: center; justify-content: center;
      }
      .container:hover .close-btn { opacity: 1; }
      .close-btn:hover { background: rgba(231,76,60,0.8); color: #fff; }

      /* ── Tooltip (hidden by default, only shown briefly) ── */
      .tooltip {
        font-size: 10px; color: rgba(255,255,255,0.5);
        text-align: center; transition: opacity 0.2s;
        position: absolute; bottom: -14px; white-space: nowrap;
        pointer-events: none; display: none;
      }
    </style></head>
    <body>
      <div class="container" id="container">
        <!-- Close Button -->
        <button class="close-btn" id="closeBtn" onclick="closePill()" title="Hide pill (reopen from tray icon)">&#x2715;</button>

        <!-- Skill Dropdown (pops up above the pill) -->
        <div class="skill-menu" id="skillMenu"></div>

        <!-- Main Pill -->
        <div class="pill" id="pill">
          <button class="mic-btn idle" id="micBtn"
                  onmousedown="onMicDown(event)" onmouseup="onMicUp(event)" onmouseleave="onMicLeave(event)">
            <svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
          </button>
          <div class="waveform" id="waveform">
            <div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div>
          </div>
          <div class="label" id="label"></div>
          <div class="skill-tag" id="skillTag" onclick="toggleSkillMenu(event)">Raw</div>
        </div>

        <div class="tooltip" id="tooltip">Click mic to record</div>
      </div>

      <script>
        let skills = [];
        let currentIdx = 0;
        let menuOpen = false;
        let isRecordingState = false;

        function setSkills(list, activeIdx) {
          skills = list || [];
          currentIdx = activeIdx || 0;
          updateSkillTag();
          buildSkillMenu();
        }

        function buildSkillMenu() {
          const menu = document.getElementById('skillMenu');
          menu.innerHTML = '';
          skills.forEach((s, i) => {
            const item = document.createElement('div');
            item.className = 'skill-menu-item' + (i === currentIdx ? ' active' : '');
            item.innerHTML = '<span class="smi-name">' + (s.name || 'Raw') + '</span>' +
              (s.category ? '<span class="smi-cat">' + s.category + '</span>' : '');
            item.addEventListener('click', (e) => {
              e.stopPropagation();
              selectSkill(i);
              closeSkillMenu();
            });
            menu.appendChild(item);
          });
        }

        function selectSkill(idx) {
          currentIdx = idx;
          updateSkillTag();
          buildSkillMenu();
          if (window.voicetype) window.voicetype.setSkill(idx);
        }

        function toggleSkillMenu(e) {
          if (e) e.stopPropagation();
          if (isRecordingState) return; // don't open menu while recording
          menuOpen = !menuOpen;
          document.getElementById('skillMenu').classList.toggle('open', menuOpen);
          // Expand window to fit dropdown, or shrink back
          if (menuOpen) {
            var menuH = Math.min(skills.length * 36 + 16, 200);
            if (window.voicetype) window.voicetype.resizePill(220, 54 + menuH + 4);
          } else {
            if (window.voicetype) window.voicetype.resizePill(220, 54);
          }
        }

        function closeSkillMenu() {
          menuOpen = false;
          document.getElementById('skillMenu').classList.remove('open');
          if (window.voicetype) window.voicetype.resizePill(220, 54);
        }

        function updateSkillTag() {
          const tag = document.getElementById('skillTag');
          const skill = skills[currentIdx];
          tag.textContent = (skill && skill.name) ? skill.name : 'Raw';
        }

        // ── Mic Button (click-to-toggle) ──
        function onMicDown(e) {
          if (e.button !== 0) return; // left click only
          e.preventDefault();
          if (isRecordingState) {
            // Stop recording
            if (window.voicetype) window.voicetype.pushToTalkStop();
          } else {
            // Start recording
            closeSkillMenu();
            if (window.voicetype) window.voicetype.pushToTalkStart();
          }
        }

        function onMicUp(e) {
          // no-op: we use click-to-toggle now
        }

        function onMicLeave(e) {
          // no-op: we use click-to-toggle now
        }

        // Close/hide the floating pill
        function closePill() {
          if (window.voicetype) window.voicetype.hidePill();
        }

        // Close menu when clicking outside
        document.addEventListener('click', (e) => {
          if (menuOpen && !e.target.closest('.skill-menu') && !e.target.closest('.skill-tag')) {
            closeSkillMenu();
          }
        });

        function setState(state, labelText, showSkill) {
          const btn = document.getElementById('micBtn');
          const label = document.getElementById('label');
          const tag = document.getElementById('skillTag');
          const wave = document.getElementById('waveform');
          const tooltip = document.getElementById('tooltip');

          btn.className = 'mic-btn ' + state;
          label.textContent = labelText || '';
          label.classList.toggle('visible', !!labelText);
          wave.classList.toggle('visible', state === 'recording');

          isRecordingState = (state === 'recording');

          if (state === 'idle') {
            tooltip.textContent = 'Click mic to record';
            tooltip.style.opacity = '1';
          } else if (state === 'recording') {
            tooltip.textContent = 'Click to stop';
            tooltip.style.opacity = '1';
          } else if (state === 'processing') {
            tooltip.textContent = '';
            tooltip.style.opacity = '0';
          } else if (state === 'done') {
            tooltip.textContent = 'Pasted to clipboard';
            tooltip.style.opacity = '1';
          }
        }

        // ── Browser-based audio recording (fallback when SoX not installed) ──
        // Pre-warm the microphone stream so recording starts instantly.
        let micStream = null;        // persistent getUserMedia stream
        let mediaRecorder = null;
        let browserChunks = [];
        let audioCtx = null;

        // Pre-initialise mic stream on page load so first recording has no delay
        (async () => {
          try {
            micStream = await navigator.mediaDevices.getUserMedia({
              audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true }
            });
          } catch (err) {
            console.warn('Mic pre-init failed (will retry on first recording):', err);
          }
        })();

        if (window.voicetype && window.voicetype.onStartBrowserRecording) {
          window.voicetype.onStartBrowserRecording(async () => {
            try {
              // Re-acquire stream if it was lost or never obtained
              if (!micStream || micStream.getTracks().every(t => t.readyState === 'ended')) {
                micStream = await navigator.mediaDevices.getUserMedia({
                  audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true }
                });
              }
              browserChunks = [];
              mediaRecorder = new MediaRecorder(micStream, { mimeType: 'audio/webm;codecs=opus' });
              mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) browserChunks.push(e.data); };
              mediaRecorder.start(100); // collect in 100ms chunks
            } catch (err) {
              console.error('Browser recording failed:', err);
            }
          });

          window.voicetype.onStopBrowserRecording(async () => {
            if (!mediaRecorder || mediaRecorder.state === 'inactive') {
              window.voicetype.sendAudioData(null);
              return;
            }
            mediaRecorder.onstop = async () => {
              // Do NOT stop mic tracks — keep stream alive for next recording
              if (browserChunks.length === 0) { window.voicetype.sendAudioData(null); return; }

              const webmBlob = new Blob(browserChunks, { type: 'audio/webm' });
              // Decode webm to raw PCM, then encode as WAV for Whisper
              try {
                if (!audioCtx) audioCtx = new AudioContext({ sampleRate: 16000 });
                const arrayBuf = await webmBlob.arrayBuffer();
                const audioBuf = await audioCtx.decodeAudioData(arrayBuf);
                const pcm = audioBuf.getChannelData(0); // Float32 mono
                // Convert Float32 to Int16 PCM
                const int16 = new Int16Array(pcm.length);
                for (let i = 0; i < pcm.length; i++) {
                  const s = Math.max(-1, Math.min(1, pcm[i]));
                  int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                // Build WAV
                const wavHeader = new ArrayBuffer(44);
                const view = new DataView(wavHeader);
                const sr = audioBuf.sampleRate;
                const dataSize = int16.byteLength;
                // RIFF header
                new Uint8Array(wavHeader, 0, 4).set([0x52,0x49,0x46,0x46]); // RIFF
                view.setUint32(4, 36 + dataSize, true);
                new Uint8Array(wavHeader, 8, 4).set([0x57,0x41,0x56,0x45]); // WAVE
                // fmt
                new Uint8Array(wavHeader, 12, 4).set([0x66,0x6d,0x74,0x20]); // fmt
                view.setUint32(16, 16, true);
                view.setUint16(20, 1, true); // PCM
                view.setUint16(22, 1, true); // mono
                view.setUint32(24, sr, true);
                view.setUint32(28, sr * 2, true); // byte rate
                view.setUint16(32, 2, true); // block align
                view.setUint16(34, 16, true); // bits per sample
                // data
                new Uint8Array(wavHeader, 36, 4).set([0x64,0x61,0x74,0x61]); // data
                view.setUint32(40, dataSize, true);
                // Combine header + PCM
                const wavBlob = new Blob([wavHeader, int16.buffer], { type: 'audio/wav' });
                const wavBuf = await wavBlob.arrayBuffer();
                window.voicetype.sendAudioData(wavBuf);
              } catch (decodeErr) {
                console.error('Audio decode error:', decodeErr);
                // Fallback: send the raw webm (Whisper can sometimes handle it)
                const rawBuf = await webmBlob.arrayBuffer();
                window.voicetype.sendAudioData(rawBuf);
              }
            };
            mediaRecorder.stop();
          });
        }
      </script>
    </body>
    </html>
  `;
  const indicatorTmpPath = path.join(os.tmpdir(), 'voicetype-indicator.html');
  fs.writeFileSync(indicatorTmpPath, indicatorHTML);
  indicatorWindow.loadFile(indicatorTmpPath);

  // Position at bottom-center of primary display (tight to the pill)
  const display = screen.getPrimaryDisplay();
  const x = Math.round(display.bounds.x + display.bounds.width / 2 - 110);
  const y = display.bounds.y + display.bounds.height - 80;
  indicatorWindow.setPosition(x, y);
}

function showIndicator(text, opts = {}) {
  if (!indicatorWindow) return;
  let state = 'idle';
  if (opts.recording) state = 'recording';
  else if (opts.processing) state = 'processing';
  else if (opts.done) state = 'done';

  const showSkill = opts.showSkill || false;
  indicatorWindow.webContents.executeJavaScript(
    `setState(${JSON.stringify(state)}, ${JSON.stringify(text)}, ${showSkill});`
  );
  indicatorWindow.showInactive();
}

function hideIndicator() {
  if (!indicatorWindow) return;
  // Return to idle state (floating button stays visible for push-to-talk)
  indicatorWindow.webContents.executeJavaScript(`setState('idle', '', false);`);
}

function showFloatingButton() {
  if (!indicatorWindow) return;
  // Send skills to indicator and show in idle state
  const skillList = userSkills.map(s => ({ name: s.name, category: s.category, system_prompt: !!s.system_prompt }));
  const defaultIdx = userSkills.findIndex(s => s.is_default);
  const activeIdx = defaultIdx >= 0 ? defaultIdx : 0;
  indicatorWindow.webContents.executeJavaScript(
    `setSkills(${JSON.stringify(skillList)}, ${activeIdx});`
  );
  indicatorWindow.webContents.executeJavaScript(`setState('idle', '', false);`);
  indicatorWindow.showInactive();
}

// ─── Full-Screen Dashboard Window ───

function createDashboardWindow() {
  dashboardWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0B2545',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'dashboard-preload.js')
    }
  });

  const dashboardTmpPath = path.join(os.tmpdir(), 'voicetype-dashboard.html');
  fs.writeFileSync(dashboardTmpPath, getDashboardHTML());
  dashboardWindow.loadFile(dashboardTmpPath);

  dashboardWindow.on('close', (e) => {
    e.preventDefault();
    dashboardWindow.hide();
    if (process.platform === 'darwin') app.dock.hide();
  });
}

function openDashboard() {
  if (!dashboardWindow) createDashboardWindow();
  if (process.platform === 'darwin') app.dock.show();

  // Send current state to dashboard
  dashboardWindow.webContents.executeJavaScript(`
    if (window.__updateDashboard) window.__updateDashboard(${JSON.stringify({
      settings: settings || {},
      skills: userSkills,
      hotkey: settings?.hotkey || 'CommandOrControl+Shift+Space',
      mode: settings?.transcription_mode || 'cloud',
      localModelReady: localWhisper.isModelDownloaded(),
      whisperCppReady: isWhisperCppAvailable(),
      isLoggedIn: !!store.get('user_id')
    })});
  `);

  dashboardWindow.show();
  dashboardWindow.focus();
}

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html>
<head>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0B2545; --surface: #0F3460; --surface2: #163A6A;
    --teal: #1A7A6D; --teal-light: #5CEAD8; --gold: #C5963B;
    --text: #FFFFFF; --text2: rgba(255,255,255,0.7); --text3: rgba(255,255,255,0.4);
    --border: rgba(255,255,255,0.1);
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif;
    background: var(--bg); color: var(--text); height: 100vh;
    display: flex; overflow: hidden;
  }

  /* Sidebar */
  .sidebar {
    width: 240px; background: rgba(0,0,0,0.2); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; padding-top: 52px;
  }
  .sidebar-header {
    padding: 20px 20px 16px; border-bottom: 1px solid var(--border);
  }
  .sidebar-header h1 {
    font-size: 18px; font-weight: 700; letter-spacing: -0.02em;
  }
  .sidebar-header .subtitle { font-size: 12px; color: var(--text3); margin-top: 2px; }
  .nav { flex: 1; padding: 12px 8px; }
  .nav-item {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    border-radius: 10px; cursor: pointer; font-size: 13px; font-weight: 500;
    color: var(--text2); transition: all 0.15s ease; margin-bottom: 2px;
  }
  .nav-item:hover { background: rgba(255,255,255,0.06); color: var(--text); }
  .nav-item.active { background: var(--teal); color: #fff; font-weight: 600; }
  .nav-item svg { width: 18px; height: 18px; opacity: 0.7; }
  .nav-item.active svg { opacity: 1; }
  .sidebar-footer {
    padding: 16px; border-top: 1px solid var(--border);
  }
  .btn-quit {
    margin-top: 12px; width: 100%; padding: 7px 12px; border-radius: 8px;
    font-size: 12px; font-weight: 600; cursor: pointer; border: 1px solid var(--border);
    background: transparent; color: var(--text3); transition: all 0.15s ease;
  }
  .btn-quit:hover { background: rgba(231,76,60,0.15); color: #e74c3c; border-color: rgba(231,76,60,0.3); }
  .status-badge {
    display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text2);
  }
  .status-dot {
    width: 8px; height: 8px; border-radius: 50%; background: #27ae60;
  }
  .status-dot.offline { background: #e74c3c; }

  /* Main Content */
  .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .main-header {
    padding: 52px 32px 0; display: flex; align-items: center; justify-content: space-between;
  }
  .main-header h2 { font-size: 24px; font-weight: 700; }
  .content { flex: 1; overflow-y: auto; padding: 24px 32px 32px; }

  /* Cards */
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 16px; padding: 24px; margin-bottom: 16px;
  }
  .card h3 { font-size: 15px; font-weight: 700; margin-bottom: 16px; }
  .card-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 0; border-bottom: 1px solid var(--border);
  }
  .card-row:last-child { border-bottom: none; }
  .card-row .label { font-size: 13px; color: var(--text2); }
  .card-row .value { font-size: 13px; font-weight: 600; }

  /* Hotkey Display */
  .hotkey-display {
    display: flex; gap: 6px; align-items: center;
  }
  .key {
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: 6px; padding: 4px 10px; font-size: 12px; font-weight: 600;
    font-family: 'SF Mono', monospace;
  }

  /* Skills Grid */
  .skills-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px; margin-top: 16px;
  }
  .skill-card {
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: 12px; padding: 16px; cursor: pointer;
    transition: all 0.15s ease;
  }
  .skill-card:hover { border-color: var(--teal); transform: translateY(-1px); }
  .skill-card.active { border-color: var(--teal-light); background: rgba(26,122,109,0.15); }
  .skill-card .skill-name { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
  .skill-card .skill-category {
    font-size: 11px; color: var(--teal-light); text-transform: uppercase;
    letter-spacing: 0.05em; font-weight: 700;
  }
  .skill-card .skill-desc {
    font-size: 12px; color: var(--text3); margin-top: 8px; line-height: 1.4;
  }

  /* Buttons */
  .btn {
    padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 600;
    cursor: pointer; border: none; transition: all 0.15s ease;
  }
  .btn-primary { background: var(--teal); color: #fff; }
  .btn-primary:hover { background: #1F8E7F; }
  .btn-ghost { background: transparent; color: var(--text2); border: 1px solid var(--border); }
  .btn-ghost:hover { background: rgba(255,255,255,0.06); }

  /* Toggle */
  .toggle {
    width: 44px; height: 24px; border-radius: 12px; background: rgba(255,255,255,0.15);
    cursor: pointer; position: relative; transition: background 0.2s;
  }
  .toggle.on { background: var(--teal); }
  .toggle::after {
    content: ''; position: absolute; width: 18px; height: 18px; border-radius: 50%;
    background: #fff; top: 3px; left: 3px; transition: transform 0.2s;
  }
  .toggle.on::after { transform: translateX(20px); }

  /* Page sections */
  .page { display: none; }
  .page.active { display: block; }

  /* Form inputs */
  input[type="text"]:focus, textarea:focus, select:focus {
    border-color: var(--teal) !important;
  }
  select option { background: var(--surface); color: var(--text); }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
</style>
</head>
<body>
  <div class="sidebar">
    <div class="sidebar-header">
      <h1>VoiceType</h1>
      <div class="subtitle">Desktop</div>
    </div>
    <div class="nav">
      <div class="nav-item active" data-page="home" onclick="showPage('home')">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
        Home
      </div>
      <div class="nav-item" data-page="skills" onclick="showPage('skills')">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L4.5 20.3l.7.3L12 18l6.8 2.6.7-.3z"/></svg>
        Skills
      </div>
      <div class="nav-item" data-page="settings" onclick="showPage('settings')">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.61 3.61 0 0112 15.6z"/></svg>
        Settings
      </div>
      <div class="nav-item" data-page="history" onclick="showPage('history')">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 3a9 9 0 00-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0013 21a9 9 0 000-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>
        History
      </div>
    </div>
    <div class="sidebar-footer">
      <div class="status-badge">
        <div class="status-dot" id="statusDot"></div>
        <span id="statusText">Ready</span>
      </div>
      <button class="btn-quit" onclick="quitApp()">Quit VoiceType</button>
    </div>
  </div>

  <div class="main">
    <!-- HOME -->
    <div class="page active" id="page-home">
      <div class="main-header"><h2>Home</h2></div>
      <div class="content">
        <div class="card">
          <h3>Quick Start</h3>
          <div class="card-row">
            <span class="label">Hotkey</span>
            <div class="hotkey-display" id="hotkeyDisplay">
              <span class="key">Cmd</span><span class="key">Shift</span><span class="key">Space</span>
            </div>
          </div>
          <div class="card-row">
            <span class="label">Active Skill</span>
            <span class="value" id="activeSkill" style="color: var(--teal-light)">Raw Transcript</span>
          </div>
          <div class="card-row">
            <span class="label">Transcription Mode</span>
            <span class="value" id="activeMode">Cloud</span>
          </div>
          <div class="card-row">
            <span class="label">Text Injection</span>
            <span class="value" style="color: var(--teal-light)">Paste at cursor + clipboard</span>
          </div>
        </div>
        <div class="card">
          <h3>How It Works</h3>
          <div class="card-row">
            <span class="label">1. Press hotkey to start recording</span>
          </div>
          <div class="card-row">
            <span class="label">2. Speak naturally — your selected skill reformats the text</span>
          </div>
          <div class="card-row">
            <span class="label">3. Text is injected at your cursor and copied to clipboard</span>
          </div>
          <div class="card-row">
            <span class="label">4. If injection fails, just Cmd+V to paste</span>
          </div>
        </div>
      </div>
    </div>

    <!-- SKILLS -->
    <div class="page" id="page-skills">
      <div class="main-header">
        <h2>Skills</h2>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-primary" onclick="showNewSkillEditor()">+ New Skill</button>
          <button class="btn btn-ghost" onclick="openLinkBoard()">Open LinkBoard</button>
        </div>
      </div>
      <div class="content">
        <div class="card">
          <h3>Active Skills</h3>
          <p style="font-size:13px; color:var(--text3); margin-bottom:4px;">
            Click a skill to set it as default. Click the edit icon to customize.
          </p>
          <p style="font-size:11px; color:var(--text3); margin-bottom:12px;">
            Changes sync automatically between desktop and web.
          </p>
          <div class="skills-grid" id="skillsGrid"></div>
        </div>

        <!-- Skill Editor (hidden by default) -->
        <div class="card" id="skillEditor" style="display:none;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
            <h3 id="editorTitle">Edit Skill</h3>
            <button class="btn btn-ghost" onclick="hideSkillEditor()" style="padding:4px 10px;font-size:12px;">Cancel</button>
          </div>
          <input type="hidden" id="editSkillId" />
          <div style="margin-bottom:12px;">
            <label style="font-size:12px;color:var(--text2);display:block;margin-bottom:4px;">Name</label>
            <input type="text" id="editSkillName" placeholder="e.g. Meeting Notes"
              style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);
              background:var(--surface2);color:var(--text);font-size:14px;outline:none;" />
          </div>
          <div style="margin-bottom:12px;">
            <label style="font-size:12px;color:var(--text2);display:block;margin-bottom:4px;">Category</label>
            <select id="editSkillCategory"
              style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);
              background:var(--surface2);color:var(--text);font-size:14px;outline:none;">
              <option value="email">Email</option>
              <option value="clinical">Clinical</option>
              <option value="chat">Chat</option>
              <option value="raw">Raw (no formatting)</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div style="margin-bottom:12px;">
            <label style="font-size:12px;color:var(--text2);display:block;margin-bottom:4px;">System Prompt</label>
            <textarea id="editSkillPrompt" rows="10" placeholder="Instructions for how to format the dictation..."
              style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);
              background:var(--surface2);color:var(--text);font-size:13px;line-height:1.5;
              outline:none;resize:vertical;font-family:inherit;"></textarea>
          </div>
          <div style="margin-bottom:16px;">
            <label style="font-size:12px;color:var(--text2);display:block;margin-bottom:4px;">Trigger Phrases (comma separated)</label>
            <input type="text" id="editSkillTriggers" placeholder="e.g. meeting notes, meeting summary"
              style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);
              background:var(--surface2);color:var(--text);font-size:14px;outline:none;" />
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-primary" id="editorSaveBtn" onclick="saveSkill()">Save</button>
            <button class="btn btn-ghost" id="editorDeleteBtn" onclick="deleteSkill()" style="display:none;color:#e74c3c;border-color:rgba(231,76,60,0.3);">Delete</button>
          </div>
          <div id="editorStatus" style="font-size:12px;margin-top:8px;color:var(--teal-light);display:none;"></div>
        </div>
      </div>
    </div>

    <!-- SETTINGS -->
    <div class="page" id="page-settings">
      <div class="main-header"><h2>Settings</h2></div>
      <div class="content">
        <div class="card">
          <h3>Recording</h3>
          <div class="card-row">
            <span class="label">Hotkey</span>
            <div class="hotkey-display" id="settingsHotkey">
              <span class="key">Cmd</span><span class="key">Shift</span><span class="key">Space</span>
            </div>
          </div>
          <div class="card-row">
            <span class="label">Language</span>
            <span class="value" id="settingsLang">en</span>
          </div>
          <div class="card-row">
            <span class="label">Auto-Submit (press Enter after paste)</span>
            <div class="toggle" id="autoSubmitToggle" onclick="toggleAutoSubmit()"></div>
          </div>
        </div>
        <div class="card">
          <h3>Transcription</h3>
          <div class="card-row">
            <span class="label">Mode</span>
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="value" id="settingsMode" style="min-width:80px">Cloud</span>
              <button class="btn btn-ghost" id="modeToggleBtn" onclick="cycleMode()" style="padding:5px 12px;font-size:12px;">Switch to Groq (Fast)</button>
            </div>
          </div>
          <div class="card-row">
            <span class="label">Local Engine Status</span>
            <span class="value" id="localModelStatus">Not installed</span>
          </div>
          <div id="modeHint" style="font-size:11px;color:var(--text3);padding:8px 0 0;line-height:1.5;display:none;"></div>
        </div>
        <div class="card">
          <h3>Interface</h3>
          <div class="card-row">
            <span class="label">Floating Pill (push-to-talk button)</span>
            <div class="toggle on" id="pillToggle" onclick="togglePill()"></div>
          </div>
        </div>
        <div class="card">
          <h3>Injection</h3>
          <div class="card-row">
            <span class="label">Method</span>
            <span class="value">Clipboard paste (Cmd/Ctrl+V simulation)</span>
          </div>
          <div class="card-row">
            <span class="label">Fallback</span>
            <span class="value" style="color: var(--text3)">Text always copied to clipboard</span>
          </div>
        </div>
        <div class="card" style="margin-top: 24px;">
          <div style="display:flex;gap:12px;">
            <button class="btn btn-primary" onclick="refreshSettings()">Refresh Settings</button>
            <button class="btn btn-ghost" onclick="openLinkBoard()">Open LinkBoard</button>
          </div>
        </div>
      </div>
    </div>

    <!-- HISTORY -->
    <div class="page" id="page-history">
      <div class="main-header"><h2>History</h2></div>
      <div class="content">
        <div class="card">
          <h3>Recent Transcriptions</h3>
          <p style="font-size:13px; color:var(--text3);">
            Usage history is available on your LinkBoard dashboard.
          </p>
          <div style="margin-top: 16px;">
            <button class="btn btn-primary" onclick="openLinkBoard()">View on LinkBoard</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    function showPage(name) {
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.getElementById('page-' + name).classList.add('active');
      document.querySelector('[data-page="' + name + '"]').classList.add('active');
    }

    function quitApp() {
      if (window.dashboard) window.dashboard.quitApp();
    }

    function togglePill() {
      const toggle = document.getElementById('pillToggle');
      toggle.classList.toggle('on');
      if (window.dashboard) window.dashboard.togglePill(toggle.classList.contains('on'));
    }

    var __currentMode = 'cloud';
    var __modeOrder = ['cloud', 'groq', 'local'];
    var __modeLabels = { cloud: 'Cloud (OpenAI)', groq: 'Groq (Fast)', local: 'Local (HIPAA)' };

    function cycleMode() {
      var idx = __modeOrder.indexOf(__currentMode);
      __currentMode = __modeOrder[(idx + 1) % __modeOrder.length];
      updateModeUI(__currentMode);
      if (window.dashboard) window.dashboard.setMode(__currentMode);
    }

    function updateModeUI(mode) {
      __currentMode = mode;
      var label = __modeLabels[mode] || 'Cloud (OpenAI)';
      var modeEl = document.getElementById('settingsMode');
      var activeEl = document.getElementById('activeMode');
      var btn = document.getElementById('modeToggleBtn');
      var hint = document.getElementById('modeHint');
      if (modeEl) modeEl.textContent = label;
      if (activeEl) activeEl.textContent = label;
      var nextIdx = (__modeOrder.indexOf(mode) + 1) % __modeOrder.length;
      if (btn) btn.textContent = 'Switch to ' + __modeLabels[__modeOrder[nextIdx]];
      if (hint) {
        if (mode === 'local') { hint.textContent = 'Local mode processes audio on-device via whisper.cpp (HIPAA-safe). Install: brew install whisper-cpp, then download a model.'; hint.style.display = 'block'; }
        else if (mode === 'groq') { hint.textContent = 'Groq uses custom LPU hardware for ultra-fast Whisper transcription (<500ms). Requires a free Groq API key from console.groq.com.'; hint.style.display = 'block'; }
        else { hint.textContent = ''; hint.style.display = 'none'; }
      }
    }

    function openLinkBoard() {
      if (window.dashboard) window.dashboard.openLinkBoard();
    }

    function refreshSettings() {
      if (window.dashboard) window.dashboard.refreshSettings();
    }

    function toggleAutoSubmit() {
      const toggle = document.getElementById('autoSubmitToggle');
      toggle.classList.toggle('on');
      if (window.dashboard) window.dashboard.toggleAutoSubmit(toggle.classList.contains('on'));
    }

    window.__updateDashboard = function(data) {
      // Hotkey
      const parts = (data.hotkey || 'Cmd+Shift+Space').replace('CommandOrControl', 'Cmd').split('+');
      ['hotkeyDisplay', 'settingsHotkey'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = parts.map(k => '<span class="key">' + k + '</span>').join('');
      });

      // Mode
      updateModeUI(data.mode || 'cloud');

      // Local model / whisper.cpp status
      const localEl = document.getElementById('localModelStatus');
      if (localEl) {
        if (data.whisperCppReady) {
          localEl.textContent = 'whisper.cpp ready (native Metal)';
          localEl.style.color = 'var(--teal-light)';
        } else if (data.localModelReady) {
          localEl.textContent = 'ONNX model ready (slower)';
          localEl.style.color = 'var(--gold)';
        } else {
          localEl.textContent = 'Not installed';
          localEl.style.color = 'var(--text3)';
        }
      }

      // Language
      const langEl = document.getElementById('settingsLang');
      if (langEl) langEl.textContent = data.settings.language || 'en';

      // Auto-submit
      const asToggle = document.getElementById('autoSubmitToggle');
      if (asToggle && data.settings.auto_submit) asToggle.classList.add('on');

      // Status
      const dot = document.getElementById('statusDot');
      const statusText = document.getElementById('statusText');
      if (data.isLoggedIn) {
        dot.classList.remove('offline');
        statusText.textContent = 'Ready';
      } else {
        dot.classList.add('offline');
        statusText.textContent = 'Not signed in';
      }

      // Skills
      window.__currentSkills = data.skills || [];
      renderSkillsGrid(data.skills);
    };

    function renderSkillsGrid(skills) {
      const grid = document.getElementById('skillsGrid');
      const activeSkillEl = document.getElementById('activeSkill');
      if (!grid || !skills) return;

      grid.innerHTML = skills.map((s, i) => {
        const isDefault = s.is_default;
        const editBtn = '<span onclick="event.stopPropagation();editSkill(' + i + ')" style="cursor:pointer;opacity:0.5;font-size:14px;position:absolute;top:10px;right:10px;" title="Edit">&#9998;</span>';
        return '<div class="skill-card ' + (isDefault ? 'active' : '') + '" onclick="selectSkill(' + i + ')" style="position:relative;">' +
          editBtn +
          '<div class="skill-name">' + (s.name || 'Unnamed') + '</div>' +
          '<div class="skill-category">' + (s.category || 'custom') + '</div>' +
          (s.system_prompt ? '<div class="skill-desc">' + escapeHtml(s.system_prompt.substring(0, 80)) + '...</div>' : '') +
        '</div>';
      }).join('');

      const defaultSkill = skills.find(s => s.is_default) || skills[0];
      if (activeSkillEl && defaultSkill) activeSkillEl.textContent = defaultSkill.name;
    }

    function escapeHtml(text) {
      const d = document.createElement('div');
      d.textContent = text;
      return d.innerHTML;
    }

    function selectSkill(idx) {
      if (window.dashboard) window.dashboard.selectSkill(idx);
    }

    // ─── Skill Editor ───

    function showNewSkillEditor() {
      document.getElementById('editSkillId').value = '';
      document.getElementById('editSkillName').value = '';
      document.getElementById('editSkillCategory').value = 'custom';
      document.getElementById('editSkillPrompt').value = '';
      document.getElementById('editSkillTriggers').value = '';
      document.getElementById('editorTitle').textContent = 'New Skill';
      document.getElementById('editorDeleteBtn').style.display = 'none';
      document.getElementById('editorStatus').style.display = 'none';
      document.getElementById('skillEditor').style.display = 'block';
      document.getElementById('editSkillName').focus();
    }

    function editSkill(idx) {
      const skill = window.__currentSkills[idx];
      if (!skill) return;
      document.getElementById('editSkillId').value = skill.id || '';
      document.getElementById('editSkillName').value = skill.name || '';
      document.getElementById('editSkillCategory').value = skill.category || 'custom';
      document.getElementById('editSkillPrompt').value = skill.system_prompt || '';
      document.getElementById('editSkillTriggers').value = (skill.trigger_phrases || []).join(', ');
      document.getElementById('editorTitle').textContent = 'Edit: ' + skill.name;
      document.getElementById('editorDeleteBtn').style.display = skill.is_preset ? 'none' : 'inline-block';
      document.getElementById('editorStatus').style.display = 'none';
      document.getElementById('skillEditor').style.display = 'block';
      document.getElementById('editSkillName').focus();
    }

    function hideSkillEditor() {
      document.getElementById('skillEditor').style.display = 'none';
    }

    function showEditorStatus(msg, isError) {
      const el = document.getElementById('editorStatus');
      el.textContent = msg;
      el.style.color = isError ? '#e74c3c' : 'var(--teal-light)';
      el.style.display = 'block';
      if (!isError) setTimeout(() => { el.style.display = 'none'; }, 3000);
    }

    async function saveSkill() {
      const id = document.getElementById('editSkillId').value;
      const name = document.getElementById('editSkillName').value.trim();
      const category = document.getElementById('editSkillCategory').value;
      const system_prompt = document.getElementById('editSkillPrompt').value.trim();
      const triggersRaw = document.getElementById('editSkillTriggers').value;
      const trigger_phrases = triggersRaw ? triggersRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

      if (!name) { showEditorStatus('Name is required', true); return; }

      const btn = document.getElementById('editorSaveBtn');
      btn.textContent = 'Saving...';
      btn.disabled = true;

      try {
        let result;
        if (id) {
          result = await window.dashboard.updateSkill({ id, name, category, system_prompt, trigger_phrases });
        } else {
          result = await window.dashboard.createSkill({ name, category, system_prompt, trigger_phrases });
        }

        if (result && result.error) {
          showEditorStatus('Error: ' + result.error, true);
        } else {
          showEditorStatus('Saved!');
          setTimeout(() => hideSkillEditor(), 1000);
        }
      } catch (e) {
        showEditorStatus('Failed: ' + e.message, true);
      }

      btn.textContent = 'Save';
      btn.disabled = false;
    }

    async function deleteSkill() {
      const id = document.getElementById('editSkillId').value;
      if (!id) return;
      if (!confirm('Delete this skill? This cannot be undone.')) return;

      try {
        const result = await window.dashboard.deleteSkill(id);
        if (result && result.error) {
          showEditorStatus('Error: ' + result.error, true);
        } else {
          hideSkillEditor();
        }
      } catch (e) {
        showEditorStatus('Failed: ' + e.message, true);
      }
    }

    // Listen for auto-synced skill updates
    if (window.dashboard && window.dashboard.onSkillsUpdated) {
      window.dashboard.onSkillsUpdated(function(skills) {
        window.__currentSkills = skills;
        renderSkillsGrid(skills);
      });
    }
  </script>
</body>
</html>`;
}

// IPC: indicator skill selector sends index back to main process
ipcMain.on('skill-select', (_event, idx) => {
  selectedSkillIdx = idx;
  pillSkillOverride = true; // user explicitly chose a skill on the pill
});

// IPC: Resize indicator window (expand for dropdown, shrink for pill-only)
ipcMain.on('indicator-resize', (_event, width, height) => {
  if (!indicatorWindow) return;
  const [curX, curY] = indicatorWindow.getPosition();
  const [curW, curH] = indicatorWindow.getSize();
  // Anchor bottom — grow upward
  const newY = curY + curH - height;
  indicatorWindow.setBounds({ x: curX, y: newY, width, height });
});

// IPC: Hide floating pill (close button on indicator)
ipcMain.on('indicator-hide', () => {
  if (indicatorWindow) {
    indicatorWindow.hide();
    updateTrayMenu('Ready');
  }
});

// IPC: Push-to-Talk (mouse-based recording from floating button)
ipcMain.on('push-to-talk-start', () => {
  onHotkeyDown();
});

ipcMain.on('push-to-talk-stop', () => {
  onHotkeyUp();
});

// IPC: Browser-based audio recording data (fallback when SoX not installed)
ipcMain.on('browser-audio-data', (_event, wavArrayBuffer) => {
  onBrowserAudioData(wavArrayBuffer);
});

// IPC: dashboard actions
ipcMain.on('dashboard-open-linkboard', () => {
  const { shell } = require('electron');
  shell.openExternal('https://las-link-board.vercel.app');
});

ipcMain.on('dashboard-refresh-settings', async () => {
  try {
    settings = await syncSettings(store);
    await syncSkills();
    unregisterAll();
    registerHotkey(settings?.hotkey || 'CommandOrControl+Shift+Space', onHotkeyDown, onHotkeyUp);
    updateTrayMenu('Ready');
    if (dashboardWindow && dashboardWindow.isVisible()) openDashboard();
  } catch (e) {
    console.error('Settings refresh failed:', e.message);
  }
});

ipcMain.on('dashboard-toggle-autosubmit', (_event, on) => {
  if (settings) settings.auto_submit = on;
  store.set('auto_submit', on);
});

ipcMain.on('dashboard-set-mode', async (_event, mode) => {
  if (settings) settings.transcription_mode = mode;
  try {
    await saveSettings(store, { transcription_mode: mode });
    updateTrayMenu('Ready');
    console.log('Mode saved:', mode);
  } catch (e) {
    console.error('Failed to save mode:', e.message);
  }
});

ipcMain.on('dashboard-toggle-pill', (_event, on) => {
  if (on) {
    showFloatingButton();
  } else if (indicatorWindow) {
    indicatorWindow.hide();
  }
});

ipcMain.on('dashboard-quit', () => {
  if (indicatorWindow) { indicatorWindow.destroy(); indicatorWindow = null; }
  if (dashboardWindow) { dashboardWindow.removeAllListeners('close'); dashboardWindow.destroy(); dashboardWindow = null; }
  if (tray) { tray.destroy(); tray = null; }
  app.quit();
});

ipcMain.on('dashboard-select-skill', (_event, idx) => {
  selectedSkillIdx = idx;
  pillSkillOverride = false; // dashboard change resets pill override
  // Mark as default locally
  userSkills.forEach((s, i) => { s.is_default = (i === idx); });
  // Update pill to reflect the new default
  if (indicatorWindow) {
    const skillList = userSkills.map(s => ({ name: s.name, category: s.category, system_prompt: !!s.system_prompt }));
    indicatorWindow.webContents.executeJavaScript(
      `setSkills(${JSON.stringify(skillList)}, ${selectedSkillIdx});`
    );
  }
  if (dashboardWindow && dashboardWindow.isVisible()) openDashboard();
});

// ─── Core Flow ───

function onHotkeyDown() {
  if (isRecording) return;
  isRecording = true;

  // Only reset to dashboard default if the user hasn't picked a skill on the pill
  if (!pillSkillOverride) {
    const defaultIdx = userSkills.findIndex(s => s.is_default);
    selectedSkillIdx = defaultIdx >= 0 ? defaultIdx : 0;
  }

  // Send skills list to indicator window (preserves pill selection if user changed it)
  if (indicatorWindow) {
    const skillList = userSkills.map(s => ({ name: s.name, category: s.category, system_prompt: !!s.system_prompt }));
    indicatorWindow.webContents.executeJavaScript(
      `setSkills(${JSON.stringify(skillList)}, ${selectedSkillIdx});`
    );
  }

  showIndicator('Recording...', { recording: true, showSkill: true });
  updateTrayMenu('Recording...');

  try {
    startRecording();
    // If using browser-based recording, tell the indicator window to start capturing
    if (isBrowserRecording() && indicatorWindow) {
      indicatorWindow.webContents.send('start-browser-recording');
    }
  } catch (e) {
    console.error('Failed to start recording:', e);
    isRecording = false;
    hideIndicator();
    updateTrayMenu('Mic error');
  }
}

async function onHotkeyUp() {
  if (!isRecording) return;
  isRecording = false;

  // Determine which skill the user selected (or null for auto-detect)
  const selectedSkill = userSkills[selectedSkillIdx] || null;
  const isRaw = !selectedSkill || selectedSkill.category === 'raw' || !selectedSkill.system_prompt;

  showIndicator('Transcribing...', { processing: true });
  updateTrayMenu('Transcribing...');

  // Tell indicator window to stop browser recording if active
  if (isBrowserRecording() && indicatorWindow) {
    indicatorWindow.webContents.send('stop-browser-recording');
  }

  try {
    const audioBuffer = await stopRecording();

    if (!audioBuffer || audioBuffer.length < 1000) {
      hideIndicator();
      updateTrayMenu('Ready');
      return; // Too short, ignore
    }

    const mode = settings?.transcription_mode || store.get('transcription_mode') || 'cloud';
    const apiKey = settings?.openai_api_key || store.get('openai_api_key');

    if (mode !== 'local' && mode !== 'groq' && !apiKey) {
      hideIndicator();
      updateTrayMenu('No API key');
      console.error('No OpenAI API key configured');
      return;
    }

    if (mode === 'local') {
      showIndicator('Local transcription...', { processing: true });
    } else if (mode === 'groq') {
      showIndicator('Groq transcription...', { processing: true });
    }

    const authToken = store.get('supabase_token');
    const groqKey = settings?.groq_api_key || store.get('groq_api_key') || '';
    const text = await transcribe(apiKey, audioBuffer, settings?.language || 'en', authToken, mode, { groq_api_key: groqKey });

    if (text && text.trim()) {
      let finalText = text.trim();
      let usedSkill = null;

      // Process through skill formatter (handles intent detection + formatting)
      // If user selected Raw, still run intent detection in case they said "email to..."
      const anthropicKey = settings?.anthropic_api_key || store.get('anthropic_api_key');
      if (anthropicKey) {
        showIndicator(isRaw ? 'Detecting...' : `${selectedSkill.name}...`, { processing: true });
        try {
          const result = await processTranscription(finalText, {
            skills: userSkills,
            selectedSkill: isRaw ? null : selectedSkill, // null = auto-detect from speech
            apiKey: anthropicKey,
            baseURL: settings?.anthropic_base_url || undefined,
            model: settings?.anthropic_model || undefined
          });
          finalText = result.text;
          usedSkill = result.skill;
        } catch (e) {
          console.error('Skill formatting failed, using raw transcript:', e.message);
          finalText = text.trim();
        }
      }

      // Inject at cursor (tries paste, always copies to clipboard)
      await injectText(finalText, !!settings?.auto_submit);
      showIndicator(usedSkill ? usedSkill.name : 'Done', { done: true });

      // Log usage with skill info
      logUsage(audioBuffer.length, usedSkill);
    } else {
      showIndicator('No speech', { done: true });
    }

    setTimeout(() => {
      hideIndicator();
      updateTrayMenu('Ready');
    }, 1200);

  } catch (e) {
    console.error('Transcription error:', e);
    hideIndicator();
    updateTrayMenu('Error — check logs');
  }
}

async function logUsage(bufferLength, skill) {
  // Estimate duration: 16-bit mono 16kHz = 32000 bytes/sec
  const durationSeconds = Math.max(1, Math.round(bufferLength / 32000));
  const costUsd = (durationSeconds / 60) * 0.006; // Whisper pricing

  const token = store.get('supabase_token');
  if (!token) return;

  const SUPABASE_URL = store.get('supabase_url') || 'https://pmhoeqxuamvqlwsatozu.supabase.co';
  const SUPABASE_ANON = store.get('supabase_anon') || '';
  const userId = store.get('user_id');
  if (!userId) return;

  const payload = {
    user_id: userId,
    duration_seconds: durationSeconds,
    cost_usd: costUsd.toFixed(6)
  };
  if (skill && skill.id) {
    payload.skill_id = skill.id;
    payload.skill_name = skill.name || '';
  }

  try {
    await fetch(SUPABASE_URL + '/rest/v1/voicetype_usage', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON,
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('Failed to log usage:', e.message);
  }
}

// ─── Skill Sync ───

const LINKBOARD_SKILLS_API = 'https://las-link-board.vercel.app/api/voicetype/skills';
let skillSyncInterval = null;

async function syncSkills() {
  const token = store.get('supabase_token');
  if (!token) {
    userSkills = store.get('cached_skills') || [];
    return;
  }

  try {
    const res = await fetch(LINKBOARD_SKILLS_API, {
      headers: { 'Authorization': 'Bearer ' + token },
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      userSkills = await res.json();
      store.set('cached_skills', userSkills);
      console.log('Skills synced:', userSkills.length, 'skills');

      // Notify dashboard of updated skills
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.webContents.send('skills-updated', userSkills);
      }
      return;
    }
  } catch (e) {
    console.warn('Skills sync failed:', e.message);
  }

  // Fallback to cache
  userSkills = store.get('cached_skills') || [];
}

// Auto-sync skills every 30 seconds to pick up changes from web
function startSkillAutoSync() {
  if (skillSyncInterval) return;
  skillSyncInterval = setInterval(async () => {
    try { await syncSkills(); } catch (e) { /* silent */ }
  }, 30000);
}

function stopSkillAutoSync() {
  if (skillSyncInterval) { clearInterval(skillSyncInterval); skillSyncInterval = null; }
}

// ─── Skill CRUD (desktop → API → Supabase) ───

ipcMain.handle('dashboard-create-skill', async (_event, skill) => {
  const token = store.get('supabase_token');
  if (!token) return { error: 'Not signed in' };

  try {
    const res = await fetch(LINKBOARD_SKILLS_API, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(skill),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      const err = await res.text();
      return { error: err };
    }
    const created = await res.json();
    await syncSkills(); // re-fetch full list
    return created;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('dashboard-update-skill', async (_event, skill) => {
  const token = store.get('supabase_token');
  if (!token) return { error: 'Not signed in' };

  try {
    const res = await fetch(LINKBOARD_SKILLS_API, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(skill),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      const err = await res.text();
      return { error: err };
    }
    const updated = await res.json();
    await syncSkills(); // re-fetch full list
    return updated;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('dashboard-delete-skill', async (_event, id) => {
  const token = store.get('supabase_token');
  if (!token) return { error: 'Not signed in' };

  try {
    const res = await fetch(LINKBOARD_SKILLS_API + '?id=' + id, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      const err = await res.text();
      return { error: err };
    }
    await syncSkills(); // re-fetch full list
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});
