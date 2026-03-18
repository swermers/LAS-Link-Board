// ═══════════════════════════════════════
//  VoiceType — Microphone Recorder
// ═══════════════════════════════════════
//
// Captures audio from the system microphone into a WAV buffer.
// Primary: uses Web Audio API via Electron's renderer process (no external deps).
// Fallback: uses node-record-lpcm16 + SoX if available.

const record = require('node-record-lpcm16');
const { execFileSync } = require('child_process');

let recording = null;
let audioChunks = [];
let soxAvailable = null; // cached check result

// Browser-based recording state (managed via IPC from indicator window)
let browserAudioResolve = null;
let browserAudioBuffer = null;
let useBrowserRecording = false;

/**
 * Check if SoX (rec/sox) is installed and available on PATH.
 */
function checkSoxInstalled() {
  if (soxAvailable !== null) return soxAvailable;
  const cmd = process.platform === 'win32' ? 'sox' : 'rec';
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore', timeout: 3000 });
    soxAvailable = true;
  } catch {
    soxAvailable = false;
  }
  return soxAvailable;
}

/**
 * Start recording audio from the default microphone.
 * Uses browser-based recording if SoX is not installed.
 */
function startRecording() {
  if (useBrowserRecording) {
    // Browser recording is started via IPC in the indicator window
    browserAudioBuffer = null;
    return;
  }

  if (!checkSoxInstalled()) {
    // Switch to browser-based recording permanently for this session
    useBrowserRecording = true;
    browserAudioBuffer = null;
    return;
  }

  audioChunks = [];

  recording = record.record({
    sampleRate: 16000,
    channels: 1,
    audioType: 'wav',
    recorder: process.platform === 'win32' ? 'sox' : 'rec',
    silence: '0',
    threshold: 0
  });

  recording.stream().on('data', (chunk) => {
    audioChunks.push(chunk);
  });

  recording.stream().on('error', (err) => {
    console.error('Recording stream error:', err);
  });
}

/**
 * Stop recording and return the complete audio as a WAV Buffer.
 * Returns null if no audio was captured.
 * For browser recording, returns a Promise that resolves with the buffer.
 */
function stopRecording() {
  if (useBrowserRecording) {
    // Return a promise that resolves when browser sends audio data via IPC
    return new Promise((resolve) => {
      browserAudioResolve = resolve;
      // Timeout after 5s in case something goes wrong
      setTimeout(() => {
        if (browserAudioResolve) {
          browserAudioResolve(null);
          browserAudioResolve = null;
        }
      }, 5000);
    });
  }

  if (recording) {
    recording.stop();
    recording = null;
  }

  if (audioChunks.length === 0) return null;

  const pcmData = Buffer.concat(audioChunks);
  audioChunks = [];

  // If the recorder already outputs WAV format, return as-is
  if (pcmData.length > 44 && pcmData.toString('ascii', 0, 4) === 'RIFF') {
    return pcmData;
  }

  // Otherwise wrap raw PCM in a WAV header
  return createWavBuffer(pcmData, 16000, 1, 16);
}

/**
 * Called from IPC when browser-based recording delivers audio data.
 */
function onBrowserAudioData(wavArrayBuffer) {
  const buffer = Buffer.from(wavArrayBuffer);
  if (browserAudioResolve) {
    browserAudioResolve(buffer);
    browserAudioResolve = null;
  } else {
    browserAudioBuffer = buffer;
  }
}

/**
 * Returns true if browser-based recording is being used.
 */
function isBrowserRecording() {
  if (useBrowserRecording) return true;
  // Auto-detect on first call
  if (!checkSoxInstalled()) {
    useBrowserRecording = true;
    return true;
  }
  return false;
}

/**
 * Create a WAV file buffer from raw PCM data.
 */
function createWavBuffer(pcmData, sampleRate, channels, bitsPerSample) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const buffer = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt sub-chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);           // sub-chunk size
  buffer.writeUInt16LE(1, 20);            // PCM format
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmData.copy(buffer, 44);

  return buffer;
}

module.exports = { startRecording, stopRecording, checkSoxInstalled, onBrowserAudioData, isBrowserRecording };
