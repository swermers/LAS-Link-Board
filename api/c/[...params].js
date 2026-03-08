// Click tracking endpoint — logs link clicks and redirects to destination
// Uses path-based encoding: /api/c/[campaignId]/[base64url_destination]
// IMPORTANT: Redirect happens FIRST. Logging is fire-and-forget.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON;

function base64urlDecode(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return Buffer.from(b64, 'base64').toString('utf-8');
}

module.exports = function handler(req, res) {
  try {
    const params = req.query.params || [];
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

    // Log the click AFTER redirect is sent — fire and forget.
    // Uses waitUntil if available (Vercel edge), otherwise just fire.
    try {
      const ua = req.headers['user-agent'] || '';
      const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';
      const logPromise = fetch(SUPABASE_URL + '/rest/v1/campaign_clicks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          campaign_id: campaignId,
          link_url: dest,
          user_agent: ua,
          ip_hash: simpleHash(ip),
          clicked_at: new Date().toISOString()
        })
      }).catch(e => console.error('[click] log error:', e.message));

      // If Vercel provides waitUntil, use it to keep the function alive for logging
      if (res.waitUntil) res.waitUntil(logPromise);
    } catch (logErr) {
      console.error('[click] logging setup error:', logErr.message);
    }

  } catch (err) {
    console.error('[click] handler error:', err.message, err.stack);
    // If redirect hasn't been sent yet, send a fallback
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
