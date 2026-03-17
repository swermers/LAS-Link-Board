// ═══════════════════════════════════════════════════════
// VoiceType Skills API — GET / POST / PUT / DELETE
// Manages user's formatting skills (presets + custom).
// Auto-generates preset skills on first GET if none exist.
//
// GET    → list all skills for user (auto-seeds presets)
// POST   → create a new custom skill
// PUT    → update a skill (name, prompt, triggers, examples)
// DELETE → delete a skill (by ?id=...)
//
// POST /api/voicetype/skills?action=feedback
//   → self-learning: save a style example to a skill
// ═══════════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Preset skills — seeded on first load
const PRESET_SKILLS = [
  {
    name: 'Raw Transcript',
    category: 'raw',
    system_prompt: '',
    trigger_phrases: [],
    is_default: true,
    is_preset: true
  },
  {
    name: 'SOAP Note',
    category: 'clinical',
    system_prompt: 'You are a clinical documentation assistant.\nConvert the following raw transcript into a properly formatted SOAP note.\n\nRules:\n- Write in 3rd person\n- Use professional clinical language\n- Do NOT fabricate information not present in the transcript\n- If information for a section is not available, write "Not addressed in this session."\n- Keep it concise but thorough\n\nFormat:\n\nSUBJECTIVE (S):\n[Client\'s reported symptoms, feelings, concerns]\n\nOBJECTIVE (O):\n[Observable behaviors, affect, appearance, measurable data]\n\nASSESSMENT (A):\n[Clinical impressions, progress toward goals]\n\nPLAN (P):\n[Interventions, homework, next session goals, referrals]',
    trigger_phrases: ['soap note', 'clinical note for therapy', 'session note', 'therapy note'],
    is_preset: true
  },
  {
    name: 'Parent Email',
    category: 'email',
    system_prompt: 'You are a professional writing assistant for school staff.\nConvert the following raw dictation into a clear, warm, professional email to a parent or guardian.\n\nRules:\n- Warm but professional tone\n- Clear and direct about the purpose\n- Include action items or next steps\n- Do not fabricate details\n- Add greeting and sign-off\n- Keep it concise\n\nFormat as a ready-to-send email with Subject line, greeting, body, and sign-off.',
    trigger_phrases: ['writing an email to a parent', 'email to parent', 'parent email', 'email to mom', 'email to dad', 'email to guardian'],
    is_preset: true
  },
  {
    name: 'Clinical Note',
    category: 'clinical',
    system_prompt: 'You are a clinical documentation assistant for healthcare staff.\nConvert the following raw dictation into a concise clinical encounter note.\n\nRules:\n- Use clinical shorthand where appropriate\n- Write in 3rd person\n- Do NOT fabricate information\n- Keep it brief and direct\n\nFormat:\nCC: [chief complaint]\nVitals: [if mentioned]\nAssessment: [findings]\nIntervention: [what was done]\nDisposition: [outcome]',
    trigger_phrases: ['clinical note', 'nurse note', 'health note', 'patient note', 'encounter note', 'health office'],
    is_preset: true
  },
  {
    name: 'Professional Email',
    category: 'email',
    system_prompt: 'You are a professional writing assistant.\nConvert the following raw dictation into a polished professional email.\n\nRules:\n- Professional, clear, concise tone\n- Include subject line, greeting, body, sign-off\n- Organize key points logically\n- Include action items if mentioned\n- Do not fabricate details',
    trigger_phrases: ['writing an email', 'email to', 'send an email', 'draft an email', 'compose an email'],
    is_preset: true
  },
  {
    name: 'Quick Chat',
    category: 'chat',
    system_prompt: 'You are a writing assistant that converts spoken dictation into concise chat messages.\n\nRules:\n- Brief and conversational\n- Match the speaker\'s tone\n- No greeting or sign-off unless the speaker includes one\n- Strip filler words and false starts\n- One clear message, ready to paste into Slack/Teams/chat',
    trigger_phrases: ['quick message', 'slack message', 'chat message', 'teams message', 'text message', 'message to'],
    is_preset: true
  }
];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

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

  // ─── GET: list skills (auto-seed presets if none exist) ───
  if (req.method === 'GET') {
    try {
      const r = await fetch(
        SUPABASE_URL + '/rest/v1/voicetype_skills?user_id=eq.' + user.id + '&order=is_default.desc,created_at.asc',
        { headers }
      );
      if (!r.ok) return res.status(500).json({ error: 'Failed to fetch skills' });
      let skills = await r.json();

      // Auto-seed presets on first load
      if (skills.length === 0) {
        const seeded = [];
        for (const preset of PRESET_SKILLS) {
          const row = {
            user_id: user.id,
            name: preset.name,
            category: preset.category,
            system_prompt: preset.system_prompt,
            trigger_phrases: preset.trigger_phrases,
            is_default: preset.is_default || false,
            is_preset: true,
            use_count: 0,
            style_examples: []
          };
          const sr = await fetch(SUPABASE_URL + '/rest/v1/voicetype_skills', {
            method: 'POST',
            headers: { ...headers, 'Prefer': 'return=representation' },
            body: JSON.stringify(row)
          });
          if (sr.ok) {
            const created = await sr.json();
            seeded.push(created[0] || created);
          }
        }
        return res.json(seeded);
      }

      return res.json(skills);
    } catch (e) {
      return res.status(500).json({ error: 'Internal error: ' + e.message });
    }
  }

  // ─── POST: create skill or submit feedback ───
  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const action = req.query?.action || new URL(req.url, 'http://localhost').searchParams.get('action');

    // Self-learning feedback: append a style example to a skill
    if (action === 'feedback') {
      const { skill_id, input, output } = body || {};
      if (!skill_id || !input || !output) {
        return res.status(400).json({ error: 'skill_id, input, and output are required' });
      }

      try {
        // Fetch current skill
        const sr = await fetch(
          SUPABASE_URL + '/rest/v1/voicetype_skills?id=eq.' + skill_id + '&user_id=eq.' + user.id + '&limit=1',
          { headers }
        );
        if (!sr.ok) return res.status(500).json({ error: 'Failed to fetch skill' });
        const rows = await sr.json();
        if (rows.length === 0) return res.status(404).json({ error: 'Skill not found' });

        const skill = rows[0];
        const examples = skill.style_examples || [];
        examples.push({ input: input.slice(0, 500), output: output.slice(0, 1000) });
        // Keep max 10 examples, drop oldest
        if (examples.length > 10) examples.splice(0, examples.length - 10);

        const ur = await fetch(
          SUPABASE_URL + '/rest/v1/voicetype_skills?id=eq.' + skill_id,
          {
            method: 'PATCH',
            headers: { ...headers, 'Prefer': 'return=representation' },
            body: JSON.stringify({
              style_examples: examples,
              use_count: (skill.use_count || 0) + 1,
              updated_at: new Date().toISOString()
            })
          }
        );
        if (!ur.ok) return res.status(500).json({ error: 'Failed to save feedback' });
        const updated = await ur.json();
        return res.json(updated[0] || updated);
      } catch (e) {
        return res.status(500).json({ error: 'Internal error: ' + e.message });
      }
    }

    // Create new skill
    const { name, category, system_prompt, trigger_phrases } = body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });

    try {
      const row = {
        user_id: user.id,
        name,
        category: category || 'custom',
        system_prompt: system_prompt || '',
        trigger_phrases: trigger_phrases || [],
        is_default: false,
        is_preset: false,
        use_count: 0,
        style_examples: []
      };
      const cr = await fetch(SUPABASE_URL + '/rest/v1/voicetype_skills', {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify(row)
      });
      if (!cr.ok) {
        const err = await cr.text();
        return res.status(500).json({ error: 'Failed to create: ' + err });
      }
      const created = await cr.json();
      return res.status(201).json(created[0] || created);
    } catch (e) {
      return res.status(500).json({ error: 'Internal error: ' + e.message });
    }
  }

  // ─── PUT: update skill ───
  if (req.method === 'PUT') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { id, name, category, system_prompt, trigger_phrases, is_default } = body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });

    try {
      const payload = { updated_at: new Date().toISOString() };
      if (name !== undefined) payload.name = name;
      if (category !== undefined) payload.category = category;
      if (system_prompt !== undefined) payload.system_prompt = system_prompt;
      if (trigger_phrases !== undefined) payload.trigger_phrases = trigger_phrases;

      // If setting as default, unset all others first
      if (is_default) {
        await fetch(
          SUPABASE_URL + '/rest/v1/voicetype_skills?user_id=eq.' + user.id + '&is_default=eq.true',
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ is_default: false })
          }
        );
        payload.is_default = true;
      }

      const ur = await fetch(
        SUPABASE_URL + '/rest/v1/voicetype_skills?id=eq.' + id + '&user_id=eq.' + user.id,
        {
          method: 'PATCH',
          headers: { ...headers, 'Prefer': 'return=representation' },
          body: JSON.stringify(payload)
        }
      );
      if (!ur.ok) {
        const err = await ur.text();
        return res.status(500).json({ error: 'Failed to update: ' + err });
      }
      const updated = await ur.json();
      return res.json(updated[0] || updated);
    } catch (e) {
      return res.status(500).json({ error: 'Internal error: ' + e.message });
    }
  }

  // ─── DELETE: remove a skill ───
  if (req.method === 'DELETE') {
    const skillId = req.query?.id || new URL(req.url, 'http://localhost').searchParams.get('id');
    if (!skillId) return res.status(400).json({ error: 'id query param required' });

    try {
      const dr = await fetch(
        SUPABASE_URL + '/rest/v1/voicetype_skills?id=eq.' + skillId + '&user_id=eq.' + user.id,
        { method: 'DELETE', headers }
      );
      if (!dr.ok) return res.status(500).json({ error: 'Failed to delete' });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Internal error: ' + e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
