// ═══════════════════════════════════════
//  VoiceType — Whisper Transcription
// ═══════════════════════════════════════
//
// Four modes:
//   1. LOCAL — runs whisper.cpp natively on Apple Silicon (Metal GPU).
//      Blazing fast (~300ms for 10s audio). Falls back to ONNX if
//      whisper.cpp is not installed.
//   2. PROXY (default cloud) — sends audio to LinkBoard server,
//      which calls Whisper with the user's key server-side.
//   3. GROQ — sends audio to Groq's Whisper API (LPU-accelerated,
//      typically <500ms). Requires a free Groq API key.
//   4. DIRECT — calls OpenAI Whisper directly (fallback).

const PROXY_URL = 'https://las-link-board.vercel.app/api/voicetype/transcribe';

/**
 * Transcribe audio using the configured mode.
 *
 * @param {string} apiKey - OpenAI API key (used only for cloud/direct modes)
 * @param {Buffer} audioBuffer - WAV file as a Buffer
 * @param {string} language - ISO 639-1 language code
 * @param {string} [authToken] - Supabase Bearer token for proxy auth
 * @param {string} [mode] - 'local', 'cloud', 'groq', or 'direct'
 * @param {Object} [extra] - Extra options { groq_api_key }
 * @returns {Promise<string>} - Transcribed text
 */
async function transcribe(apiKey, audioBuffer, language = 'en', authToken = null, mode = 'cloud', extra = {}) {
  if (mode === 'local') {
    return transcribeLocalFast(audioBuffer, language);
  }

  if (mode === 'groq') {
    const groqKey = extra.groq_api_key;
    if (groqKey) {
      try {
        const text = await transcribeGroq(groqKey, audioBuffer, language);
        if (text) return text;
      } catch (e) {
        console.warn('Groq transcription failed, falling back to cloud:', e.message);
      }
    }
    // Fall through to cloud if Groq fails or no key
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
 * Fast local transcription via whisper.cpp (native Apple Silicon / Metal).
 * Falls back to ONNX-based transcription if whisper.cpp is not installed.
 */
async function transcribeLocalFast(audioBuffer, language) {
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  // Check if whisper.cpp CLI is available
  const whisperBin = findWhisperCpp();
  const modelPath = findWhisperModel();

  if (whisperBin && modelPath) {
    // Use whisper.cpp for native Metal-accelerated transcription
    const tmpWav = path.join(os.tmpdir(), 'voicetype-' + Date.now() + '.wav');
    const tmpOut = tmpWav + '.txt';

    try {
      fs.writeFileSync(tmpWav, audioBuffer);

      execFileSync(whisperBin, [
        '-m', modelPath,
        '-f', tmpWav,
        '-l', language,
        '--no-timestamps',
        '-otxt',
        '-of', tmpWav  // output file prefix (whisper.cpp appends .txt)
      ], {
        timeout: 15000,
        stdio: 'pipe'
      });

      // whisper.cpp writes to tmpWav.txt
      if (fs.existsSync(tmpOut)) {
        const text = fs.readFileSync(tmpOut, 'utf-8').trim();
        fs.unlinkSync(tmpWav);
        fs.unlinkSync(tmpOut);
        return text;
      }

      fs.unlinkSync(tmpWav);
      return '';
    } catch (e) {
      // Clean up temp files
      try { fs.unlinkSync(tmpWav); } catch {}
      try { fs.unlinkSync(tmpOut); } catch {}
      console.warn('whisper.cpp failed, falling back to ONNX:', e.message);
    }
  }

  // Fallback: ONNX-based local transcription (slower but always works)
  const { transcribeLocal } = require('./local-whisper');
  return transcribeLocal(audioBuffer, language);
}

/**
 * Find the whisper.cpp binary. Checks common install locations.
 */
function findWhisperCpp() {
  const { execFileSync } = require('child_process');
  const fs = require('fs');

  // Common locations
  const candidates = [
    '/opt/homebrew/bin/whisper-cpp',       // Homebrew ARM
    '/opt/homebrew/bin/whisper',            // Some installs
    '/usr/local/bin/whisper-cpp',           // Homebrew Intel
    '/usr/local/bin/whisper',
    '/usr/bin/whisper-cpp'
  ];

  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }

  // Try PATH lookup
  try {
    const result = execFileSync('which', ['whisper-cpp'], { stdio: 'pipe', timeout: 3000 });
    const p = result.toString().trim();
    if (p && fs.existsSync(p)) return p;
  } catch {}

  try {
    const result = execFileSync('which', ['whisper'], { stdio: 'pipe', timeout: 3000 });
    const p = result.toString().trim();
    if (p && fs.existsSync(p)) return p;
  } catch {}

  return null;
}

/**
 * Find a whisper.cpp GGML model file.
 */
function findWhisperModel() {
  const fs = require('fs');
  const path = require('path');
  const { app } = require('electron');

  const modelNames = [
    'ggml-base.en.bin',    // English-only base (fastest, ~150MB)
    'ggml-base.bin',       // Multilingual base
    'ggml-small.en.bin',   // English small (better accuracy, ~500MB)
    'ggml-small.bin',
    'ggml-medium.en.bin',
    'ggml-medium.bin',
    'ggml-large-v3.bin'
  ];

  // Check app data directory
  const appModelsDir = path.join(app ? app.getPath('userData') : '.', 'whisper-models');

  // Check common locations
  const dirs = [
    appModelsDir,
    path.join(require('os').homedir(), '.local', 'share', 'whisper-cpp'),
    '/opt/homebrew/share/whisper-cpp/models',
    '/usr/local/share/whisper-cpp/models',
    path.join(require('os').homedir(), 'whisper-models'),
    path.join(require('os').homedir(), '.cache', 'whisper')
  ];

  for (const dir of dirs) {
    for (const name of modelNames) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) return full;
    }
  }

  return null;
}

/**
 * Transcribe via Groq's Whisper API (LPU-accelerated, <500ms typical).
 * Groq uses an OpenAI-compatible API format.
 */
async function transcribeGroq(groqApiKey, audioBuffer, language) {
  const boundary = '----VoiceTypeGroq' + Date.now();
  const formParts = [];

  // model field — Groq's Whisper model
  formParts.push(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="model"\r\n\r\n' +
    'whisper-large-v3\r\n'
  );

  // language field
  formParts.push(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="language"\r\n\r\n' +
    language + '\r\n'
  );

  // response_format
  formParts.push(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="response_format"\r\n\r\n' +
    'text\r\n'
  );

  // audio file
  const fileHeader =
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="file"; filename="recording.wav"\r\n' +
    'Content-Type: audio/wav\r\n\r\n';

  const ending = '\r\n--' + boundary + '--\r\n';

  const formBody = Buffer.concat([
    Buffer.from(formParts.join('')),
    Buffer.from(fileHeader),
    audioBuffer,
    Buffer.from(ending)
  ]);

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + groqApiKey,
      'Content-Type': 'multipart/form-data; boundary=' + boundary
    },
    body: formBody,
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Groq API error ' + res.status + ': ' + errText);
  }

  const text = await res.text();
  return text.trim();
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

/**
 * Check if whisper.cpp is available for fast local transcription.
 */
function isWhisperCppAvailable() {
  return !!(findWhisperCpp() && findWhisperModel());
}

module.exports = { transcribe, isWhisperCppAvailable };
