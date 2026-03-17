// ═══════════════════════════════════════════════════
// VoiceType Settings API — GET / PUT
// Called by the desktop Electron app on launch
// Auth: Bearer token from Supabase session
// ═══════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

module.exports = async (req, res) => {
  // CORS headers for desktop app
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Extract Bearer token
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = auth.slice(7);

  // Verify user via Supabase auth
  let user;
  try {
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'apikey': SERVICE_KEY || token, 'Authorization': 'Bearer ' + token }
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Unauthorized' });
    user = await userRes.json();
  } catch (e) {
    return res.status(500).json({ error: 'Auth verification failed' });
  }

  if (!user || !user.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apikey = SERVICE_KEY || token;

  if (req.method === 'GET') {
    // Fetch settings for this user
    try {
      const r = await fetch(
        SUPABASE_URL + '/rest/v1/voicetype_settings?user_id=eq.' + user.id + '&limit=1',
        { headers: { 'apikey': apikey, 'Authorization': 'Bearer ' + apikey } }
      );
      if (!r.ok) return res.status(500).json({ error: 'Failed to fetch settings' });
      const rows = await r.json();
      if (rows.length === 0) {
        return res.json({ hotkey: 'CommandOrControl+Shift+Space', language: 'en', auto_submit: false, openai_api_key: '' });
      }
      const s = rows[0];
      return res.json({
        hotkey: s.hotkey,
        language: s.language,
        auto_submit: s.auto_submit,
        openai_api_key: s.openai_api_key || ''
      });
    } catch (e) {
      return res.status(500).json({ error: 'Internal error' });
    }
  }

  if (req.method === 'PUT') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { hotkey, language, auto_submit, openai_api_key } = body || {};

    // Check if settings row exists
    try {
      const existRes = await fetch(
        SUPABASE_URL + '/rest/v1/voicetype_settings?user_id=eq.' + user.id + '&limit=1',
        { headers: { 'apikey': apikey, 'Authorization': 'Bearer ' + apikey } }
      );
      const existing = existRes.ok ? await existRes.json() : [];

      const payload = {
        user_id: user.id,
        hotkey: hotkey || 'CommandOrControl+Shift+Space',
        language: language || 'en',
        auto_submit: !!auto_submit,
        openai_api_key: openai_api_key || '',
        updated_at: new Date().toISOString()
      };

      let r;
      if (existing.length > 0) {
        r = await fetch(
          SUPABASE_URL + '/rest/v1/voicetype_settings?id=eq.' + existing[0].id,
          {
            method: 'PATCH',
            headers: {
              'apikey': apikey,
              'Authorization': 'Bearer ' + apikey,
              'Content-Type': 'application/json',
              'Prefer': 'return=representation'
            },
            body: JSON.stringify(payload)
          }
        );
      } else {
        r = await fetch(
          SUPABASE_URL + '/rest/v1/voicetype_settings',
          {
            method: 'POST',
            headers: {
              'apikey': apikey,
              'Authorization': 'Bearer ' + apikey,
              'Content-Type': 'application/json',
              'Prefer': 'return=representation'
            },
            body: JSON.stringify(payload)
          }
        );
      }

      if (!r.ok) {
        const err = await r.text();
        return res.status(500).json({ error: 'Failed to save: ' + err });
      }

      const saved = await r.json();
      return res.json(saved[0] || saved);
    } catch (e) {
      return res.status(500).json({ error: 'Internal error: ' + e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
