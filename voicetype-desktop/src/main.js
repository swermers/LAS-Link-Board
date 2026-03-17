// ═══════════════════════════════════════
//  VoiceType — Electron Main Process
// ═══════════════════════════════════════

const { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain, screen } = require('electron');
const path = require('path');
const { registerHotkey, unregisterAll } = require('./hotkey');
const { syncSettings, storeAuth } = require('./sync');
const { startRecording, stopRecording } = require('./recorder');
const { transcribe } = require('./whisper');
const { injectText } = require('./injector');
const { showLoginWindow } = require('./login');
const localWhisper = require('./local-whisper');
const { processTranscription, PRESET_SKILLS } = require('./skill-formatter');
const Store = require('electron-store');

const store = new Store({ name: 'voicetype-config' });
let tray = null;
let indicatorWindow = null;
let dashboardWindow = null;
let isRecording = false;
let settings = null;
let userSkills = [];       // user's skill list from Supabase
let selectedSkillIdx = 0;  // index into userSkills for the indicator selector

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

app.on('ready', async () => {
  // Hide dock icon on macOS — shows when dashboard is open
  if (process.platform === 'darwin') {
    app.dock.hide();
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
    // Sync skills
    await syncSkills();
    updateTrayMenu('Ready');
  } catch (e) {
    console.error('Failed to load settings:', e.message);
    registerHotkey('CommandOrControl+Shift+Space', onHotkeyDown, onHotkeyUp);
    updateTrayMenu('Ready (offline)');
  }
});

app.on('will-quit', () => {
  unregisterAll();
});

// Don't quit when all windows close (tray app)
app.on('window-all-closed', (e) => {
  e.preventDefault();
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
      label: 'Mode: ' + (settings?.transcription_mode === 'local' ? 'Local (HIPAA)' : 'Cloud'),
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
        shell.openExternal('https://linkboard.vercel.app');
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
        } else {
          try {
            const auth = await showLoginWindow();
            storeAuth(store, auth);
            settings = await syncSettings(store);
            await syncSkills();
            unregisterAll();
            registerHotkey(settings?.hotkey || 'CommandOrControl+Shift+Space', onHotkeyDown, onHotkeyUp);
            updateTrayMenu('Ready');
          } catch (e) {
            // Login window closed
          }
        }
      }
    },
    { type: 'separator' },
    { label: 'Quit VoiceType', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
}

function formatHotkey(key) {
  if (!key) return 'Ctrl/Cmd+Shift+Space';
  return key.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl')
    .replace(/\+/g, ' + ');
}

// ─── Recording Indicator Window (Floating Bottom Icon) ───

function createIndicatorWindow() {
  indicatorWindow = new BrowserWindow({
    width: 220,
    height: 48,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: true,
    focusable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'indicator-preload.js')
    }
  });

  indicatorWindow.loadURL('data:text/html,' + encodeURIComponent(`
    <!DOCTYPE html>
    <html>
    <head><style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        display: flex; align-items: center; justify-content: center;
        height: 100vh; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        background: transparent; user-select: none; -webkit-app-region: drag;
      }
      .pill {
        display: flex; align-items: center; gap: 8px;
        background: rgba(11,37,69,0.95); color: #fff;
        border-radius: 24px; padding: 8px 16px; height: 40px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        transition: all 0.2s ease;
      }
      .pill.idle {
        padding: 8px 12px; gap: 0;
      }
      .icon {
        width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        transition: all 0.2s ease;
      }
      .icon.recording { background: #e74c3c; animation: pulse 1s ease-in-out infinite; }
      .icon.processing { background: #1A7A6D; animation: spin 1s linear infinite; }
      .icon.done { background: #1A7A6D; animation: none; }
      .icon.idle { background: #1A7A6D; animation: none; }
      .icon svg { width: 14px; height: 14px; fill: #fff; }
      @keyframes pulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(0.85); opacity: 0.5; } }
      @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
      .label {
        font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
        white-space: nowrap; overflow: hidden;
        max-width: 150px; transition: max-width 0.3s ease, opacity 0.2s ease;
      }
      .pill.idle .label { max-width: 0; opacity: 0; }
      .skill-tag {
        font-size: 10px; font-weight: 700; color: #5CEAD8;
        background: rgba(26,122,109,0.4); border-radius: 4px;
        padding: 2px 6px; white-space: nowrap; cursor: pointer;
        -webkit-app-region: no-drag; transition: all 0.15s ease;
      }
      .skill-tag:hover { background: rgba(26,122,109,0.6); }
      .skill-tag.hidden { display: none; }
      .waveform {
        display: flex; align-items: center; gap: 2px; height: 16px;
      }
      .waveform .bar {
        width: 3px; border-radius: 2px; background: #5CEAD8;
        animation: wave 0.6s ease-in-out infinite;
      }
      .waveform .bar:nth-child(1) { height: 6px; animation-delay: 0s; }
      .waveform .bar:nth-child(2) { height: 12px; animation-delay: 0.1s; }
      .waveform .bar:nth-child(3) { height: 8px; animation-delay: 0.2s; }
      .waveform .bar:nth-child(4) { height: 14px; animation-delay: 0.3s; }
      .waveform .bar:nth-child(5) { height: 6px; animation-delay: 0.4s; }
      .waveform.hidden { display: none; }
      @keyframes wave {
        0%,100% { transform: scaleY(1); } 50% { transform: scaleY(0.4); }
      }
    </style></head>
    <body>
      <div class="pill" id="pill">
        <div class="icon idle" id="icon">
          <svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
        </div>
        <div class="waveform hidden" id="waveform">
          <div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div>
        </div>
        <div class="label" id="label"></div>
        <div class="skill-tag hidden" id="skillTag" onclick="cycleSkill()">Raw</div>
      </div>
      <script>
        let skills = [];
        let currentIdx = 0;

        function setSkills(list, activeIdx) {
          skills = list || [];
          currentIdx = activeIdx || 0;
          updateSkillTag();
        }

        function cycleSkill() {
          if (skills.length < 2) return;
          currentIdx = (currentIdx + 1) % skills.length;
          updateSkillTag();
          if (window.voicetype) window.voicetype.setSkill(currentIdx);
        }

        function updateSkillTag() {
          const tag = document.getElementById('skillTag');
          const skill = skills[currentIdx];
          if (!skill) { tag.textContent = 'Raw'; return; }
          tag.textContent = skill.name || 'Raw';
        }

        function setState(state, labelText, showSkill) {
          const pill = document.getElementById('pill');
          const icon = document.getElementById('icon');
          const label = document.getElementById('label');
          const tag = document.getElementById('skillTag');
          const wave = document.getElementById('waveform');

          pill.classList.remove('idle');
          icon.className = 'icon ' + state;
          label.textContent = labelText || '';
          tag.classList.toggle('hidden', !showSkill);
          wave.classList.toggle('hidden', state !== 'recording');

          if (state === 'idle') {
            pill.classList.add('idle');
          }
        }
      </script>
    </body>
    </html>
  `));

  // Position at bottom-center of primary display
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
  indicatorWindow.show();
}

function hideIndicator() {
  if (!indicatorWindow) return;
  // Shrink to idle state (small green icon) then hide after delay
  indicatorWindow.webContents.executeJavaScript(`setState('idle', '', false);`);
  setTimeout(() => { if (indicatorWindow) indicatorWindow.hide(); }, 300);
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

  dashboardWindow.loadURL('data:text/html,' + encodeURIComponent(getDashboardHTML()));

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
        <button class="btn btn-primary" onclick="openLinkBoard()">Manage on LinkBoard</button>
      </div>
      <div class="content">
        <div class="card">
          <h3>Active Skills</h3>
          <p style="font-size:13px; color:var(--text3); margin-bottom:12px;">
            Click a skill to set it as default. The skill reformats your speech into the right format.
          </p>
          <div class="skills-grid" id="skillsGrid"></div>
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
            <span class="value" id="settingsMode">Cloud</span>
          </div>
          <div class="card-row">
            <span class="label">Local Whisper Model</span>
            <span class="value" id="localModelStatus">Not downloaded</span>
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
      const modeName = data.mode === 'local' ? 'Local (HIPAA)' : 'Cloud';
      const modeEl = document.getElementById('activeMode');
      const settingsModeEl = document.getElementById('settingsMode');
      if (modeEl) modeEl.textContent = modeName;
      if (settingsModeEl) settingsModeEl.textContent = modeName;

      // Local model
      const localEl = document.getElementById('localModelStatus');
      if (localEl) localEl.textContent = data.localModelReady ? 'Ready' : 'Not downloaded';
      if (localEl && data.localModelReady) localEl.style.color = 'var(--teal-light)';

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
      const grid = document.getElementById('skillsGrid');
      const activeSkillEl = document.getElementById('activeSkill');
      if (grid && data.skills) {
        grid.innerHTML = data.skills.map((s, i) => {
          const isDefault = s.is_default;
          return '<div class="skill-card ' + (isDefault ? 'active' : '') + '" onclick="selectSkill(' + i + ')">' +
            '<div class="skill-name">' + (s.name || 'Unnamed') + '</div>' +
            '<div class="skill-category">' + (s.category || 'custom') + '</div>' +
            (s.system_prompt ? '<div class="skill-desc">' + s.system_prompt.substring(0, 80) + '...</div>' : '') +
          '</div>';
        }).join('');

        const defaultSkill = data.skills.find(s => s.is_default) || data.skills[0];
        if (activeSkillEl && defaultSkill) activeSkillEl.textContent = defaultSkill.name;
      }
    };

    function selectSkill(idx) {
      if (window.dashboard) window.dashboard.selectSkill(idx);
    }
  </script>
</body>
</html>`;
}

// IPC: indicator skill selector sends index back to main process
ipcMain.on('skill-select', (_event, idx) => {
  selectedSkillIdx = idx;
});

// IPC: dashboard actions
ipcMain.on('dashboard-open-linkboard', () => {
  const { shell } = require('electron');
  shell.openExternal('https://linkboard.vercel.app');
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

ipcMain.on('dashboard-select-skill', (_event, idx) => {
  selectedSkillIdx = idx;
  // Mark as default locally
  userSkills.forEach((s, i) => { s.is_default = (i === idx); });
  if (dashboardWindow && dashboardWindow.isVisible()) openDashboard();
});

// ─── Core Flow ───

function onHotkeyDown() {
  if (isRecording) return;
  isRecording = true;

  // Reset skill selector to user's default (or first skill)
  const defaultIdx = userSkills.findIndex(s => s.is_default);
  selectedSkillIdx = defaultIdx >= 0 ? defaultIdx : 0;

  // Send skills list to indicator window
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

  try {
    const audioBuffer = stopRecording();

    if (!audioBuffer || audioBuffer.length < 1000) {
      hideIndicator();
      updateTrayMenu('Ready');
      return; // Too short, ignore
    }

    const mode = settings?.transcription_mode || store.get('transcription_mode') || 'cloud';
    const apiKey = settings?.openai_api_key || store.get('openai_api_key');

    if (mode !== 'local' && !apiKey) {
      hideIndicator();
      updateTrayMenu('No API key');
      console.error('No OpenAI API key configured');
      return;
    }

    if (mode === 'local') {
      showIndicator('Local transcription...', { processing: true });
    }

    const authToken = store.get('supabase_token');
    const text = await transcribe(apiKey, audioBuffer, settings?.language || 'en', authToken, mode);

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

const LINKBOARD_SKILLS_API = 'https://linkboard.vercel.app/api/voicetype/skills';

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
      return;
    }
  } catch (e) {
    console.warn('Skills sync failed:', e.message);
  }

  // Fallback to cache
  userSkills = store.get('cached_skills') || [];
}
