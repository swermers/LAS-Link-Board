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
const localWhisper = require('./local-whisper');
const { formatSOAPNote } = require('./soap-formatter');
const Store = require('electron-store');

const store = new Store({ name: 'voicetype-config' });
let tray = null;
let indicatorWindow = null;
let isRecording = false;
let settings = null;
let soapOverride = null; // null = use settings default, true/false = per-dictation override

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
    width: 320,
    height: 56,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: true,
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
      * { box-sizing: border-box; }
      body {
        margin: 0; display: flex; align-items: center;
        height: 100vh; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        background: rgba(11,37,69,0.95); color: #fff; border-radius: 14px;
        -webkit-app-region: drag; user-select: none; padding: 0 16px;
      }
      .dot {
        width: 10px; height: 10px; border-radius: 50%;
        background: #e74c3c; margin-right: 10px; flex-shrink: 0;
        animation: pulse 1s ease-in-out infinite;
      }
      .dot.done { background: #1A7A6D; animation: none; }
      @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
      .label { font-size: 13px; font-weight: 600; letter-spacing: 0.02em; flex: 1; }
      .divider { width: 1px; height: 24px; background: rgba(255,255,255,0.2); margin: 0 12px; }
      .soap-btn {
        -webkit-app-region: no-drag;
        display: flex; align-items: center; gap: 6px;
        background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);
        border-radius: 8px; padding: 4px 10px; cursor: pointer;
        font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.7);
        transition: all 0.15s ease; white-space: nowrap;
      }
      .soap-btn:hover { background: rgba(255,255,255,0.18); color: #fff; }
      .soap-btn.active { background: rgba(26,122,109,0.5); border-color: #1A7A6D; color: #5CEAD8; }
      .soap-pip {
        width: 7px; height: 7px; border-radius: 50%;
        background: rgba(255,255,255,0.3); transition: background 0.15s;
      }
      .soap-btn.active .soap-pip { background: #5CEAD8; }
      .soap-btn.hidden { display: none; }
    </style></head>
    <body>
      <div class="dot" id="dot"></div>
      <div class="label" id="label">Recording...</div>
      <div class="divider" id="divider"></div>
      <button class="soap-btn" id="soapBtn" onclick="toggleSoap()">
        <div class="soap-pip" id="soapPip"></div>
        SOAP
      </button>
      <script>
        let soapOn = false;
        function toggleSoap() {
          soapOn = !soapOn;
          const btn = document.getElementById('soapBtn');
          btn.classList.toggle('active', soapOn);
          if (window.voicetype) window.voicetype.setSoap(soapOn);
        }
        function setSoapState(on) {
          soapOn = on;
          document.getElementById('soapBtn').classList.toggle('active', on);
        }
        function setRecording(isRec) {
          document.getElementById('dot').classList.toggle('done', !isRec);
        }
        function hideControls() {
          document.getElementById('soapBtn').classList.add('hidden');
          document.getElementById('divider').style.display = 'none';
        }
        function showControls() {
          document.getElementById('soapBtn').classList.remove('hidden');
          document.getElementById('divider').style.display = '';
        }
      </script>
    </body>
    </html>
  `));

  // Position at top-center of primary display
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const x = Math.round(display.bounds.x + display.bounds.width / 2 - 160);
  const y = display.bounds.y + 40;
  indicatorWindow.setPosition(x, y);
}

function showIndicator(text, opts = {}) {
  if (!indicatorWindow) return;
  indicatorWindow.webContents.executeJavaScript(
    `document.getElementById('label').textContent = ${JSON.stringify(text)};`
  );
  if (opts.recording !== undefined) {
    indicatorWindow.webContents.executeJavaScript(`setRecording(${opts.recording});`);
  }
  if (opts.showControls === false) {
    indicatorWindow.webContents.executeJavaScript('hideControls();');
  } else if (opts.showControls === true) {
    indicatorWindow.webContents.executeJavaScript('showControls();');
  }
  indicatorWindow.show();
}

function hideIndicator() {
  if (indicatorWindow) indicatorWindow.hide();
}

// IPC: indicator SOAP toggle sends override back to main process
ipcMain.on('soap-toggle', (_event, on) => {
  soapOverride = on;
});

// ─── Core Flow ───

function onHotkeyDown() {
  if (isRecording) return;
  isRecording = true;

  // Reset SOAP override to match settings default, user can toggle during recording
  const soapDefault = !!(settings?.soap_notes);
  soapOverride = soapDefault;
  if (indicatorWindow) {
    indicatorWindow.webContents.executeJavaScript(`setSoapState(${soapDefault});`);
  }

  showIndicator('Recording...', { recording: true, showControls: true });
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
  const useSoap = soapOverride !== null ? soapOverride : !!(settings?.soap_notes);
  showIndicator('Transcribing...', { recording: false, showControls: false });
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
      showIndicator('Transcribing locally...');
    }

    const authToken = store.get('supabase_token');
    const text = await transcribe(apiKey, audioBuffer, settings?.language || 'en', authToken, mode);

    if (text && text.trim()) {
      let finalText = text.trim();

      // Apply SOAP note formatting if toggled on (via overlay button or settings)
      if (useSoap) {
        showIndicator('Formatting SOAP note...');
        try {
          finalText = await formatSOAPNote(finalText, {
            apiKey: settings?.anthropic_api_key || store.get('anthropic_api_key'),
            baseURL: settings?.anthropic_base_url || undefined,
            model: settings?.anthropic_model || undefined
          });
        } catch (e) {
          console.error('SOAP formatting failed, using raw transcript:', e.message);
          finalText = text.trim();
        }
      }

      await injectText(finalText, !!settings?.auto_submit);
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
