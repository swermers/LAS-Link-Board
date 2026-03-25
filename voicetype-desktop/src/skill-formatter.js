// ═══════════════════════════════════════
//  VoiceType — Skill Formatter
// ═══════════════════════════════════════
//
// Replaces soap-formatter.js with a generalized system.
// Takes raw transcribed text and reshapes it using the
// user's selected skill (or auto-detected from speech).
//
// Features:
//   - Intent detection from opening words
//   - Preset skills (email, SOAP, clinical note, chat)
//   - Custom user-created skills
//   - Self-learning via style examples
//
// For HIPAA compliance:
//   - Use local transcription (Whisper on-device)
//   - Use a BAA-covered LLM endpoint (AWS Bedrock, Azure)

// ─── Preset skill definitions ───
// These are auto-generated for new users and can be customized.

const PRESET_SKILLS = [
  {
    name: 'Raw Transcript',
    category: 'raw',
    system_prompt: '',
    trigger_phrases: [],
    is_default: true
  },
  {
    name: 'SOAP Note',
    category: 'clinical',
    system_prompt: `You are a clinical documentation assistant.
Convert the following raw transcript into a properly formatted SOAP note.

Rules:
- Write in 3rd person (e.g., "The client reported..." not "I said...")
- Use professional clinical language
- Do NOT fabricate information not present in the transcript
- If information for a section is not available, write "Not addressed in this session."
- Keep it concise but thorough
- Output PLAIN TEXT only — no markdown, no bold, no italics, no bullet symbols, no hashtags, no asterisks
- Use simple line breaks and indentation for structure

Format the output exactly as:

SUBJECTIVE (S):
[Client's reported symptoms, feelings, concerns, and relevant history]

OBJECTIVE (O):
[Observable behaviors, affect, appearance, and any measurable data]

ASSESSMENT (A):
[Clinical impressions, progress toward goals, current state analysis]

PLAN (P):
[Treatment interventions, homework, next session goals, referrals, follow-up]`,
    trigger_phrases: ['soap note', 'clinical note for therapy', 'session note', 'therapy note']
  },
  {
    name: 'Parent Email',
    category: 'email',
    system_prompt: `You are a professional writing assistant for school staff.
Convert the following raw dictation into a clear, warm, professional email to a parent or guardian.

Rules:
- Use a warm but professional tone
- Be clear and direct about the purpose
- Include any action items or next steps
- Do not fabricate details not in the transcript
- Add an appropriate greeting and sign-off
- Keep it concise — parents are busy
- If the speaker mentions their name/role, use it in the sign-off
- Output PLAIN TEXT only — no markdown, no bold, no italics, no asterisks, no hashtags
- Format as a clean, ready-to-send email: Subject line on its own line, then a blank line, then greeting, body paragraphs, and sign-off
- Use natural paragraph breaks, not bullet points`,
    trigger_phrases: ['writing an email to a parent', 'email to parent', 'parent email', 'email to mom', 'email to dad', 'email to guardian', 'letter to parent']
  },
  {
    name: 'Clinical Note',
    category: 'clinical',
    system_prompt: `You are a clinical documentation assistant for healthcare staff (school nurse, nurse practitioner, clinic staff).
Convert the following raw dictation into a concise clinical encounter note.

Rules:
- Use clinical shorthand where appropriate
- Structure: Chief Complaint, Vitals (if mentioned), Assessment, Intervention, Disposition
- Write in 3rd person
- Do NOT fabricate information
- Keep it brief and direct — designed for quick EHR entry
- If vitals or specific data aren't mentioned, omit that section
- Output PLAIN TEXT only — no markdown, no bold, no italics, no asterisks, no hashtags
- Use simple labels and line breaks for structure

Format:
CC: [chief complaint]
Vitals: [if mentioned]
Assessment: [findings]
Intervention: [what was done]
Disposition: [outcome — returned to class, sent home, etc.]`,
    trigger_phrases: ['clinical note', 'nurse note', 'health note', 'patient note', 'encounter note', 'health office']
  },
  {
    name: 'Professional Email',
    category: 'email',
    system_prompt: `You are a professional writing assistant.
Convert the following raw dictation into a polished professional email.

Rules:
- Professional, clear, and concise tone
- Include subject line, greeting, body, and sign-off
- Organize key points logically
- Include action items or next steps if mentioned
- Do not fabricate details
- Match the level of formality implied by the speaker
- Output PLAIN TEXT only — no markdown, no bold, no italics, no asterisks, no hashtags
- Format as a clean, ready-to-send email: Subject line on its own line, then a blank line, then greeting, body paragraphs, and sign-off
- Use natural paragraph breaks, not bullet points`,
    trigger_phrases: ['writing an email', 'email to', 'send an email', 'draft an email', 'compose an email']
  },
  {
    name: 'Quick Chat',
    category: 'chat',
    system_prompt: `You are a writing assistant that converts spoken dictation into concise chat messages.

Rules:
- Keep it brief and conversational
- Match the speaker's tone (casual, urgent, informational)
- No greeting or sign-off unless the speaker includes one
- Strip filler words and false starts
- One clear message, ready to paste into Slack/Teams/chat
- Output PLAIN TEXT only — no markdown, no bold, no italics, no asterisks, no hashtags`,
    trigger_phrases: ['quick message', 'slack message', 'chat message', 'teams message', 'text message', 'message to']
  }
];

/**
 * Detect which skill to use based on the opening words of the transcript.
 * Returns the matching skill or null (meaning use the user's default/selected skill).
 *
 * @param {string} transcript - Raw transcribed text
 * @param {Array} skills - User's skill list [{name, trigger_phrases, ...}]
 * @returns {Object|null} - Matched skill or null
 */
function detectIntent(transcript, skills) {
  if (!transcript || !skills || skills.length === 0) return null;

  const lower = transcript.toLowerCase().trim();
  // Only check the first ~80 chars for intent triggers
  const opening = lower.slice(0, 80);

  for (const skill of skills) {
    if (!skill.trigger_phrases || skill.trigger_phrases.length === 0) continue;
    if (skill.category === 'raw') continue;

    for (const phrase of skill.trigger_phrases) {
      if (opening.includes(phrase.toLowerCase())) {
        return skill;
      }
    }
  }

  return null;
}

/**
 * Strip the trigger phrase from the beginning of the transcript
 * so the AI doesn't echo it in the output.
 *
 * @param {string} transcript - Raw text
 * @param {Object} skill - Matched skill with trigger_phrases
 * @returns {string} - Cleaned transcript
 */
function stripTrigger(transcript, skill) {
  if (!skill || !skill.trigger_phrases) return transcript;

  const lower = transcript.toLowerCase();
  for (const phrase of skill.trigger_phrases) {
    const idx = lower.indexOf(phrase.toLowerCase());
    if (idx !== -1 && idx < 40) {
      // Remove the trigger phrase and any trailing punctuation/whitespace
      const after = transcript.slice(idx + phrase.length).replace(/^[\s,.:;—-]+/, '');
      const before = transcript.slice(0, idx).trim();
      return (before + ' ' + after).trim();
    }
  }
  return transcript;
}

/**
 * Build the full prompt including style examples for self-learning.
 *
 * @param {Object} skill - Skill object
 * @param {string} transcript - Raw transcript (trigger already stripped)
 * @returns {string} - Full prompt for Claude
 */
function buildPrompt(skill, transcript) {
  let prompt = skill.system_prompt;

  // Ensure plain-text output for all skills (including custom ones)
  if (prompt && !prompt.includes('no markdown')) {
    prompt += '\n\nIMPORTANT: Output PLAIN TEXT only — no markdown formatting, no bold (**), no italics (*), no bullet symbols, no hashtags (#). Use simple line breaks and spacing for structure.';
  }

  // Inject style examples if the user has saved any (self-learning)
  const examples = skill.style_examples || [];
  if (examples.length > 0) {
    prompt += '\n\nHere are examples of the user\'s preferred style:\n';
    // Use the most recent examples (max 3 to keep context reasonable)
    const recent = examples.slice(-3);
    recent.forEach((ex, i) => {
      prompt += `\n--- Example ${i + 1} ---\nInput: ${ex.input}\nOutput: ${ex.output}\n`;
    });
    prompt += '\nMatch this style closely.\n';
  }

  prompt += '\n\n---\nHere is the raw transcript:\n' + transcript;
  return prompt;
}

/**
 * Format transcribed text using a skill's system prompt via Claude.
 *
 * @param {string} transcript - Raw transcribed text
 * @param {Object} skill - Skill to apply (must have system_prompt)
 * @param {Object} options
 * @param {string} [options.apiKey] - Anthropic API key
 * @param {string} [options.baseURL] - Custom API base URL
 * @param {string} [options.model] - Model ID
 * @returns {Promise<string>} - Formatted text
 */
async function formatWithSkill(transcript, skill, options = {}) {
  if (!transcript || !transcript.trim()) return transcript;
  if (!skill || !skill.system_prompt || skill.category === 'raw') return transcript;

  const Anthropic = require('@anthropic-ai/sdk');

  const clientOptions = {};
  if (options.apiKey) clientOptions.apiKey = options.apiKey;
  if (options.baseURL) clientOptions.baseURL = options.baseURL;

  const client = new Anthropic(clientOptions);

  const cleanedTranscript = stripTrigger(transcript, skill);
  const fullPrompt = buildPrompt(skill, cleanedTranscript);

  const response = await client.messages.create({
    model: options.model || 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{ role: 'user', content: fullPrompt }]
  });

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');

  return text || transcript;
}

/**
 * Main entry point: auto-detect intent OR use selected skill, then format.
 *
 * @param {string} transcript - Raw transcribed text
 * @param {Object} options
 * @param {Array}  [options.skills] - User's full skill list
 * @param {Object} [options.selectedSkill] - Explicitly selected skill (overrides auto-detect)
 * @param {string} [options.apiKey] - Anthropic API key
 * @param {string} [options.baseURL] - Custom API base URL
 * @param {string} [options.model] - Model ID
 * @returns {Promise<{text: string, skill: Object|null}>} - Formatted text + which skill was used
 */
async function processTranscription(transcript, options = {}) {
  const { skills = [], selectedSkill = null } = options;

  // If user explicitly selected a skill, use it
  let skill = selectedSkill;

  // Otherwise, try auto-detecting from the transcript's opening words
  if (!skill) {
    skill = detectIntent(transcript, skills);
  }

  // If no skill detected or it's raw, return as-is
  if (!skill || skill.category === 'raw' || !skill.system_prompt) {
    return { text: transcript, skill: null };
  }

  const formatted = await formatWithSkill(transcript, skill, {
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    model: options.model
  });

  return { text: formatted, skill };
}

// Backwards-compatible: keep formatSOAPNote working for existing code
async function formatSOAPNote(transcript, options = {}) {
  const soapSkill = PRESET_SKILLS.find(s => s.name === 'SOAP Note');
  return formatWithSkill(transcript, soapSkill, options);
}

module.exports = {
  PRESET_SKILLS,
  detectIntent,
  stripTrigger,
  formatWithSkill,
  processTranscription,
  formatSOAPNote
};
