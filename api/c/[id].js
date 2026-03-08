// Click tracking endpoint — logs campaign link clicks and redirects to destination
const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';

module.exports = async function handler(req, res) {
  const { id } = req.query;
  const dest = req.query.url || req.query.u;

  if (!id || !dest) {
    res.status(400).send('Missing parameters');
    return;
  }

  // Log the click
  try {
    const ua = req.headers['user-agent'] || '';
    const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';
    const ipHash = simpleHash(ip);

    await fetch(SUPABASE_URL + '/rest/v1/campaign_clicks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON,
        'Authorization': 'Bearer ' + SUPABASE_ANON,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        campaign_id: id,
        link_url: dest,
        user_agent: ua,
        ip_hash: ipHash,
        clicked_at: new Date().toISOString()
      })
    });
  } catch (e) {
    // Silently fail — don't break the redirect
  }

  // Redirect to destination
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
