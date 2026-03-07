const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';

console.log('[LB] Background service worker loaded');

// Write to storage so the popup can see debug messages
async function debugLog(msg) {
  console.log('[LB]', msg);
  try {
    const prev = (await chrome.storage.local.get('lb_debug')).lb_debug || '';
    const line = new Date().toLocaleTimeString() + ' ' + msg;
    // Keep last 5 messages
    const lines = prev ? prev.split('\n') : [];
    lines.push(line);
    while (lines.length > 5) lines.shift();
    await chrome.storage.local.set({ lb_debug: lines.join('\n') });
  } catch (e) {
    console.error('[LB] debugLog error:', e);
  }
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'googleSignIn') {
    debugLog('Received googleSignIn message');
    handleGoogleSignIn();
    sendResponse({ started: true });
  }
  return true;
});

// ── PKCE Helpers ──

function generateRandomString(length) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('').slice(0, length);
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return await crypto.subtle.digest('SHA-256', data);
}

function base64urlencode(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Main OAuth Flow ──

async function handleGoogleSignIn() {
  try {
    await chrome.storage.local.remove(['lb_auth_error']);
    await chrome.storage.local.set({ lb_auth_pending: true });

    const redirectUrl = chrome.identity.getRedirectURL();
    await debugLog('Redirect URL: ' + redirectUrl);

    // Generate PKCE
    const codeVerifier = generateRandomString(64);
    const codeChallenge = base64urlencode(await sha256(codeVerifier));
    await debugLog('PKCE generated');

    const params = new URLSearchParams({
      provider: 'google',
      redirect_to: redirectUrl,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      scopes: 'openid email profile'
    });

    const authUrl = SUPABASE_URL + '/auth/v1/authorize?' + params.toString();
    await debugLog('Launching auth flow...');

    // Use callback style — more reliable in MV3 service workers
    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      async (responseUrl) => {
        try {
          if (chrome.runtime.lastError) {
            const errMsg = chrome.runtime.lastError.message || 'Unknown error';
            await debugLog('launchWebAuthFlow error: ' + errMsg);
            if (!errMsg.includes('user did not approve') && !errMsg.includes('cancel')) {
              await chrome.storage.local.set({ lb_auth_error: errMsg });
            }
            await chrome.storage.local.set({ lb_auth_pending: false });
            return;
          }

          if (!responseUrl) {
            await debugLog('ERROR: No response URL');
            await chrome.storage.local.set({ lb_auth_error: 'No response URL', lb_auth_pending: false });
            return;
          }

          await debugLog('Got response URL (' + responseUrl.length + ' chars)');

          const url = new URL(responseUrl);
          const hashParams = new URLSearchParams(url.hash.substring(1));
          const queryParams = new URLSearchParams(url.search);

          await debugLog('Hash keys: ' + ([...hashParams.keys()].join(',') || 'none') +
                        ' | Query keys: ' + ([...queryParams.keys()].join(',') || 'none'));

          // Check for error
          const error = hashParams.get('error') || queryParams.get('error');
          if (error) {
            const desc = hashParams.get('error_description') || queryParams.get('error_description') || '';
            await debugLog('OAuth error: ' + error + ' ' + desc);
            await chrome.storage.local.set({ lb_auth_error: error + ': ' + desc, lb_auth_pending: false });
            return;
          }

          // Try implicit flow token first
          const accessToken = hashParams.get('access_token') || queryParams.get('access_token');
          if (accessToken) {
            await debugLog('Got access_token directly');
            const refreshToken = hashParams.get('refresh_token') || queryParams.get('refresh_token');
            await saveSessionFromToken(accessToken, refreshToken);
            return;
          }

          // PKCE flow — exchange code
          const code = queryParams.get('code') || hashParams.get('code');
          if (code) {
            await debugLog('Got auth code, exchanging...');
            await exchangeCodeForTokens(code, codeVerifier);
            return;
          }

          // Nothing useful
          await debugLog('ERROR: No token/code. URL: ' + responseUrl.substring(0, 300));
          await chrome.storage.local.set({
            lb_auth_error: 'No token or code in callback URL',
            lb_auth_pending: false
          });

        } catch (innerErr) {
          await debugLog('Callback error: ' + (innerErr.message || innerErr));
          await chrome.storage.local.set({
            lb_auth_error: innerErr.message || 'Callback processing failed',
            lb_auth_pending: false
          });
        }
      }
    );
  } catch (e) {
    await debugLog('handleGoogleSignIn error: ' + (e.message || e));
    await chrome.storage.local.set({
      lb_auth_error: e.message || 'Sign-in failed',
      lb_auth_pending: false
    });
  }
}

async function exchangeCodeForTokens(code, codeVerifier) {
  try {
    await debugLog('POST /auth/v1/token...');

    const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=pkce', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON
      },
      body: JSON.stringify({
        auth_code: code,
        code_verifier: codeVerifier
      })
    });

    const data = await res.json();
    await debugLog('Token exchange: ' + res.status + ' keys=' + Object.keys(data).join(','));

    if (!res.ok || !data.access_token) {
      const errMsg = data.error_description || data.error || data.msg || JSON.stringify(data).substring(0, 200);
      await debugLog('Token exchange failed: ' + errMsg);
      await chrome.storage.local.set({ lb_auth_error: 'Token exchange: ' + errMsg, lb_auth_pending: false });
      return;
    }

    await saveSessionFromToken(data.access_token, data.refresh_token);
  } catch (e) {
    await debugLog('Token exchange error: ' + (e.message || e));
    await chrome.storage.local.set({ lb_auth_error: e.message || 'Token exchange failed', lb_auth_pending: false });
  }
}

async function saveSessionFromToken(accessToken, refreshToken) {
  try {
    await debugLog('Fetching user info...');

    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: {
        'apikey': SUPABASE_ANON,
        'Authorization': 'Bearer ' + accessToken
      }
    });

    if (!userRes.ok) {
      const body = await userRes.text();
      throw new Error('User fetch ' + userRes.status + ': ' + body.substring(0, 150));
    }

    const user = await userRes.json();
    const name = user.user_metadata?.full_name
              || user.user_metadata?.name
              || user.email?.split('@')[0]
              || 'User';

    await chrome.storage.local.set({
      lb_token: accessToken,
      lb_refresh: refreshToken || '',
      lb_user_id: user.id,
      lb_user_name: name,
      lb_auth_pending: false
    });

    await debugLog('SUCCESS! User: ' + name);
  } catch (e) {
    await debugLog('saveSession error: ' + (e.message || e));
    await chrome.storage.local.set({ lb_auth_error: e.message || 'Failed to save session', lb_auth_pending: false });
  }
}
