// ═══════════════════════════════════════════════════
// Google Chat Webhook Proxy — POST /api/voicenotes/google-chat
// ═══════════════════════════════════════════════════
//
// Proxies messages to Google Chat incoming webhooks.
// Browser can't POST directly to Chat webhooks (CORS),
// so this serverless function handles it.
//
// Request: JSON { webhook_url, message }
// Auth: Bearer token from Supabase session

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

module.exports = async (req, res) => {
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
  const token = auth.replace('Bearer ', '');
  try {
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + token }
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Invalid session' });
  } catch (e) {
    return res.status(401).json({ error: 'Auth check failed' });
  }

  const { webhook_url, message } = req.body || {};
  if (!webhook_url || !message) {
    return res.status(400).json({ error: 'Missing webhook_url or message' });
  }

  // Validate webhook URL is a Google Chat webhook
  if (!webhook_url.startsWith('https://chat.googleapis.com/')) {
    return res.status(400).json({ error: 'Invalid Google Chat webhook URL' });
  }

  try {
    const chatRes = await fetch(webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(message)
    });

    if (chatRes.ok) {
      const data = await chatRes.json();
      return res.status(200).json({ success: true, name: data.name });
    } else {
      const errText = await chatRes.text();
      return res.status(chatRes.status).json({ error: 'Chat API error: ' + errText });
    }
  } catch (e) {
    return res.status(502).json({ error: 'Failed to send to Google Chat: ' + e.message });
  }
};
