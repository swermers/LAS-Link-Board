// ═══════════════════════════════════════════════════
// VoiceType Format API — POST /api/voicetype/format
// ═══════════════════════════════════════════════════
//
// Takes raw transcribed text and formats it using the
// user's selected skill via Claude (Anthropic API).
//
// Mirrors the desktop skill-formatter.js logic so the
// web version has full formatting capability.
//
// Request body: { text, skill_id?, skill_name? }
//   - text: raw transcript to format
//   - skill_id: specific skill to use (optional)
//   - skill_name: fallback skill lookup by name
//   If neither skill_id nor skill_name provided,
//   auto-detects intent from transcript opening words.
//
// Response: { text, skill_name, skill_id }

const { decrypt } = require('./crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// ─── Intent detection ───

function detectIntent(transcript, skills) {
  if (!transcript || !skills || skills.length === 0) return null;
  const opening = transcript.toLowerCase().trim().slice(0, 80);

  for (const skill of skills) {
    if (!skill.trigger_phrases || skill.trigger_phrases.length === 0) continue;
    if (skill.category === 'raw') continue;
    for (const phrase of skill.trigger_phrases) {
      if (opening.includes(phrase.toLowerCase())) return skill;
    }
  }
  return null;
}

function stripTrigger(transcript, skill) {
  if (!skill || !skill.trigger_phrases) return transcript;
  const lower = transcript.toLowerCase();
  for (const phrase of skill.trigger_phrases) {
    const idx = lower.indexOf(phrase.toLowerCase());
    if (idx !== -1 && idx < 40) {
      const after = transcript.slice(idx + phrase.length).replace(/^[\s,.:;\u2014-]+/, '');
      const before = transcript.slice(0, idx).trim();
      return (before + ' ' + after).trim();
    }
  }
  return transcript;
}

function buildPrompt(skill, transcript) {
  let prompt = skill.system_prompt;

  // Ensure plain-text output for all skills (including custom ones)
  if (prompt && !prompt.includes('no markdown')) {
    prompt += '\n\nIMPORTANT: Output PLAIN TEXT only — no markdown formatting, no bold (**), no italics (*), no bullet symbols, no hashtags (#). Use simple line breaks and spacing for structure.';
  }

  const examples = skill.style_examples || [];
  if (examples.length > 0) {
    prompt += '\n\nHere are examples of the user\'s preferred style:\n';
    const recent = examples.slice(-3);
    recent.forEach((ex, i) => {
      prompt += `\n--- Example ${i + 1} ---\nInput: ${ex.input}\nOutput: ${ex.output}\n`;
    });
    prompt += '\nMatch this style closely.\n';
  }

  prompt += '\n\n---\nHere is the raw transcript:\n' + transcript;
  return prompt;
}

// ─── Main handler ───

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

  const apikey = SERVICE_KEY || token;
  const headers = {
    'apikey': apikey,
    'Authorization': 'Bearer ' + apikey,
    'Content-Type': 'application/json'
  };

  // Parse body
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { text, skill_id, skill_name } = body || {};

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  // ── Fetch user's Anthropic API key ──
  let anthropicKey = '';
  let anthropicBaseUrl = '';
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/voicetype_settings?user_id=eq.' + user.id + '&select=anthropic_api_key,anthropic_base_url&limit=1',
      { headers }
    );
    if (r.ok) {
      const rows = await r.json();
      if (rows.length > 0) {
        anthropicKey = decrypt(rows[0].anthropic_api_key || '');
        anthropicBaseUrl = rows[0].anthropic_base_url || '';
      }
    }
  } catch (e) {
    // continue — will fail later if key is needed
  }

  if (!anthropicKey) {
    return res.status(400).json({ error: 'No Anthropic API key configured. Add one in VoiceType > Settings to use AI formatting.' });
  }

  // ── Fetch user's skills ──
  let skills = [];
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/voicetype_skills?user_id=eq.' + user.id + '&order=is_default.desc,created_at.asc',
      { headers }
    );
    if (r.ok) skills = await r.json();
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch skills' });
  }

  // ── Resolve which skill to use ──
  let skill = null;

  if (skill_id) {
    skill = skills.find(s => s.id === skill_id);
  } else if (skill_name) {
    skill = skills.find(s => s.name.toLowerCase() === skill_name.toLowerCase());
  }

  // Auto-detect from transcript if no explicit skill
  if (!skill) {
    skill = detectIntent(text, skills);
  }

  // If still no skill or it's raw, return text as-is
  if (!skill || skill.category === 'raw' || !skill.system_prompt) {
    return res.json({ text: text, skill_name: 'Raw Transcript', skill_id: null, was_formatted: false });
  }

  // ── Call Claude API ──
  const cleanedText = stripTrigger(text, skill);
  const fullPrompt = buildPrompt(skill, cleanedText);

  try {
    const claudeUrl = (anthropicBaseUrl || 'https://api.anthropic.com') + '/v1/messages';

    const claudeRes = await fetch(claudeUrl, {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [{ role: 'user', content: fullPrompt }]
      })
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error('Claude API error:', claudeRes.status, errText);
      return res.status(502).json({ error: 'AI formatting failed (Claude API ' + claudeRes.status + ')' });
    }

    const claudeData = await claudeRes.json();
    const formatted = (claudeData.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    // ── Save feedback for self-learning ──
    try {
      const examples = skill.style_examples || [];
      examples.push({ input: text.slice(0, 500), output: (formatted || '').slice(0, 1000) });
      if (examples.length > 10) examples.splice(0, examples.length - 10);

      await fetch(
        SUPABASE_URL + '/rest/v1/voicetype_skills?id=eq.' + skill.id,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            style_examples: examples,
            use_count: (skill.use_count || 0) + 1,
            updated_at: new Date().toISOString()
          })
        }
      );
    } catch (e) {
      // Non-critical — don't fail the request
    }

    // ── Save training pair for future fine-tuning ──
    try {
      await fetch(SUPABASE_URL + '/rest/v1/lb_training_pairs', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          user_id: user.id,
          raw_transcript: text,
          final_output: formatted,
          output_type: skill.category || 'client_note',
          metadata: {
            skill_id: skill.id,
            skill_name: skill.name
          }
        })
      });
    } catch (e) {
      // Non-critical — don't fail the request
    }

    return res.json({
      text: formatted || text,
      skill_name: skill.name,
      skill_id: skill.id,
      was_formatted: true
    });

  } catch (e) {
    console.error('Format error:', e);
    return res.status(500).json({ error: 'Formatting failed: ' + e.message });
  }
};
