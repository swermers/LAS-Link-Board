// ═══════════════════════════════════════
//  VoiceType — SOAP Note Formatter
// ═══════════════════════════════════════
//
// Takes raw transcribed text from a therapy session
// and reformats it into a structured SOAP note in
// 3rd person. Uses Claude (Anthropic) by default.
//
// For HIPAA compliance:
//   - Use local transcription (Whisper on-device)
//   - Use a BAA-covered LLM endpoint (AWS Bedrock, Azure)
//   - Or run a local LLM (future)

const SOAP_PROMPT = `You are a clinical documentation assistant for a licensed therapist.
Convert the following raw session transcript into a properly formatted SOAP note.

Rules:
- Write in 3rd person (e.g., "The client reported..." not "I said...")
- Use professional clinical language
- Do NOT fabricate information not present in the transcript
- If information for a section is not available, write "Not addressed in this session."
- Keep it concise but thorough
- Do not include any identifying information beyond what's in the transcript

Format the output exactly as:

SUBJECTIVE (S):
[Client's reported symptoms, feelings, concerns, and relevant history as described during the session]

OBJECTIVE (O):
[Observable behaviors, affect, appearance, and any measurable data noted during the session]

ASSESSMENT (A):
[Clinical impressions, progress toward goals, and analysis of the client's current state]

PLAN (P):
[Treatment interventions discussed, homework assigned, next session goals, referrals, and follow-up items]

---
Here is the raw transcript:
`;

/**
 * Format transcribed text into a SOAP note using Claude.
 *
 * @param {string} transcript - Raw transcribed text
 * @param {Object} options
 * @param {string} [options.apiKey] - Anthropic API key
 * @param {string} [options.baseURL] - Custom API base URL (e.g., AWS Bedrock endpoint)
 * @param {string} [options.model] - Model ID (default: claude-haiku-4-5-20251001)
 * @returns {Promise<string>} - Formatted SOAP note
 */
async function formatSOAPNote(transcript, options = {}) {
  if (!transcript || !transcript.trim()) {
    return transcript;
  }

  const Anthropic = require('@anthropic-ai/sdk');

  const clientOptions = {};
  if (options.apiKey) clientOptions.apiKey = options.apiKey;
  if (options.baseURL) clientOptions.baseURL = options.baseURL;

  const client = new Anthropic(clientOptions);

  const response = await client.messages.create({
    model: options.model || 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: SOAP_PROMPT + transcript
      }
    ]
  });

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');

  return text || transcript;
}

module.exports = { formatSOAPNote };
