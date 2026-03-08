// Click tracking endpoint — logs link clicks and redirects to destination
// Uses path-based encoding: /api/c/[campaignId]/[base64url_destination]
// This avoids query-param mangling by Gmail and other email clients.
const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';

function base64urlDecode(str) {
  // Restore standard base64 from base64url
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return Buffer.from(b64, 'base64').toString('utf-8');
}

module.exports = async function handler(req, res) {
  const params = req.query.params || [];

  // Support two formats:
  // 1. New: /api/c/[campaignId]/[base64url_destination]  (path-based, preferred)
  // 2. Legacy: /api/c/[campaignId]?u=[destination]       (query-param fallback)
  let campaignId, dest;

  if (params.length >= 2) {
    // Path-based: /api/c/campaignId/base64urlDest
    campaignId = params[0];
    dest = base64urlDecode(params.slice(1).join('/'));
  } else if (params.length === 1) {
    // Legacy query-param: /api/c/campaignId?u=dest
    campaignId = params[0];
    dest = req.query.url || req.query.u;
  }

  if (!campaignId || !dest) {
    res.status(400).send('Missing parameters');
    return;
  }

  // Log the click — truly fire-and-forget so redirect is instant
  const ua = req.headers['user-agent'] || '';
  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';
  const ipHash = simpleHash(ip);

  fetch(SUPABASE_URL + '/rest/v1/campaign_clicks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON,
      'Authorization': 'Bearer ' + SUPABASE_ANON,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({
      campaign_id: campaignId,
      link_url: dest,
      user_agent: ua,
      ip_hash: ipHash,
      clicked_at: new Date().toISOString()
    })
  }).catch(e => console.error('click log error:', e.message));

  // Redirect to destination immediately
  res.writeHead(302, { Location: dest });
  res.end();
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
