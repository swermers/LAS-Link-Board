// ═══════════════════════════════════════
//  VoiceType — Login Window
// ═══════════════════════════════════════
//
// Shows a Supabase-authenticated login window
// on first launch (or when no token is stored).
// Supports Google OAuth and email/password.

const { BrowserWindow, ipcMain } = require('electron');

const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';

let loginWindow = null;

/**
 * Show the login window and return a promise that resolves
 * with { token, refreshToken, userId } on successful login.
 */
function showLoginWindow() {
  return new Promise((resolve, reject) => {
    loginWindow = new BrowserWindow({
      width: 420,
      height: 540,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'VoiceType — Sign In',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: false,
        preload: undefined
      }
    });

    const html = buildLoginHTML();
    loginWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

    let resolved = false;

    function resolveAuth(data) {
      if (resolved) return;
      resolved = true;
      if (loginWindow) {
        loginWindow.removeAllListeners('closed');
        loginWindow.close();
        loginWindow = null;
      }
      resolve(data);
    }

    // Listen for auth result from email login (sent via console message)
    loginWindow.webContents.on('console-message', (event, level, message) => {
      if (message.startsWith('VOICETYPE_AUTH:')) {
        try {
          const data = JSON.parse(message.replace('VOICETYPE_AUTH:', ''));
          resolveAuth(data);
        } catch (e) {
          // Not valid JSON, ignore
        }
      }
    });

    // Capture Google OAuth redirect — tokens arrive in the URL hash fragment
    loginWindow.webContents.on('did-finish-load', async () => {
      if (resolved) return;
      try {
        const hash = await loginWindow.webContents.executeJavaScript('window.location.hash');
        if (hash && hash.includes('access_token=')) {
          const params = new URLSearchParams(hash.substring(1));
          const accessToken = params.get('access_token');
          const refreshToken = params.get('refresh_token');
          if (accessToken) {
            // Decode JWT payload to extract user ID (sub claim)
            const payload = JSON.parse(
              Buffer.from(accessToken.split('.')[1], 'base64').toString()
            );
            resolveAuth({
              token: accessToken,
              refreshToken: refreshToken,
              userId: payload.sub
            });
          }
        }
      } catch (e) {
        // Page might not be ready or window closed, ignore
      }
    });

    loginWindow.on('closed', () => {
      loginWindow = null;
      if (!resolved) reject(new Error('Login window closed'));
    });
  });
}

function buildLoginHTML() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #F8F9FA; color: #0B2545;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 2rem;
  }
  .card {
    background: #fff; border-radius: 16px; padding: 2rem;
    width: 100%; max-width: 360px;
    box-shadow: 0 10px 40px rgba(11,37,69,0.12);
  }
  .logo { text-align: center; margin-bottom: 1.5rem; }
  .logo h1 { font-size: 1.3rem; font-weight: 800; }
  .logo p { font-size: 0.82rem; color: #6B7C8D; margin-top: 0.25rem; }
  .field { margin-bottom: 0.9rem; }
  .field label {
    display: block; font-size: 0.72rem; font-weight: 700;
    color: #6B7C8D; text-transform: uppercase; letter-spacing: 0.06em;
    margin-bottom: 0.3rem;
  }
  .field input {
    width: 100%; padding: 0.6rem 0.8rem; border: 1.5px solid #E2E6EA;
    border-radius: 9px; font-size: 0.9rem; transition: all 0.2s;
    background: #F1F3F5;
  }
  .field input:focus {
    outline: none; border-color: #C5963B;
    box-shadow: 0 0 0 3px rgba(197,150,59,0.15); background: #fff;
  }
  .btn {
    width: 100%; padding: 0.7rem; border: none; border-radius: 9px;
    font-size: 0.88rem; font-weight: 700; cursor: pointer;
    transition: all 0.2s;
  }
  .btn-gold { background: #C5963B; color: #fff; }
  .btn-gold:hover { background: #B5862E; }
  .btn-google {
    background: #fff; color: #333; border: 1.5px solid #E2E6EA;
    margin-bottom: 0.75rem; display: flex; align-items: center;
    justify-content: center; gap: 0.5rem;
  }
  .btn-google:hover { background: #F1F3F5; border-color: #0B2545; }
  .divider {
    text-align: center; color: #6B7C8D; font-size: 0.75rem;
    margin: 1rem 0; position: relative;
  }
  .divider::before, .divider::after {
    content: ''; position: absolute; top: 50%; width: 40%;
    height: 1px; background: #E2E6EA;
  }
  .divider::before { left: 0; }
  .divider::after { right: 0; }
  .error { color: #d43b1b; font-size: 0.8rem; margin-top: 0.5rem; display: none; }
  .status { color: #6B7C8D; font-size: 0.8rem; text-align: center; margin-top: 0.75rem; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <h1>VoiceType</h1>
    <p>Sign in with your LinkBoard account</p>
  </div>

  <button class="btn btn-google" onclick="googleLogin()">
    <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#4285F4" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#34A853" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#EA4335" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
    Sign in with Google
  </button>

  <div class="divider">or</div>

  <div class="field">
    <label>Email</label>
    <input type="email" id="email" placeholder="you@school.edu">
  </div>
  <div class="field">
    <label>Password</label>
    <input type="password" id="password" placeholder="Your password" onkeydown="if(event.key==='Enter')emailLogin()">
  </div>
  <button class="btn btn-gold" onclick="emailLogin()">Sign In</button>

  <div class="error" id="error"></div>
  <div class="status" id="status"></div>
</div>

<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
<script>
const sb = supabase.createClient('${SUPABASE_URL}', '${SUPABASE_ANON}');

async function emailLogin() {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  if (!email || !password) { showError('Enter email and password'); return; }

  showStatus('Signing in...');
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { showError(error.message); return; }

  sendAuth(data.session);
}

async function googleLogin() {
  showStatus('Opening Google sign-in...');
  const { data, error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { skipBrowserRedirect: false }
  });
  if (error) { showError(error.message); return; }

  // OAuth will redirect — listen for the session
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session) {
      sendAuth(session);
    }
  });
}

function sendAuth(session) {
  const payload = {
    token: session.access_token,
    refreshToken: session.refresh_token,
    userId: session.user.id
  };
  // Send to main process via console (picked up by webContents listener)
  console.log('VOICETYPE_AUTH:' + JSON.stringify(payload));
}

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg; el.style.display = 'block';
  document.getElementById('status').textContent = '';
}
function showStatus(msg) {
  document.getElementById('status').textContent = msg;
  document.getElementById('error').style.display = 'none';
}
</script>
</body>
</html>`;
}

module.exports = { showLoginWindow };
