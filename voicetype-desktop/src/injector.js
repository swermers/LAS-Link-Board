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
 * 1. Write transcribed text to clipboard
 * 2. Attempt Cmd/Ctrl+V paste at cursor (may need Accessibility on macOS)
 * 3. Optionally simulate Enter key
 * 4. Text remains on clipboard as fallback (user can Cmd+V manually)
 *
 * @param {string} text - Text to inject
 * @param {boolean} autoSubmit - If true, simulate Enter after paste
 */
async function injectText(text, autoSubmit = false) {
  // Write transcription to clipboard (always available as fallback)
  clipboard.writeText(text);

  // Small delay to ensure clipboard is ready
  await sleep(50);

  // Attempt paste via platform-specific key combo
  // If Accessibility permission is missing on macOS, this fails silently
  // and the user can just Cmd+V manually (text is already on clipboard)
  try {
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
  } catch (e) {
    // Injection failed (likely missing Accessibility permission)
    // Text is still on clipboard — user can paste manually
    console.log('Auto-paste failed (text copied to clipboard):', e.message);
  }

  // Note: We intentionally do NOT restore the old clipboard.
  // The transcribed/formatted text stays on clipboard so the user
  // can paste it again or use it as a fallback if injection failed.
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
