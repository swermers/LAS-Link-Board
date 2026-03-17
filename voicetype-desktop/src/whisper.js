// ═══════════════════════════════════════
//  VoiceType — Whisper Transcription
// ═══════════════════════════════════════
//
// Three modes:
//   1. LOCAL — runs Whisper on-device via ONNX Runtime.
//      No audio leaves the machine. HIPAA-safe.
//   2. PROXY (default cloud) — sends audio to LinkBoard server,
//      which calls Whisper with the user's key server-side.
//      The API key never touches the desktop app.
//   3. DIRECT — calls OpenAI Whisper directly (fallback
//      if the proxy is unavailable).

const PROXY_URL = 'https://linkboard.vercel.app/api/voicetype/transcribe';

/**
 * Transcribe audio using the configured mode.
 *
 * @param {string} apiKey - OpenAI API key (used only for cloud modes)
 * @param {Buffer} audioBuffer - WAV file as a Buffer
 * @param {string} language - ISO 639-1 language code
 * @param {string} [authToken] - Supabase Bearer token for proxy auth
 * @param {string} [mode] - 'local', 'cloud', or 'direct'
 * @returns {Promise<string>} - Transcribed text
 */
async function transcribe(apiKey, audioBuffer, language = 'en', authToken = null, mode = 'cloud') {
  if (mode === 'local') {
    const { transcribeLocal } = require('./local-whisper');
    return transcribeLocal(audioBuffer, language);
  }

  // Cloud mode: try proxy first, fallback to direct
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
