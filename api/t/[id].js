// Tracking pixel endpoint — serves a 1x1 transparent GIF and logs the open
// Mailchimp-style: ALWAYS log, deduplicate at query/dashboard time, not here.
const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';

// 1x1 transparent GIF (43 bytes)
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

// Only filter actual search engine crawlers (NOT email proxies)
const BOT_PATTERNS = [
  'spider', 'crawler', 'Slurp', 'Baiduspider', 'bingbot',
  'Googlebot', 'AhrefsBot', 'SemrushBot', 'DotBot', 'MJ12bot',
  'PetalBot', 'linkfluence', 'BLEXBot'
];

function isBot(ua) {
  const lower = ua.toLowerCase();
  return BOT_PATTERNS.some(p => lower.includes(p.toLowerCase()));
}

module.exports = async function handler(req, res) {
  const { id } = req.query;

  if (id) {
    const ua = req.headers['user-agent'] || '';
    const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';

    if (!isBot(ua)) {
      // Simple approach: just INSERT. Deduplicate in the dashboard, not here.
      // Fewer moving parts = fewer silent failures.
      try {
        const insertRes = await fetch(SUPABASE_URL + '/rest/v1/campaign_opens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON,
            'Authorization': 'Bearer ' + SUPABASE_ANON,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            campaign_id: id,
            user_agent: ua,
            ip_hash: simpleHash(ip),
            opened_at: new Date().toISOString()
          })
        });

        // Log failures for debugging (visible in Vercel function logs)
        if (!insertRes.ok) {
          const errText = await insertRes.text();
          console.error('campaign_opens insert failed:', insertRes.status, errText);
        }
      } catch (e) {
        console.error('campaign_opens insert error:', e.message);
      }
    }
  }

  // Always serve the pixel regardless of logging outcome
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Content-Length', PIXEL.length);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.status(200).end(PIXEL);
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
