const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';

async function init() {
  const stored = await chrome.storage.local.get([
    'lb_token', 'lb_user_id', 'lb_user_name', 'lb_auth_pending', 'lb_auth_error'
  ]);

  // Show any error from background OAuth attempt
  if (stored.lb_auth_error) {
    document.getElementById('loginError').textContent = stored.lb_auth_error;
    document.getElementById('loginError').style.display = 'block';
    await chrome.storage.local.remove(['lb_auth_error']);
  }

  if (stored.lb_token && stored.lb_user_id) {
    showMain(stored.lb_user_name || 'User');
  } else if (stored.lb_auth_pending) {
    // OAuth is still in progress in the background worker
    document.getElementById('loginSection').style.display = 'block';
    document.getElementById('googleBtn').textContent = 'Signing in…';
    document.getElementById('googleBtn').disabled = true;
    pollForAuth();
  } else {
    document.getElementById('loginSection').style.display = 'block';
  }
}

// Poll storage while OAuth is in progress in the background
function pollForAuth() {
  let attempts = 0;
  const maxAttempts = 60; // 30 seconds
  const interval = setInterval(async () => {
    attempts++;
    const stored = await chrome.storage.local.get([
      'lb_token', 'lb_user_id', 'lb_user_name',
      'lb_auth_error', 'lb_auth_pending'
    ]);

    if (stored.lb_token && stored.lb_user_id) {
      clearInterval(interval);
      showMain(stored.lb_user_name || 'User');
      return;
    }

    if (stored.lb_auth_error) {
      clearInterval(interval);
      document.getElementById('loginError').textContent = stored.lb_auth_error;
      document.getElementById('loginError').style.display = 'block';
      document.getElementById('googleBtn').textContent = 'Sign in with Google';
      document.getElementById('googleBtn').disabled = false;
      await chrome.storage.local.remove(['lb_auth_error']);
      return;
    }

    if (!stored.lb_auth_pending || attempts >= maxAttempts) {
      clearInterval(interval);
      document.getElementById('googleBtn').textContent = 'Sign in with Google';
      document.getElementById('googleBtn').disabled = false;
    }
  }, 500);
}

// ── Google OAuth — trigger background worker and poll for completion ──
document.getElementById('googleBtn').addEventListener('click', () => {
  document.getElementById('loginError').style.display = 'none';
  document.getElementById('googleBtn').textContent = 'Signing in…';
  document.getElementById('googleBtn').disabled = true;
  chrome.runtime.sendMessage({ action: 'googleSignIn' });
  pollForAuth();
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
  await chrome.storage.local.remove(['lb_token', 'lb_refresh', 'lb_user_id', 'lb_user_name', 'lb_auth_pending']);
  document.getElementById('mainSection').style.display = 'none';
  document.getElementById('loginSection').style.display = 'block';
});

function showMain(name) {
  document.getElementById('loginSection').style.display = 'none';
  document.getElementById('mainSection').style.display = 'block';
  document.getElementById('userInfo').textContent = 'Signed in as ' + name;
  loadCampaigns();
}

async function loadCampaigns() {
  const stored = await chrome.storage.local.get(['lb_token', 'lb_user_id']);
  if (!stored.lb_token || !stored.lb_user_id) return;

  const listEl = document.getElementById('campList');
  try {
    // Load campaigns
    const res = await fetch(SUPABASE_URL + '/rest/v1/campaigns?user_id=eq.' + stored.lb_user_id + '&order=created_at.desc&limit=50', {
      headers: { 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + stored.lb_token }
    });
    if (!res.ok) { listEl.innerHTML = '<div class="camp-loading">Failed to load</div>'; return; }
    const camps = await res.json();

    if (camps.length === 0) {
      listEl.innerHTML = '<div class="camp-loading">No tracked emails yet</div>';
      return;
    }

    // Load open counts
    const ids = camps.map(c => c.id).join(',');
    let openCounts = {};
    try {
      const opensRes = await fetch(SUPABASE_URL + '/rest/v1/campaign_opens?campaign_id=in.(' + ids + ')&select=campaign_id', {
        headers: { 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + stored.lb_token }
      });
      if (opensRes.ok) {
        const opens = await opensRes.json();
        opens.forEach(o => { openCounts[o.campaign_id] = (openCounts[o.campaign_id] || 0) + 1; });
      }
    } catch (e) {}

    listEl.innerHTML = '';
    camps.forEach(c => {
      const count = openCounts[c.id] || 0;
      const item = document.createElement('div');
      item.className = 'camp-item';
      item.innerHTML = '<span class="camp-name">' + escHtml(c.name) + '</span>'
        + '<span class="camp-opens">' + count + ' open' + (count !== 1 ? 's' : '') + '</span>'
        + '<button class="camp-del" title="Delete">&times;</button>';
      item.querySelector('.camp-del').addEventListener('click', () => deleteCampaign(c.id, item));
      listEl.appendChild(item);
    });
  } catch (e) {
    listEl.innerHTML = '<div class="camp-loading">Error loading campaigns</div>';
  }
}

async function deleteCampaign(id, itemEl) {
  if (!confirm('Delete this tracked email?')) return;
  const stored = await chrome.storage.local.get(['lb_token']);
  if (!stored.lb_token) return;
  const headers = { 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + stored.lb_token };

  // Delete opens first, then campaign
  await fetch(SUPABASE_URL + '/rest/v1/campaign_opens?campaign_id=eq.' + id, { method: 'DELETE', headers });
  await fetch(SUPABASE_URL + '/rest/v1/campaigns?id=eq.' + id, { method: 'DELETE', headers });
  itemEl.remove();

  // Show empty state if no items left
  const listEl = document.getElementById('campList');
  if (!listEl.querySelector('.camp-item')) {
    listEl.innerHTML = '<div class="camp-loading">No tracked emails yet</div>';
  }
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

init();
