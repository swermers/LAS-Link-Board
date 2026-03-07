// Tracking pixel endpoint — serves a 1x1 transparent GIF and logs the open
const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';

// 1x1 transparent GIF (43 bytes)
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

// Dedup window: ignore duplicate opens from same IP within 5 minutes
const DEDUP_MINUTES = 5;

module.exports = async function handler(req, res) {
  const { id } = req.query;

  // Serve the pixel immediately (don't make the email client wait)
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Content-Length', PIXEL.length);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.status(200).end(PIXEL);

  // Log the open after responding (fire-and-forget)
  if (id) {
    const ua = req.headers['user-agent'] || '';
    const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';
    const ipHash = simpleHash(ip);

    try {
      // Check for recent open from same IP + campaign (dedup)
      const since = new Date(Date.now() - DEDUP_MINUTES * 60 * 1000).toISOString();
      const checkRes = await fetch(
        SUPABASE_URL + '/rest/v1/campaign_opens?campaign_id=eq.' + encodeURIComponent(id) +
        '&ip_hash=eq.' + encodeURIComponent(ipHash) +
        '&opened_at=gte.' + encodeURIComponent(since) +
        '&limit=1',
        {
          headers: {
            'apikey': SUPABASE_ANON,
            'Authorization': 'Bearer ' + SUPABASE_ANON
          }
        }
      );

      if (checkRes.ok) {
        const existing = await checkRes.json();
        if (existing.length > 0) return; // Already logged recently, skip
      }

      // No recent duplicate — log this open
      await fetch(SUPABASE_URL + '/rest/v1/campaign_opens', {
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
          ip_hash: ipHash,
          opened_at: new Date().toISOString()
        })
      });
    } catch (e) {
      // Silently fail — don't break the pixel
    }
  }
};

// Hash IP for privacy (don't store raw IPs)
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + c;
    hash |= 0;
  }
  return hash.toString(36);
}
