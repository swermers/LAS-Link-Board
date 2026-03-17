// ═══════════════════════════════════════
//  VoiceType — Microphone Recorder
// ═══════════════════════════════════════
//
// Captures audio from the system microphone into a WAV buffer.
// Uses node-record-lpcm16 for cross-platform mic access.
// Falls back to SoX or arecord depending on the OS.

const record = require('node-record-lpcm16');

let recording = null;
let audioChunks = [];

/**
 * Start recording audio from the default microphone.
 * Audio is captured as 16-bit mono PCM at 16kHz (optimal for Whisper).
 */
function startRecording() {
  audioChunks = [];

  recording = record.record({
    sampleRate: 16000,
    channels: 1,
    audioType: 'wav',
    // Use SoX on macOS/Linux, arecord on Linux if SoX unavailable
    recorder: process.platform === 'win32' ? 'sox' : 'rec',
    silence: '0',    // Don't auto-stop on silence
    threshold: 0      // Capture everything
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
 */
function stopRecording() {
  if (recording) {
    recording.stop();
    recording = null;
  }

  if (audioChunks.length === 0) return null;

  const pcmData = Buffer.concat(audioChunks);
  audioChunks = [];

  // If the recorder already outputs WAV format, return as-is
  // node-record-lpcm16 with audioType:'wav' includes the header
  if (pcmData.length > 44 && pcmData.toString('ascii', 0, 4) === 'RIFF') {
    return pcmData;
  }

  // Otherwise wrap raw PCM in a WAV header
  return createWavBuffer(pcmData, 16000, 1, 16);
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

module.exports = { startRecording, stopRecording };
