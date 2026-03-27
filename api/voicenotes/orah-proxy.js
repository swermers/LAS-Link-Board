// ═══════════════════════════════════════════════════
// Orah API Proxy — POST /api/voicenotes/orah-proxy
// ═══════════════════════════════════════════════════
//
// Proxies requests to Orah's Open API to avoid CORS
// issues and keep API keys server-side.
//
// Request: JSON { region, api_key, endpoint, body }
// Auth: Bearer token from Supabase session
// Response: proxied Orah response

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth — verify Supabase token
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const token = auth.replace('Bearer ', '');
  try {
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + token }
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Invalid session' });
  } catch (e) {
    return res.status(401).json({ error: 'Auth check failed' });
  }

  const { region, api_key, endpoint, body } = req.body || {};
  if (!region || !api_key || !endpoint) {
    return res.status(400).json({ error: 'Missing region, api_key, or endpoint' });
  }

  // Orah Open API uses POST for all operations
  const orahUrl = region.replace(/\/$/, '') + '/' + endpoint.replace(/^\//, '');

  try {
    const orahRes = await fetch(orahUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + api_key
      },
      body: JSON.stringify(body || {})
    });

    const contentType = orahRes.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await orahRes.json();
      return res.status(orahRes.status).json(data);
    } else {
      const text = await orahRes.text();
      return res.status(orahRes.status).send(text);
    }
  } catch (e) {
    return res.status(502).json({ error: 'Orah API request failed: ' + e.message });
  }
};
