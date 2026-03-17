// ═══════════════════════════════════════════════════
// VoiceType Settings API — GET / PUT
// Called by the desktop Electron app on launch
// Auth: Bearer token from Supabase session
//
// API keys are encrypted with AES-256-GCM before
// being stored in Supabase. Only this server-side
// code can decrypt them.
// ═══════════════════════════════════════════════════

const { encrypt, decrypt } = require('./crypto');

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
        return res.json({ hotkey: 'CommandOrControl+Shift+Space', language: 'en', auto_submit: false, openai_api_key: '', transcription_mode: 'cloud', soap_notes: false, active_skill_id: null, anthropic_api_key: '', anthropic_base_url: '' });
      }
      const s = rows[0];
      return res.json({
        hotkey: s.hotkey,
        language: s.language,
        auto_submit: s.auto_submit,
        transcription_mode: s.transcription_mode || 'cloud',
        soap_notes: !!s.soap_notes,
        active_skill_id: s.active_skill_id || null,
        anthropic_base_url: s.anthropic_base_url || '',
        // Decrypt API keys before returning
        openai_api_key: decrypt(s.openai_api_key || ''),
        anthropic_api_key: decrypt(s.anthropic_api_key || '')
      });
    } catch (e) {
      return res.status(500).json({ error: 'Internal error' });
    }
  }

  if (req.method === 'PUT') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { hotkey, language, auto_submit, openai_api_key, transcription_mode, soap_notes, active_skill_id, anthropic_api_key, anthropic_base_url } = body || {};

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
        transcription_mode: transcription_mode || 'cloud',
        soap_notes: !!soap_notes,
        active_skill_id: active_skill_id || null,
        anthropic_base_url: anthropic_base_url || '',
        // Encrypt API keys before storing
        openai_api_key: encrypt(openai_api_key || ''),
        anthropic_api_key: encrypt(anthropic_api_key || ''),
        updated_at: new Date().toISOString()
      };

      // Helper to upsert settings, with fallback if active_skill_id column missing
      async function upsertSettings(data) {
        const url = existing.length > 0
          ? SUPABASE_URL + '/rest/v1/voicetype_settings?id=eq.' + existing[0].id
          : SUPABASE_URL + '/rest/v1/voicetype_settings';
        return fetch(url, {
          method: existing.length > 0 ? 'PATCH' : 'POST',
          headers: {
            'apikey': apikey,
            'Authorization': 'Bearer ' + apikey,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify(data)
        });
      }

      let r = await upsertSettings(payload);

      // If save failed, retry without active_skill_id (column may not exist yet)
      if (!r.ok) {
        const errText = await r.text();
        if (errText.includes('active_skill_id') || errText.includes('skill')) {
          const { active_skill_id: _skip, ...fallbackPayload } = payload;
          r = await upsertSettings(fallbackPayload);
        }
        if (!r.ok) {
          const err2 = await r.text().catch(() => errText);
          return res.status(500).json({ error: 'Failed to save: ' + err2 });
        }
      }

      const saved = await r.json();
      return res.json(saved[0] || saved);
    } catch (e) {
      return res.status(500).json({ error: 'Internal error: ' + e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
