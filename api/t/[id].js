// Tracking pixel endpoint — serves a 1x1 transparent GIF and logs the open.
// Deduplicates: skips if ANY open was logged for this campaign in last 60 seconds.
// Retries once after 3s if INSERT fails (handles race with campaign creation).
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON;

// 1x1 transparent GIF (43 bytes)
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

// Only filter actual search engine crawlers
const BOT_PATTERNS = [
  'spider', 'crawler', 'Slurp', 'Baiduspider', 'bingbot',
  'Googlebot', 'AhrefsBot', 'SemrushBot', 'DotBot', 'MJ12bot',
  'PetalBot', 'linkfluence', 'BLEXBot'
];

function isBot(ua) {
  const lower = ua.toLowerCase();
  return BOT_PATTERNS.some(p => lower.includes(p.toLowerCase()));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = async function handler(req, res) {
  // ALWAYS serve the pixel first — fast response regardless of logging
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Content-Length', PIXEL.length);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.status(200).end(PIXEL);

  // Log the open after pixel is served
  const { id } = req.query;
  if (!id) return;

  const ua = req.headers['user-agent'] || '';
  if (isBot(ua)) return;

  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';
  const ipHash = simpleHash(ip);

  try {
    // Deduplicate: skip if ANY open for this campaign in last 60 seconds.
    const cutoff = new Date(Date.now() - 60000).toISOString();
    const checkRes = await fetch(
      SUPABASE_URL + '/rest/v1/campaign_opens?campaign_id=eq.' + id +
      '&opened_at=gte.' + encodeURIComponent(cutoff) +
      '&select=id&limit=1',
      {
        headers: {
          'apikey': SUPABASE_ANON,
          'Authorization': 'Bearer ' + SUPABASE_KEY
        }
      }
    );

    if (checkRes.ok) {
      const existing = await checkRes.json();
      if (existing.length > 0) {
        return; // Already logged a recent open — skip
      }
    }

    // Try to insert, retry up to 2 times with backoff.
    // The campaign record may not exist yet (race with extension creating it).
    const body = JSON.stringify({
      campaign_id: id,
      user_agent: ua,
      ip_hash: ipHash,
      opened_at: new Date().toISOString()
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      const insertRes = await fetch(SUPABASE_URL + '/rest/v1/campaign_opens', {
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
        console.log('[pixel] open logged for campaign ' + id);
        return; // Success
      }

      const errText = await insertRes.text().catch(() => '');

      // If FK violation (campaign doesn't exist yet), wait and retry
      if (insertRes.status === 409 || errText.includes('foreign key') || errText.includes('violates')) {
        console.warn('[pixel] attempt ' + (attempt + 1) + ' FK violation, campaign may not exist yet. Retrying...');
        if (attempt < 2) await sleep(3000 * (attempt + 1)); // 3s, 6s
        continue;
      }

      // Other error — log and stop
      console.error('[pixel] insert failed:', insertRes.status, errText);
      return;
    }

    console.error('[pixel] all retry attempts failed for campaign ' + id);
  } catch (e) {
    console.error('[pixel] error:', e.message);
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
