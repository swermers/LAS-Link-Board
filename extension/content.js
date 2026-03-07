// LAS LinkBoard Tracker — Gmail content script
// Injects a "Track" button next to Send in Gmail compose windows

const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';
const PIXEL_BASE = 'https://las-link-board.vercel.app/api/t/';

// Track which compose windows already have our button
const injected = new WeakSet();

function observeCompose() {
  // Gmail compose windows have a .T-I.J-J5-Ji send button
  const observer = new MutationObserver(() => {
    // Find all compose toolbars (the row containing the Send button)
    const sendButtons = document.querySelectorAll('div[role="dialog"] .T-I.J-J5-Ji, .AD .T-I.J-J5-Ji');
    sendButtons.forEach(sendBtn => {
      const toolbar = sendBtn.closest('tr') || sendBtn.parentElement;
      if (!toolbar || injected.has(toolbar)) return;
      injected.add(toolbar);
      injectTrackButton(toolbar, sendBtn);
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

function injectTrackButton(toolbar, sendBtn) {
  const btn = document.createElement('div');
  btn.className = 'lb-track-btn';
  btn.textContent = 'Track';
  btn.title = 'Add LinkBoard tracking pixel to this email';
  btn.dataset.state = 'ready'; // ready | tracking | done

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (btn.dataset.state === 'done') return;

    // Get auth
    const stored = await chrome.storage.local.get(['lb_token', 'lb_user_id']);
    if (!stored.lb_token) {
      btn.textContent = 'Sign in first';
      btn.style.background = '#a42547';
      setTimeout(() => { btn.textContent = 'Track'; btn.style.background = ''; }, 2000);
      return;
    }

    btn.textContent = 'Adding...';
    btn.dataset.state = 'tracking';

    try {
      // Get the email subject for the campaign name
      const dialog = sendBtn.closest('div[role="dialog"]') || sendBtn.closest('.AD');
      let subject = 'Email Campaign';
      if (dialog) {
        const subjectInput = dialog.querySelector('input[name="subjectbox"]');
        if (subjectInput && subjectInput.value.trim()) {
          subject = subjectInput.value.trim();
        }
      }

      // Create campaign
      const res = await fetch(SUPABASE_URL + '/rest/v1/campaigns', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON,
          'Authorization': 'Bearer ' + stored.lb_token,
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          user_id: stored.lb_user_id,
          name: subject,
          notes: 'Created via Gmail extension'
        })
      });

      if (!res.ok) {
        // Token might be expired, try refresh
        const refreshed = await refreshToken();
        if (!refreshed) throw new Error('Auth expired — sign in again');
        // Retry with new token
        const retryStored = await chrome.storage.local.get(['lb_token']);
        const retryRes = await fetch(SUPABASE_URL + '/rest/v1/campaigns', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON,
            'Authorization': 'Bearer ' + retryStored.lb_token,
            'Prefer': 'return=representation'
          },
          body: JSON.stringify({
            user_id: stored.lb_user_id,
            name: subject,
            notes: 'Created via Gmail extension'
          })
        });
        if (!retryRes.ok) throw new Error('Failed to create campaign');
        const [camp] = await retryRes.json();
        injectPixel(dialog, camp.id);
      } else {
        const [camp] = await res.json();
        injectPixel(dialog, camp.id);
      }

      btn.textContent = 'Tracking';
      btn.dataset.state = 'done';
      btn.classList.add('lb-track-active');
    } catch (err) {
      console.error('LinkBoard Track error:', err);
      btn.textContent = 'Error';
      btn.style.background = '#a42547';
      setTimeout(() => {
        btn.textContent = 'Track';
        btn.style.background = '';
        btn.dataset.state = 'ready';
      }, 2000);
    }
  });

  // Insert after send button
  sendBtn.parentElement.insertBefore(btn, sendBtn.nextSibling);
}

function injectPixel(dialog, campaignId) {
  // Find the editable email body
  const body = dialog
    ? dialog.querySelector('div[role="textbox"][aria-label*="Body"], div[role="textbox"][g_editable="true"], div.Am.Al.editable')
    : null;

  if (!body) {
    // Fallback: try any editable body in the page
    const fallback = document.querySelector('div[role="textbox"][g_editable="true"], div.Am.Al.editable');
    if (fallback) {
      appendPixelToBody(fallback, campaignId);
    }
    return;
  }

  appendPixelToBody(body, campaignId);
}

function appendPixelToBody(body, campaignId) {
  const pixelUrl = PIXEL_BASE + campaignId;
  const img = document.createElement('img');
  img.src = pixelUrl;
  img.width = 1;
  img.height = 1;
  img.style.cssText = 'display:block;width:1px;height:1px;opacity:0;position:absolute;';
  img.alt = '';
  body.appendChild(img);
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
