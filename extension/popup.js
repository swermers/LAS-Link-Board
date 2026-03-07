const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';

async function init() {
  const stored = await chrome.storage.local.get(['lb_token', 'lb_user_id', 'lb_user_name']);
  if (stored.lb_token && stored.lb_user_id) {
    showMain(stored.lb_user_name || 'User');
  } else {
    document.getElementById('loginSection').style.display = 'block';
  }
}

// ── Google OAuth ──
document.getElementById('googleBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';

  const redirectUrl = chrome.identity.getRedirectURL();
  const authUrl = SUPABASE_URL + '/auth/v1/authorize?' + new URLSearchParams({
    provider: 'google',
    redirect_to: redirectUrl
  }).toString();

  try {
    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true
    });

    // Supabase returns tokens in the URL hash fragment
    const hash = new URL(responseUrl).hash.substring(1);
    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');

    if (!accessToken) {
      errEl.textContent = 'Google sign-in failed — no token received';
      errEl.style.display = 'block';
      return;
    }

    // Fetch user info from Supabase
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: {
        'apikey': SUPABASE_ANON,
        'Authorization': 'Bearer ' + accessToken
      }
    });
    const user = await userRes.json();
    const name = user.user_metadata?.full_name || user.email?.split('@')[0] || 'User';

    await chrome.storage.local.set({
      lb_token: accessToken,
      lb_refresh: refreshToken,
      lb_user_id: user.id,
      lb_user_name: name
    });

    showMain(name);
  } catch (e) {
    errEl.textContent = 'Google sign-in was cancelled';
    errEl.style.display = 'block';
  }
});

// ── Email/Password login ──
document.getElementById('loginBtn').addEventListener('click', async () => {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';

  if (!email || !password) { errEl.textContent = 'Enter email and password'; errEl.style.display = 'block'; return; }

  const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    errEl.textContent = data.error_description || data.msg || 'Login failed';
    errEl.style.display = 'block';
    return;
  }

  const name = data.user?.user_metadata?.full_name || email.split('@')[0];
  await chrome.storage.local.set({
    lb_token: data.access_token,
    lb_refresh: data.refresh_token,
    lb_user_id: data.user.id,
    lb_user_name: name
  });
  showMain(name);
});

// ── Logout ──
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await chrome.storage.local.remove(['lb_token', 'lb_refresh', 'lb_user_id', 'lb_user_name']);
  document.getElementById('mainSection').style.display = 'none';
  document.getElementById('loginSection').style.display = 'block';
});

function showMain(name) {
  document.getElementById('loginSection').style.display = 'none';
  document.getElementById('mainSection').style.display = 'block';
  document.getElementById('userInfo').textContent = 'Signed in as ' + name;
}

init();
