// ═══════════════════════════════════════
//  VoiceType — Clipboard Paste Injection
// ═══════════════════════════════════════
//
// Writes transcribed text to the system clipboard,
// simulates Cmd/Ctrl+V to paste into the active window,
// then restores the previous clipboard content.
//
// This approach is more reliable than direct keystroke
// simulation across browsers, Electron apps, and rich
// text editors.

const { clipboard } = require('electron');

/**
 * Inject text into the currently focused input field.
 *
 * 1. Save current clipboard contents
 * 2. Write transcribed text to clipboard
 * 3. Simulate Cmd/Ctrl+V paste
 * 4. Optionally simulate Enter key
 * 5. Restore original clipboard
 *
 * @param {string} text - Text to inject
 * @param {boolean} autoSubmit - If true, simulate Enter after paste
 */
async function injectText(text, autoSubmit = false) {
  // Save current clipboard
  const previousClipboard = clipboard.readText();

  // Write transcription to clipboard
  clipboard.writeText(text);

  // Small delay to ensure clipboard is ready
  await sleep(50);

  // Simulate paste via platform-specific key combo
  if (process.platform === 'darwin') {
    await simulateKeyMac('v', ['command']);
    if (autoSubmit) {
      await sleep(100);
      await simulateKeyMac('return', []);
    }
  } else {
    await simulateKeyWindows('v', ['control']);
    if (autoSubmit) {
      await sleep(100);
      await simulateKeyWindows('Return', []);
    }
  }

  // Wait for paste to complete, then restore clipboard
  await sleep(300);
  clipboard.writeText(previousClipboard);
}

/**
 * Simulate a key press on macOS using AppleScript.
 * This is the most reliable method across all macOS apps.
 */
async function simulateKeyMac(key, modifiers) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const exec = promisify(execFile);

  let script;
  if (modifiers.includes('command')) {
    script = `tell application "System Events" to keystroke "${key}" using command down`;
  } else if (key === 'return') {
    script = `tell application "System Events" to key code 36`;
  } else {
    script = `tell application "System Events" to keystroke "${key}"`;
  }

  try {
    await exec('osascript', ['-e', script]);
  } catch (e) {
    console.error('AppleScript key simulation error:', e.message);
    // Accessibility permission may be needed
  }
}

/**
 * Simulate a key press on Windows using PowerShell.
 */
async function simulateKeyWindows(key, modifiers) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const exec = promisify(execFile);

  let sendKeys;
  if (modifiers.includes('control') && key === 'v') {
    sendKeys = '^v'; // Ctrl+V in SendKeys notation
  } else if (key === 'Return') {
    sendKeys = '{ENTER}';
  } else {
    sendKeys = key;
  }

  const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sendKeys}')`;

  try {
    await exec('powershell', ['-Command', ps]);
  } catch (e) {
    console.error('PowerShell key simulation error:', e.message);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { injectText };
