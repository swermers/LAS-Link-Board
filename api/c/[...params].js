// Click tracking endpoint — logs link clicks and redirects to destination
// Uses path-based encoding: /api/c/[campaignId]/[base64url_destination]
// IMPORTANT: Redirect happens FIRST. Logging retries in background.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON;

function base64urlDecode(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return Buffer.from(b64, 'base64').toString('utf-8');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = function handler(req, res) {
  try {
    // Vercel populates req.query differently depending on routing:
    // - Auto-routing (no rewrite): req.query.params = ['campaignId', 'base64dest']
    // - Rewrite with :path*:       req.query.path = ['campaignId', 'base64dest']
    // - Rewrite with :params*:     req.query.params = ['campaignId', 'base64dest']
    // Try all variants, plus parse from URL as final fallback.
    let params = req.query.params || req.query.path || [];

    // Fallback: parse from the raw URL if query params are empty
    if ((!params || params.length === 0) && req.url) {
      const urlPath = req.url.split('?')[0]; // remove query string
      const match = urlPath.match(/\/api\/c\/(.+)/);
      if (match) {
        params = match[1].split('/');
      }
    }

    let campaignId, dest;

    if (params.length >= 2) {
      campaignId = params[0];
      dest = base64urlDecode(params.slice(1).join('/'));
    } else if (params.length === 1) {
      campaignId = params[0];
      dest = req.query.url || req.query.u;
    }

    if (!campaignId || !dest) {
      res.status(400).send('Missing campaign ID or destination');
      return;
    }

    // REDIRECT FIRST — this is the most important thing.
    // The user must get to their destination regardless of logging.
    res.writeHead(302, {
      Location: dest,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache'
    });
    res.end();

    // Log the click AFTER redirect is sent — fire and forget with retry.
    const logClick = async () => {
      const ua = req.headers['user-agent'] || '';
      const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';
      const body = JSON.stringify({
        campaign_id: campaignId,
        link_url: dest,
        user_agent: ua,
        ip_hash: simpleHash(ip),
        clicked_at: new Date().toISOString()
      });

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const insertRes = await fetch(SUPABASE_URL + '/rest/v1/campaign_clicks', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_ANON,
              'Authorization': 'Bearer ' + SUPABASE_KEY,
              'Prefer': 'return=minimal'
            },
            body: body
          });

          if (insertRes.ok) {
            console.log('[click] logged for campaign ' + campaignId);
            return;
          }

          const errText = await insertRes.text().catch(() => '');

          // FK violation = campaign not created yet, retry after delay
          if (insertRes.status === 409 || errText.includes('foreign key') || errText.includes('violates')) {
            console.warn('[click] attempt ' + (attempt + 1) + ' FK violation, retrying...');
            if (attempt < 2) await sleep(3000 * (attempt + 1));
            continue;
          }

          console.error('[click] insert failed:', insertRes.status, errText);
          return;
        } catch (e) {
          console.error('[click] attempt ' + (attempt + 1) + ' error:', e.message);
          if (attempt < 2) await sleep(3000 * (attempt + 1));
        }
      }
      console.error('[click] all retry attempts failed for campaign ' + campaignId);
    };

    const logPromise = logClick();
    if (res.waitUntil) res.waitUntil(logPromise);

  } catch (err) {
    console.error('[click] handler error:', err.message, err.stack);
    if (!res.headersSent) {
      res.status(500).send('Redirect failed: ' + err.message);
    }
  }
};

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + c;
    hash |= 0;
  }
  return hash.toString(36);
}
