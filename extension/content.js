// LAS LinkBoard Tracker — Gmail content script v1.6
// Adds a Mailsuite-style tracking toggle next to Send in Gmail compose windows

console.log('[LB] Content script v1.6 loaded');

const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';
const PIXEL_BASE = 'https://las-link-board.vercel.app/api/t/';
const CLICK_BASE = 'https://las-link-board.vercel.app/api/c/';

// Track which compose windows already have our toggle
const injected = new WeakSet();

// ─── Global auth cache ───
// Everything is cached in memory so we NEVER need chrome.storage during send.
// After Gmail sends, the extension context can be invalidated, so any
// chrome.storage calls in async code will throw "Extension context invalidated".
let cachedToken = '';
let cachedRefreshToken = '';
let cachedUserId = '';

// Load auth once at startup
try {
  chrome.storage.local.get(['lb_token', 'lb_refresh', 'lb_user_id'], (stored) => {
    cachedToken = stored.lb_token || '';
    cachedRefreshToken = stored.lb_refresh || '';
    cachedUserId = stored.lb_user_id || '';
    console.log('[LB] Auth loaded: token=' + (cachedToken ? 'yes' : 'no') +
                ' refresh=' + (cachedRefreshToken ? 'yes' : 'no') +
                ' userId=' + (cachedUserId || 'none'));

    // Proactively refresh token if we have one (it may already be expired)
    if (cachedToken && cachedRefreshToken) {
      refreshTokenNow();
    }
  });
} catch (e) {
  console.warn('[LB] Could not load auth from storage:', e.message);
}

// Single global listener for auth changes (not per-toggle)
try {
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.lb_token) {
      cachedToken = changes.lb_token.newValue || '';
    }
    if (changes.lb_refresh) {
      cachedRefreshToken = changes.lb_refresh.newValue || '';
    }
    if (changes.lb_user_id) {
      cachedUserId = changes.lb_user_id.newValue || '';
    }
  });
} catch (e) {
  // Extension context may already be invalid
}

// Proactively refresh the token every 45 minutes (Supabase JWTs expire in 1 hour)
setInterval(() => {
  if (cachedRefreshToken) {
    refreshTokenNow();
  }
}, 45 * 60 * 1000);

// Refresh token using only in-memory values — no chrome.storage reads
async function refreshTokenNow() {
  if (!cachedRefreshToken) return false;
  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON },
      body: JSON.stringify({ refresh_token: cachedRefreshToken })
    });
    const data = await res.json();
    if (data.access_token) {
      // Update in-memory cache immediately
      cachedToken = data.access_token;
      cachedRefreshToken = data.refresh_token;
      console.log('[LB] Token refreshed successfully');

      // Try to persist to storage (may fail if context is invalidated, that's OK)
      try {
        chrome.storage.local.set({
          lb_token: data.access_token,
          lb_refresh: data.refresh_token
        });
      } catch (e) {
        // Context invalidated — in-memory cache is still good for this page
      }
      return true;
    }
    console.warn('[LB] Token refresh returned no access_token');
  } catch (e) {
    console.warn('[LB] Token refresh failed:', e.message);
  }
  return false;
}

function observeCompose() {
  const observer = new MutationObserver(() => {
    const sendButtons = document.querySelectorAll('div[role="dialog"] .T-I.J-J5-Ji, .AD .T-I.J-J5-Ji');
    sendButtons.forEach(sendBtn => {
      const toolbar = sendBtn.closest('tr') || sendBtn.parentElement;
      if (!toolbar || injected.has(toolbar)) return;
      injected.add(toolbar);
      injectToggle(toolbar, sendBtn);
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

async function injectToggle(toolbar, sendBtn) {
  let defaultOn = false;
  try {
    const stored = await chrome.storage.local.get(['lb_track_default']);
    defaultOn = stored.lb_track_default === true;
  } catch (e) {}

  const toggle = document.createElement('div');
  toggle.className = 'lb-track-toggle';
  toggle.dataset.tracking = defaultOn ? 'on' : 'off';
  toggle.title = 'LinkBoard: Track email opens';
  toggle.innerHTML = `
    <span class="lb-dot"></span>
    <span class="lb-switch"></span>
    <span class="lb-label">Track</span>
    <span class="lb-recipient"></span>
  `;

  const dialog = sendBtn.closest('div[role="dialog"]') || sendBtn.closest('.AD');
  if (dialog) {
    const updateRecipient = () => {
      const toChips = dialog.querySelectorAll('div[name="to"] .afV, div[name="to"] [data-hovercard-id], span[email]');
      const recipientEl = toggle.querySelector('.lb-recipient');
      if (toChips.length === 1) {
        const email = toChips[0].getAttribute('email') || toChips[0].getAttribute('data-hovercard-id') || toChips[0].textContent.trim();
        recipientEl.textContent = email;
      } else if (toChips.length > 1) {
        recipientEl.textContent = toChips.length + ' recipients';
      } else {
        recipientEl.textContent = '';
      }
    };
    const toContainer = dialog.querySelector('div[name="to"]') || dialog.querySelector('.aoD.hl');
    if (toContainer) {
      new MutationObserver(updateRecipient).observe(toContainer, { childList: true, subtree: true });
    }
    setTimeout(updateRecipient, 500);
  }

  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (toggle.dataset.sent === 'true') return;
    toggle.dataset.tracking = toggle.dataset.tracking === 'on' ? 'off' : 'on';
  });

  const sendTd = sendBtn.closest('td');
  if (sendTd && sendTd.nextElementSibling) {
    sendTd.parentElement.insertBefore(toggle, sendTd.nextElementSibling);
  } else {
    sendBtn.parentElement.appendChild(toggle);
  }

  // Intercept Send click in capture phase — inject pixel synchronously, never block.
  sendBtn.addEventListener('click', (e) => {
    console.log('[LB] Send clicked. tracking=' + toggle.dataset.tracking + ' sent=' + toggle.dataset.sent);

    if (toggle.dataset.tracking !== 'on') return;
    if (toggle.dataset.sent === 'true') return;

    // Snapshot auth from in-memory cache (never read chrome.storage here)
    const token = cachedToken;
    const userId = cachedUserId;
    const refreshTok = cachedRefreshToken;

    if (!token || !userId) {
      console.warn('[LB] No auth credentials — skipping tracking');
      toggle.classList.add('lb-no-auth');
      toggle.querySelector('.lb-label').textContent = 'Sign in';
      setTimeout(() => {
        toggle.classList.remove('lb-no-auth');
        toggle.querySelector('.lb-label').textContent = 'Track';
      }, 3000);
      return;
    }

    toggle.dataset.sent = 'true';

    try {
      const campaignId = crypto.randomUUID();
      console.log('[LB] Campaign ID: ' + campaignId);

      const composeDialog = sendBtn.closest('div[role="dialog"]') || sendBtn.closest('.AD');

      // Inject tracking pixel SYNCHRONOUSLY
      injectPixel(composeDialog, campaignId);

      let subject = 'Email Campaign';
      if (composeDialog) {
        const subjectInput = composeDialog.querySelector('input[name="subjectbox"]');
        if (subjectInput && subjectInput.value.trim()) {
          subject = subjectInput.value.trim();
        }
      }

      // Create campaign ASYNC using only in-memory values
      // Pass everything needed — no chrome.storage calls allowed after this point
      createCampaignAsync(token, refreshTok, userId, campaignId, subject);

    } catch (err) {
      console.error('[LB] Tracking failed:', err);
    }
  }, true);
}

function injectPixel(dialog, campaignId) {
  const body = dialog
    ? dialog.querySelector('div[role="textbox"][aria-label*="Body"], div[role="textbox"][g_editable="true"], div.Am.Al.editable')
    : null;
  const target = body || document.querySelector('div[role="textbox"][g_editable="true"], div.Am.Al.editable');
  if (!target) return;

  const links = target.querySelectorAll('a[href]');
  links.forEach(a => {
    const href = a.getAttribute('href');
    if (href && href.startsWith('http') && !href.includes('las-link-board.vercel.app/api/')) {
      const b64 = btoa(href).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      a.setAttribute('href', CLICK_BASE + campaignId + '/' + b64);
    }
  });

  const pixelHtml = '<img src="' + PIXEL_BASE + campaignId + '" width="1" height="1" style="width:1px;height:1px;max-height:1px;overflow:hidden;" alt="" />';
  target.insertAdjacentHTML('beforeend', pixelHtml);
}

// Create campaign in Supabase using ONLY the values passed in.
// This function MUST NOT call chrome.storage — the extension context
// may be invalidated after Gmail sends the email.
async function createCampaignAsync(token, refreshTok, userId, campaignId, subject) {
  const payload = JSON.stringify({
    id: campaignId,
    user_id: userId,
    name: subject,
    notes: 'Created via Gmail extension'
  });

  try {
    let res = await fetch(SUPABASE_URL + '/rest/v1/campaigns', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON,
        'Authorization': 'Bearer ' + token,
        'Prefer': 'return=representation'
      },
      body: payload
    });

    // If token expired, refresh using in-memory refresh token and retry
    if (res.status === 401 && refreshTok) {
      console.warn('[LB] Token expired, refreshing with in-memory refresh token...');
      try {
        const refreshRes = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON },
          body: JSON.stringify({ refresh_token: refreshTok })
        });
        const refreshData = await refreshRes.json();
        if (refreshData.access_token) {
          // Update in-memory cache
          cachedToken = refreshData.access_token;
          cachedRefreshToken = refreshData.refresh_token;
          console.log('[LB] Token refreshed, retrying campaign creation...');

          // Persist to storage (best effort — may fail if context invalidated)
          try { chrome.storage.local.set({ lb_token: refreshData.access_token, lb_refresh: refreshData.refresh_token }); } catch (e) {}

          // Retry with fresh token
          res = await fetch(SUPABASE_URL + '/rest/v1/campaigns', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_ANON,
              'Authorization': 'Bearer ' + refreshData.access_token,
              'Prefer': 'return=representation'
            },
            body: payload
          });
        }
      } catch (refreshErr) {
        console.error('[LB] Token refresh failed:', refreshErr.message);
      }
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error('[LB] Campaign creation failed: HTTP ' + res.status + ' — ' + errBody);
    } else {
      console.log('[LB] Campaign created successfully! ID=' + campaignId);
    }
  } catch (err) {
    console.error('[LB] Campaign creation error:', err.message);
  }
}

observeCompose();
