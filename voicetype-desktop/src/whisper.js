// ═══════════════════════════════════════
//  VoiceType — Whisper Transcription
// ═══════════════════════════════════════
//
// Two modes:
//   1. PROXY (default) — sends audio to LinkBoard server,
//      which calls Whisper with the user's key server-side.
//      The API key never touches the desktop app.
//   2. DIRECT — calls OpenAI Whisper directly (fallback
//      if the proxy is unavailable).

const PROXY_URL = 'https://linkboard.vercel.app/api/voicetype/transcribe';

/**
 * Transcribe audio via the server-side proxy first,
 * falling back to direct OpenAI call if proxy fails.
 *
 * @param {string} apiKey - OpenAI API key (used only for direct fallback)
 * @param {Buffer} audioBuffer - WAV file as a Buffer
 * @param {string} language - ISO 639-1 language code
 * @param {string} [authToken] - Supabase Bearer token for proxy auth
 * @returns {Promise<string>} - Transcribed text
 */
async function transcribe(apiKey, audioBuffer, language = 'en', authToken = null) {
  // Try proxy first (keeps API key server-side)
  if (authToken) {
    try {
      const text = await transcribeViaProxy(audioBuffer, language, authToken);
      if (text) return text;
    } catch (e) {
      console.warn('Proxy transcription failed, falling back to direct:', e.message);
    }
  }

  // Fallback: direct OpenAI call
  return transcribeDirect(apiKey, audioBuffer, language);
}

/**
 * Send audio to LinkBoard proxy which calls Whisper server-side.
 */
async function transcribeViaProxy(audioBuffer, language, authToken) {
  const res = await fetch(PROXY_URL + '?language=' + encodeURIComponent(language), {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + authToken,
      'Content-Type': 'audio/wav'
    },
    body: audioBuffer,
    signal: AbortSignal.timeout(30000)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Proxy error ' + res.status + ': ' + errText);
  }

  const data = await res.json();
  return data.text || '';
}

/**
 * Call OpenAI Whisper API directly (fallback).
 */
async function transcribeDirect(apiKey, audioBuffer, language) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey });

  const file = new File([audioBuffer], 'recording.wav', { type: 'audio/wav' });

  const response = await client.audio.transcriptions.create({
    model: 'whisper-1',
    file: file,
    language: language,
    response_format: 'text'
  });

  return typeof response === 'string' ? response : response.text || '';
}

module.exports = { transcribe };
