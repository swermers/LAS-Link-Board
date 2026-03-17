// ═══════════════════════════════════════════════════
// VoiceType Whisper Proxy — POST /api/voicetype/transcribe
// ═══════════════════════════════════════════════════
//
// The desktop app sends audio here instead of calling
// OpenAI directly. The API key never leaves the server.
//
// Request: multipart/form-data with "audio" file field
// Optional query: ?language=en
// Auth: Bearer token from Supabase session
// Response: { text: "transcribed text" }

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const token = auth.slice(7);

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
  if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });

  // Get user's OpenAI API key from settings
  const apikey = SERVICE_KEY || token;
  let openaiKey;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/voicetype_settings?user_id=eq.' + user.id + '&select=openai_api_key&limit=1',
      { headers: { 'apikey': apikey, 'Authorization': 'Bearer ' + apikey } }
    );
    if (!r.ok) return res.status(500).json({ error: 'Failed to fetch settings' });
    const rows = await r.json();
    openaiKey = rows[0]?.openai_api_key;
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch API key' });
  }

  if (!openaiKey) {
    return res.status(400).json({ error: 'No OpenAI API key configured. Set it in LinkBoard > VoiceType > Settings.' });
  }

  // Parse audio from request body
  // Vercel provides the raw body as a Buffer when bodyParser is disabled
  const language = req.query?.language || 'en';

  try {
    // Collect raw body chunks
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    if (body.length < 100) {
      return res.status(400).json({ error: 'Audio too short or missing' });
    }

    // Call OpenAI Whisper API with the user's key
    const boundary = '----VoiceTypeBoundary' + Date.now();
    const formParts = [];

    // model field
    formParts.push(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="model"\r\n\r\n' +
      'whisper-1\r\n'
    );

    // language field
    formParts.push(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="language"\r\n\r\n' +
      language + '\r\n'
    );

    // response_format field
    formParts.push(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="response_format"\r\n\r\n' +
      'text\r\n'
    );

    // audio file field
    const fileHeader =
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="recording.wav"\r\n' +
      'Content-Type: audio/wav\r\n\r\n';

    const ending = '\r\n--' + boundary + '--\r\n';

    const formBody = Buffer.concat([
      Buffer.from(formParts.join('')),
      Buffer.from(fileHeader),
      body,
      Buffer.from(ending)
    ]);

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + openaiKey,
        'Content-Type': 'multipart/form-data; boundary=' + boundary
      },
      body: formBody
    });

    if (!whisperRes.ok) {
      const errText = await whisperRes.text();
      console.error('Whisper API error:', whisperRes.status, errText);
      return res.status(502).json({ error: 'Whisper API error: ' + whisperRes.status });
    }

    const transcription = await whisperRes.text();

    // Log usage
    const durationSeconds = Math.max(1, Math.round(body.length / 32000));
    const costUsd = (durationSeconds / 60) * 0.006;
    try {
      await fetch(SUPABASE_URL + '/rest/v1/voicetype_usage', {
        method: 'POST',
        headers: {
          'apikey': apikey,
          'Authorization': 'Bearer ' + apikey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          user_id: user.id,
          duration_seconds: durationSeconds,
          cost_usd: costUsd.toFixed(6)
        })
      });
    } catch (e) {
      // Non-critical — don't fail the request
      console.error('Usage logging failed:', e.message);
    }

    return res.json({ text: transcription });

  } catch (e) {
    console.error('Transcription proxy error:', e);
    return res.status(500).json({ error: 'Transcription failed: ' + e.message });
  }
};

// Disable Vercel body parser so we get raw audio bytes
module.exports.config = { api: { bodyParser: false } };
