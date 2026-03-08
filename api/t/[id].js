// Tracking pixel endpoint — serves a 1x1 transparent GIF and logs the open
const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';

// 1x1 transparent GIF (43 bytes)
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

// Dedup window: ignore duplicate opens from same IP within this many minutes
const DEDUP_MINUTES = 5;

// Grace period: ignore opens within this many seconds of campaign creation
// (Gmail image proxy pre-fetches pixels immediately at send time)
const GRACE_SECONDS = 60;

// Known image proxy / prefetch bot patterns in User-Agent strings
const BOT_PATTERNS = [
  'GoogleImageProxy',
  'ggpht.com',
  'YahooMailProxy',
  'Outlook-iOS-Android',
  'Microsoft Office',
  'fetch',
  'bot',
  'spider',
  'crawler'
];

function isBot(ua) {
  const lower = ua.toLowerCase();
  return BOT_PATTERNS.some(p => lower.includes(p.toLowerCase()));
}

module.exports = async function handler(req, res) {
  const { id } = req.query;

  // Log the open BEFORE responding (Vercel kills the function after res.end)
  if (id) {
    const ua = req.headers['user-agent'] || '';
    const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';
    const ipHash = simpleHash(ip);

    // Skip known bots and email proxy prefetchers
    const shouldLog = !isBot(ua);

    if (shouldLog) {
      try {
        // Fetch campaign created_at to enforce grace period
        const campRes = await fetch(
          SUPABASE_URL + '/rest/v1/campaigns?id=eq.' + id + '&select=created_at&limit=1',
          {
            headers: {
              'apikey': SUPABASE_ANON,
              'Authorization': 'Bearer ' + SUPABASE_ANON
            }
          }
        );
        const campData = await campRes.json();

        // Skip if campaign was created less than GRACE_SECONDS ago (prefetch at send time)
        if (campData && campData.length > 0) {
          const createdAt = new Date(campData[0].created_at).getTime();
          const now = Date.now();
          if ((now - createdAt) < GRACE_SECONDS * 1000) {
            // Within grace period — skip logging, still serve pixel
          } else {
            // Check DB for recent open from same IP (dedup across serverless instances)
            const cutoff = new Date(now - DEDUP_MINUTES * 60 * 1000).toISOString();
            const checkRes = await fetch(
              SUPABASE_URL + '/rest/v1/campaign_opens?campaign_id=eq.' + id +
                '&ip_hash=eq.' + ipHash +
                '&opened_at=gte.' + cutoff +
                '&select=id&limit=1',
              {
                headers: {
                  'apikey': SUPABASE_ANON,
                  'Authorization': 'Bearer ' + SUPABASE_ANON
                }
              }
            );
            const existing = await checkRes.json();

            if (!existing || existing.length === 0) {
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
            }
          }
        }
      } catch (e) {
        // Silently fail — don't break the pixel
      }
    }
  }

  // Serve the pixel after logging
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Content-Length', PIXEL.length);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.status(200).end(PIXEL);
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
