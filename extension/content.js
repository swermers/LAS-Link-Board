// LAS LinkBoard Tracker — Gmail content script
// Adds a Mailsuite-style tracking toggle next to Send in Gmail compose windows
// Tracking default is controlled by lb_track_default setting (off by default)

const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';
const PIXEL_BASE = 'https://las-link-board.vercel.app/api/t/';
const CLICK_BASE = 'https://las-link-board.vercel.app/api/c/';

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
  // The send button's <td> contains: [Send] [Schedule dropdown]
  // We want our toggle right after that <td>, before the icons <td>
  const sendTd = sendBtn.closest('td');
  if (sendTd && sendTd.nextElementSibling) {
    // Insert before the next td (which has Mailsuite, formatting, etc.)
    sendTd.parentElement.insertBefore(toggle, sendTd.nextElementSibling);
  } else {
    // Fallback: insert after the send button's container
    sendBtn.parentElement.appendChild(toggle);
  }

  // Intercept Send: block the click, inject pixel, then re-click
  sendBtn.addEventListener('click', async (e) => {
    if (toggle.dataset.tracking !== 'on') return; // Tracking off, let send proceed
    if (toggle.dataset.sent === 'true') return;   // Already injected, let send proceed

    // BLOCK the send — we need to inject the pixel first
    e.preventDefault();
    e.stopImmediatePropagation();

    try {
      // Check auth
      let stored;
      try {
        stored = await chrome.storage.local.get(['lb_token', 'lb_user_id']);
      } catch (storageErr) {
        console.warn('LinkBoard: storage unavailable, skipping tracking');
        toggle.dataset.sent = 'true';
        sendBtn.click();
        return;
      }

      if (!stored.lb_token) {
        toggle.classList.add('lb-no-auth');
        toggle.querySelector('.lb-label').textContent = 'Sign in';
        setTimeout(() => {
          toggle.classList.remove('lb-no-auth');
          toggle.querySelector('.lb-label').textContent = 'Track';
        }, 3000);
        toggle.dataset.sent = 'true';
        sendBtn.click();
        return;
      }

      // Get subject for campaign name
      const composeDialog = sendBtn.closest('div[role="dialog"]') || sendBtn.closest('.AD');
      let subject = 'Email Campaign';
      if (composeDialog) {
        const subjectInput = composeDialog.querySelector('input[name="subjectbox"]');
        if (subjectInput && subjectInput.value.trim()) {
          subject = subjectInput.value.trim();
        }
      }

      // Create campaign and inject pixel, THEN re-trigger send
      const token = await getValidToken(stored);
      if (token) {
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
          const data = await res.json();
          const camp = Array.isArray(data) ? data[0] : data;
          if (camp && camp.id) {
            injectPixel(composeDialog, camp.id);
          } else {
            console.warn('LinkBoard: campaign created but no ID returned', data);
          }
        } else {
          console.warn('LinkBoard: campaign creation failed', res.status, await res.text().catch(() => ''));
        }
      } else {
        console.warn('LinkBoard: no valid token, skipping tracking');
      }
    } catch (err) {
      console.error('LinkBoard: tracking failed', err);
    }

    // Always re-trigger send, even if tracking failed
    toggle.dataset.sent = 'true';
    sendBtn.click();
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
