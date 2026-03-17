// ═══════════════════════════════════════
//  VoiceType — Global Hotkey Registration
// ═══════════════════════════════════════
//
// Uses Electron's globalShortcut for key-down detection.
// Key-up is detected via polling since globalShortcut doesn't
// natively support key-up events.

const { globalShortcut } = require('electron');

let currentHotkey = null;
let keyUpPoller = null;
let onDownFn = null;
let onUpFn = null;
let isPressed = false;

/**
 * Register a global hotkey with down/up callbacks.
 * The hotkey uses Electron accelerator syntax:
 *   e.g. "CommandOrControl+Shift+Space", "F9"
 */
function registerHotkey(accelerator, onDown, onUp) {
  unregisterAll();

  onDownFn = onDown;
  onUpFn = onUp;
  currentHotkey = accelerator;

  const success = globalShortcut.register(accelerator, () => {
    if (!isPressed) {
      isPressed = true;
      if (onDownFn) onDownFn();
      startKeyUpDetection();
    }
  });

  if (!success) {
    console.error('Failed to register hotkey:', accelerator);
  } else {
    console.log('Hotkey registered:', accelerator);
  }

  return success;
}

/**
 * Poll-based key-up detection.
 * Since Electron globalShortcut fires continuously while held,
 * we detect "up" when the shortcut callback stops firing.
 */
function startKeyUpDetection() {
  let lastFired = Date.now();

  // Temporarily re-register to detect ongoing presses
  if (currentHotkey) {
    globalShortcut.unregister(currentHotkey);
    globalShortcut.register(currentHotkey, () => {
      lastFired = Date.now();
      if (!isPressed) {
        isPressed = true;
        if (onDownFn) onDownFn();
      }
    });
  }

  // Check every 100ms if the key stopped firing
  clearInterval(keyUpPoller);
  keyUpPoller = setInterval(() => {
    if (Date.now() - lastFired > 300) {
      // Key was released
      clearInterval(keyUpPoller);
      keyUpPoller = null;
      isPressed = false;
      if (onUpFn) onUpFn();
    }
  }, 100);
}

/**
 * Unregister all global shortcuts and clean up.
 */
function unregisterAll() {
  clearInterval(keyUpPoller);
  keyUpPoller = null;
  isPressed = false;
  globalShortcut.unregisterAll();
  currentHotkey = null;
}

module.exports = { registerHotkey, unregisterAll };
