// LAS LinkBoard Tracker — Gmail content script v1.5
// Adds a Mailsuite-style tracking toggle next to Send in Gmail compose windows
// Tracking default is controlled by lb_track_default setting (off by default)

console.log('[LB] Content script v1.5 loaded');

const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';
const PIXEL_BASE = 'https://las-link-board.vercel.app/api/t/';
const CLICK_BASE = 'https://las-link-board.vercel.app/api/c/';

// Track which compose windows already have our toggle
const injected = new WeakSet();

// Global auth cache — single source of truth, no per-toggle listeners
let cachedToken = '';
let cachedUserId = '';

// Load auth once at startup
chrome.storage.local.get(['lb_token', 'lb_user_id'], (stored) => {
  cachedToken = stored.lb_token || '';
  cachedUserId = stored.lb_user_id || '';
  console.log('[LB] Auth loaded: token=' + (cachedToken ? 'yes' : 'no') + ' userId=' + (cachedUserId || 'none'));
});

// Single global listener for auth changes (not per-toggle)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.lb_token) {
    cachedToken = changes.lb_token.newValue || '';
    console.log('[LB] Token updated globally');
  }
  if (changes.lb_user_id) {
    cachedUserId = changes.lb_user_id.newValue || '';
    console.log('[LB] User ID updated globally');
  }
});

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
  // Read default tracking preference from storage (default: off)
  let defaultOn = false;
  try {
    const stored = await chrome.storage.local.get(['lb_track_default']);
    defaultOn = stored.lb_track_default === true;
  } catch (e) {
    // Extension context may be invalidated after reload — use default
  }

  // Create the toggle element
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

  // Watch the To field and show recipient next to Track
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
    // Initial check after short delay (Gmail populates async)
    setTimeout(updateRecipient, 500);
  }

  // Toggle on/off when clicked
  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (toggle.dataset.sent === 'true') return;
    toggle.dataset.tracking = toggle.dataset.tracking === 'on' ? 'off' : 'on';
  });

  // Insert between the scheduled-send dropdown and the next toolbar section
  const sendTd = sendBtn.closest('td');
  if (sendTd && sendTd.nextElementSibling) {
    sendTd.parentElement.insertBefore(toggle, sendTd.nextElementSibling);
  } else {
    sendBtn.parentElement.appendChild(toggle);
  }

  // Intercept Send: inject pixel SYNCHRONOUSLY, never block the click.
  // Campaign creation happens async after the email sends.
  sendBtn.addEventListener('click', (e) => {
    console.log('[LB] Send clicked. tracking=' + toggle.dataset.tracking + ' sent=' + toggle.dataset.sent);

    if (toggle.dataset.tracking !== 'on') {
      console.log('[LB] Tracking off, letting send proceed');
      return; // Not tracking — let Gmail send normally
    }
    if (toggle.dataset.sent === 'true') {
      console.log('[LB] Already injected, letting send proceed');
      return; // Already injected — let Gmail send normally
    }

    // Check auth BEFORE setting sent flag — if no auth, let them retry
    const token = cachedToken;
    const userId = cachedUserId;

    console.log('[LB] Auth: token=' + (token ? 'yes(' + token.substring(0, 20) + '...)' : 'NO') +
                ' userId=' + (userId || 'NO'));

    if (!token || !userId) {
      console.warn('[LB] No auth credentials — skipping tracking');
      toggle.classList.add('lb-no-auth');
      toggle.querySelector('.lb-label').textContent = 'Sign in';
      setTimeout(() => {
        toggle.classList.remove('lb-no-auth');
        toggle.querySelector('.lb-label').textContent = 'Track';
      }, 3000);
      // Don't set sent='true' — allow retry after signing in
      return; // Let click through, but don't track
    }

    // Auth is good — mark sent to prevent double-injection
    toggle.dataset.sent = 'true';

    try {
      // Generate campaign ID client-side so we can inject pixel synchronously
      const campaignId = crypto.randomUUID();
      console.log('[LB] Generated campaign ID: ' + campaignId);

      const composeDialog = sendBtn.closest('div[role="dialog"]') || sendBtn.closest('.AD');

      // Inject tracking pixel into email body SYNCHRONOUSLY before Gmail sends
      injectPixel(composeDialog, campaignId);
      console.log('[LB] Pixel injected into email body');

      // Get subject for campaign name
      let subject = 'Email Campaign';
      if (composeDialog) {
        const subjectInput = composeDialog.querySelector('input[name="subjectbox"]');
        if (subjectInput && subjectInput.value.trim()) {
          subject = subjectInput.value.trim();
        }
      }
      console.log('[LB] Subject: ' + subject);

      // Create campaign in Supabase ASYNC — fire and forget
      createCampaignAsync(token, userId, campaignId, subject);

    } catch (err) {
      console.error('[LB] Tracking failed:', err);
    }

    // Click is NEVER blocked — Gmail sends normally
    console.log('[LB] Click passing through to Gmail send handler');
  }, true); // Use capture phase to run BEFORE Gmail's send handler
}

function injectPixel(dialog, campaignId) {
  const body = dialog
    ? dialog.querySelector('div[role="textbox"][aria-label*="Body"], div[role="textbox"][g_editable="true"], div.Am.Al.editable')
    : null;

  const target = body || document.querySelector('div[role="textbox"][g_editable="true"], div.Am.Al.editable');
  if (!target) return;

  // Wrap links for click tracking — rewrite href to go through our redirect endpoint
  // Uses path-based base64url encoding (no query params) to prevent Gmail URL mangling
  const links = target.querySelectorAll('a[href]');
  links.forEach(a => {
    const href = a.getAttribute('href');
    if (href && href.startsWith('http') && !href.includes('las-link-board.vercel.app/api/')) {
      const b64 = btoa(href).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const trackUrl = CLICK_BASE + campaignId + '/' + b64;
      a.setAttribute('href', trackUrl);
    }
  });

  // Use raw HTML insertion so Gmail includes it in the sent email HTML.
  // Avoid opacity:0/display:none — Gmail strips hidden elements.
  const pixelUrl = PIXEL_BASE + campaignId;
  const pixelHtml = '<img src="' + pixelUrl + '" width="1" height="1" style="width:1px;height:1px;max-height:1px;overflow:hidden;" alt="" />';
  target.insertAdjacentHTML('beforeend', pixelHtml);
}

// Create campaign in Supabase after the email has already been sent.
// We provide our own UUID so the tracking pixel (already injected) matches.
async function createCampaignAsync(token, userId, campaignId, subject) {
  try {
    // Try with current token first
    let res = await fetch(SUPABASE_URL + '/rest/v1/campaigns', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON,
        'Authorization': 'Bearer ' + token,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        id: campaignId,
        user_id: userId,
        name: subject,
        notes: 'Created via Gmail extension'
      })
    });

    // If token expired, try refreshing and retry
    if (res.status === 401) {
      console.warn('[LB] Token expired, refreshing...');
      const refreshed = await refreshToken();
      if (refreshed) {
        const updated = await chrome.storage.local.get(['lb_token']);
        res = await fetch(SUPABASE_URL + '/rest/v1/campaigns', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON,
            'Authorization': 'Bearer ' + updated.lb_token,
            'Prefer': 'return=representation'
          },
          body: JSON.stringify({
            id: campaignId,
            user_id: userId,
            name: subject,
            notes: 'Created via Gmail extension'
          })
        });
      }
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[LB] Campaign creation failed: HTTP ' + res.status + ' — ' + body);
    } else {
      const data = await res.json().catch(() => null);
      console.log('[LB] Campaign created successfully!', campaignId, data);
    }
  } catch (err) {
    console.error('[LB] Async campaign creation error:', err);
  }
}

async function refreshToken() {
  const stored = await chrome.storage.local.get(['lb_refresh']);
  if (!stored.lb_refresh) return false;
  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON },
      body: JSON.stringify({ refresh_token: stored.lb_refresh })
    });
    const data = await res.json();
    if (data.access_token) {
      await chrome.storage.local.set({
        lb_token: data.access_token,
        lb_refresh: data.refresh_token
      });
      return true;
    }
  } catch (e) {}
  return false;
}

// Start observing
observeCompose();
