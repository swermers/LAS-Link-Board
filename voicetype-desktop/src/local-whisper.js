// ═══════════════════════════════════════
//  VoiceType — Local Whisper Transcription
// ═══════════════════════════════════════
//
// Runs Whisper entirely on-device using @huggingface/transformers
// (ONNX Runtime). No audio data leaves the machine.
//
// HIPAA-safe: zero network calls for transcription.

const path = require('path');
const { app } = require('electron');
const fs = require('fs');

const MODEL_ID = 'onnx-community/whisper-base';
const MODELS_DIR = path.join(app ? app.getPath('userData') : '.', 'whisper-models');

let pipeline = null;
let downloadProgress = null; // callback for UI updates

/**
 * Set a callback to receive model download progress updates.
 * @param {function} cb - Called with { status, progress, file } during download
 */
function onProgress(cb) {
  downloadProgress = cb;
}

/**
 * Check if the local model has been downloaded.
 */
function isModelDownloaded() {
  try {
    // Check for the model directory with any cached files
    if (!fs.existsSync(MODELS_DIR)) return false;
    const files = fs.readdirSync(MODELS_DIR, { recursive: true });
    // Look for ONNX model files (the decoder is the largest)
    return files.some(f => String(f).endsWith('.onnx'));
  } catch {
    return false;
  }
}

/**
 * Get the model directory size in MB.
 */
function getModelSize() {
  try {
    if (!fs.existsSync(MODELS_DIR)) return 0;
    let total = 0;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else total += fs.statSync(full).size;
      }
    };
    walk(MODELS_DIR);
    return Math.round(total / (1024 * 1024));
  } catch {
    return 0;
  }
}

/**
 * Load (and download if needed) the Whisper pipeline.
 * First call takes a while as it downloads ~150MB of model files.
 */
async function loadPipeline() {
  if (pipeline) return pipeline;

  // Dynamic import — @huggingface/transformers is ESM-only in v3
  const { pipeline: createPipeline, env } = await import('@huggingface/transformers');

  // Store models in app data directory
  env.cacheDir = MODELS_DIR;
  env.allowLocalModels = true;
  env.allowRemoteModels = true;

  const progressCallback = (data) => {
    if (downloadProgress) downloadProgress(data);
  };

  pipeline = await createPipeline(
    'automatic-speech-recognition',
    MODEL_ID,
    {
      dtype: 'q4',  // 4-bit quantized for smaller download & faster inference
      device: 'cpu',
      progress_callback: progressCallback
    }
  );

  return pipeline;
}

/**
 * Transcribe audio locally using Whisper.
 *
 * @param {Buffer} audioBuffer - Raw audio data (WAV format, 16kHz mono PCM)
 * @param {string} language - ISO 639-1 language code
 * @returns {Promise<string>} - Transcribed text
 */
async function transcribeLocal(audioBuffer, language = 'en') {
  const pipe = await loadPipeline();

  // Convert WAV buffer to Float32Array of PCM samples
  const samples = wavBufferToFloat32(audioBuffer);

  const result = await pipe(samples, {
    language: language,
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5
  });

  return result.text || '';
}

/**
 * Convert a WAV file buffer to Float32Array of normalized PCM samples.
 * Assumes 16-bit PCM WAV format.
 */
function wavBufferToFloat32(wavBuffer) {
  // WAV header is 44 bytes for standard PCM
  // Find the 'data' chunk
  let dataOffset = 44;
  for (let i = 12; i < Math.min(wavBuffer.length - 8, 200); i++) {
    if (wavBuffer[i] === 0x64 && wavBuffer[i + 1] === 0x61 &&
        wavBuffer[i + 2] === 0x74 && wavBuffer[i + 3] === 0x61) {
      dataOffset = i + 8; // skip 'data' + 4-byte size
      break;
    }
  }

  const pcmData = wavBuffer.slice(dataOffset);
  const samples = new Float32Array(Math.floor(pcmData.length / 2));

  for (let i = 0; i < samples.length; i++) {
    // Read 16-bit signed integer, convert to float [-1, 1]
    const val = pcmData.readInt16LE(i * 2);
    samples[i] = val / 32768;
  }

  return samples;
}

/**
 * Delete downloaded model files to free disk space.
 */
function deleteModel() {
  try {
    if (fs.existsSync(MODELS_DIR)) {
      fs.rmSync(MODELS_DIR, { recursive: true, force: true });
    }
    pipeline = null;
    return true;
  } catch (e) {
    console.error('Failed to delete model:', e);
    return false;
  }
}

module.exports = {
  transcribeLocal,
  loadPipeline,
  isModelDownloaded,
  getModelSize,
  deleteModel,
  onProgress
};
