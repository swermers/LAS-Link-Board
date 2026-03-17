// ═══════════════════════════════════════
//  VoiceType — Electron Main Process
// ═══════════════════════════════════════

const { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain } = require('electron');
const path = require('path');
const { registerHotkey, unregisterAll } = require('./hotkey');
const { syncSettings, storeAuth } = require('./sync');
const { startRecording, stopRecording } = require('./recorder');
const { transcribe } = require('./whisper');
const { injectText } = require('./injector');
const { showLoginWindow } = require('./login');
const Store = require('electron-store');

const store = new Store({ name: 'voicetype-config' });
let tray = null;
let indicatorWindow = null;
let isRecording = false;
let settings = null;

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

app.on('ready', async () => {
  // Hide dock icon on macOS — tray-only app
  if (process.platform === 'darwin') {
    app.dock.hide();
  }

  createTray();
  createIndicatorWindow();

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

  // Load settings from Supabase (or local cache)
  try {
    settings = await syncSettings(store);
    if (settings && settings.hotkey) {
      registerHotkey(settings.hotkey, onHotkeyDown, onHotkeyUp);
    } else {
      registerHotkey('CommandOrControl+Shift+Space', onHotkeyDown, onHotkeyUp);
    }
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
          unregisterAll();
          registerHotkey(settings?.hotkey || 'CommandOrControl+Shift+Space', onHotkeyDown, onHotkeyUp);
          updateTrayMenu('Ready');
        } catch (e) {
          updateTrayMenu('Sync failed');
        }
      }
    },
    {
      label: 'Open LinkBoard',
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

// ─── Recording Indicator Window ───

function createIndicatorWindow() {
  indicatorWindow = new BrowserWindow({
    width: 200,
    height: 60,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  indicatorWindow.loadURL('data:text/html,' + encodeURIComponent(`
    <!DOCTYPE html>
    <html>
    <head><style>
      body {
        margin: 0; display: flex; align-items: center; justify-content: center;
        height: 100vh; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        background: rgba(11,37,69,0.92); color: #fff; border-radius: 12px;
        -webkit-app-region: drag; user-select: none;
      }
      .dot {
        width: 12px; height: 12px; border-radius: 50%;
        background: #e74c3c; margin-right: 10px;
        animation: pulse 1s ease-in-out infinite;
      }
      @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
      .label { font-size: 13px; font-weight: 600; letter-spacing: 0.02em; }
    </style></head>
    <body>
      <div class="dot"></div>
      <div class="label" id="label">Recording...</div>
    </body>
    </html>
  `));

  // Position at top-center of primary display
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const x = Math.round(display.bounds.x + display.bounds.width / 2 - 100);
  const y = display.bounds.y + 40;
  indicatorWindow.setPosition(x, y);
}

function showIndicator(text) {
  if (!indicatorWindow) return;
  indicatorWindow.webContents.executeJavaScript(
    `document.getElementById('label').textContent = ${JSON.stringify(text)};`
  );
  indicatorWindow.show();
}

function hideIndicator() {
  if (indicatorWindow) indicatorWindow.hide();
}

// ─── Core Flow ───

function onHotkeyDown() {
  if (isRecording) return;
  isRecording = true;
  showIndicator('Recording...');
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
  showIndicator('Transcribing...');
  updateTrayMenu('Transcribing...');

  try {
    const audioBuffer = stopRecording();

    if (!audioBuffer || audioBuffer.length < 1000) {
      hideIndicator();
      updateTrayMenu('Ready');
      return; // Too short, ignore
    }

    const apiKey = settings?.openai_api_key || store.get('openai_api_key');
    if (!apiKey) {
      hideIndicator();
      updateTrayMenu('No API key');
      console.error('No OpenAI API key configured');
      return;
    }

    const authToken = store.get('supabase_token');
    const text = await transcribe(apiKey, audioBuffer, settings?.language || 'en', authToken);

    if (text && text.trim()) {
      await injectText(text.trim(), !!settings?.auto_submit);
      showIndicator('Done!');

      // Log usage to Supabase
      logUsage(audioBuffer.length);
    } else {
      showIndicator('No speech detected');
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

async function logUsage(bufferLength) {
  // Estimate duration: 16-bit mono 16kHz = 32000 bytes/sec
  const durationSeconds = Math.max(1, Math.round(bufferLength / 32000));
  const costUsd = (durationSeconds / 60) * 0.006; // Whisper pricing

  const token = store.get('supabase_token');
  if (!token) return;

  const SUPABASE_URL = store.get('supabase_url') || 'https://pmhoeqxuamvqlwsatozu.supabase.co';
  const SUPABASE_ANON = store.get('supabase_anon') || '';
  const userId = store.get('user_id');
  if (!userId) return;

  try {
    await fetch(SUPABASE_URL + '/rest/v1/voicetype_usage', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON,
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        user_id: userId,
        duration_seconds: durationSeconds,
        cost_usd: costUsd.toFixed(6)
      })
    });
  } catch (e) {
    console.error('Failed to log usage:', e.message);
  }
}
