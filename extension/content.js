// LAS LinkBoard Tracker — Gmail content script
// Adds a Mailsuite-style tracking toggle next to Send in Gmail compose windows
// Tracking is ON by default — auto-injects pixel when Send is clicked

const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';
const PIXEL_BASE = 'https://las-link-board.vercel.app/api/t/';

// Track which compose windows already have our toggle
const injected = new WeakSet();

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

function injectToggle(toolbar, sendBtn) {
  // Create the toggle element
  const toggle = document.createElement('div');
  toggle.className = 'lb-track-toggle';
  toggle.dataset.tracking = 'on'; // ON by default
  toggle.title = 'LinkBoard: Track email opens';
  toggle.innerHTML = `
    <span class="lb-dot"></span>
    <span class="lb-switch"></span>
    <span class="lb-label">Track</span>
  `;

  // Toggle on/off when clicked
  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (toggle.dataset.sent === 'true') return;
    toggle.dataset.tracking = toggle.dataset.tracking === 'on' ? 'off' : 'on';
  });

  // Insert after send button
  sendBtn.parentElement.insertBefore(toggle, sendBtn.nextSibling);

  // Intercept Send: when the user clicks Send, inject the pixel first
  sendBtn.addEventListener('click', async (e) => {
    if (toggle.dataset.tracking !== 'on') return; // Tracking off, let send proceed
    if (toggle.dataset.sent === 'true') return; // Already injected

    // Check auth
    const stored = await chrome.storage.local.get(['lb_token', 'lb_user_id']);
    if (!stored.lb_token) {
      toggle.classList.add('lb-no-auth');
      toggle.querySelector('.lb-label').textContent = 'Sign in';
      setTimeout(() => {
        toggle.classList.remove('lb-no-auth');
        toggle.querySelector('.lb-label').textContent = 'Track';
      }, 3000);
      return; // Let the email send without tracking
    }

    // Get subject for campaign name
    const dialog = sendBtn.closest('div[role="dialog"]') || sendBtn.closest('.AD');
    let subject = 'Email Campaign';
    if (dialog) {
      const subjectInput = dialog.querySelector('input[name="subjectbox"]');
      if (subjectInput && subjectInput.value.trim()) {
        subject = subjectInput.value.trim();
      }
    }

    // Create campaign and inject pixel (don't block the send)
    try {
      const token = await getValidToken(stored);
      if (!token) return;

      const res = await fetch(SUPABASE_URL + '/rest/v1/campaigns', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON,
          'Authorization': 'Bearer ' + token,
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          user_id: stored.lb_user_id,
          name: subject,
          notes: 'Created via Gmail extension'
        })
      });

      if (res.ok) {
        const [camp] = await res.json();
        injectPixel(dialog, camp.id);
        toggle.dataset.sent = 'true';
      }
    } catch (err) {
      console.error('LinkBoard: tracking failed', err);
    }
  }, true); // Use capture phase to run BEFORE Gmail's send handler
}

function injectPixel(dialog, campaignId) {
  const body = dialog
    ? dialog.querySelector('div[role="textbox"][aria-label*="Body"], div[role="textbox"][g_editable="true"], div.Am.Al.editable')
    : null;

  const target = body || document.querySelector('div[role="textbox"][g_editable="true"], div.Am.Al.editable');
  if (!target) return;

  const pixelUrl = PIXEL_BASE + campaignId;
  const img = document.createElement('img');
  img.src = pixelUrl;
  img.width = 1;
  img.height = 1;
  img.style.cssText = 'display:block;width:1px;height:1px;opacity:0;position:absolute;';
  img.alt = '';
  target.appendChild(img);
}

async function getValidToken(stored) {
  // Try current token first
  const check = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + stored.lb_token }
  });

  if (check.ok) return stored.lb_token;

  // Token expired, try refresh
  const refreshed = await refreshToken();
  if (refreshed) {
    const updated = await chrome.storage.local.get(['lb_token']);
    return updated.lb_token;
  }

  return null;
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
