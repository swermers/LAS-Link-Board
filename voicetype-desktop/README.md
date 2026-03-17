# VoiceType Desktop

System-wide voice-to-text via OpenAI Whisper. Press a hotkey, speak, text appears wherever your cursor is.

## Prerequisites

- **Node.js** 18+
- **SoX** (for microphone capture):
  - macOS: `brew install sox`
  - Windows: [Download SoX](https://sourceforge.net/projects/sox/) and add to PATH
  - Linux: `sudo apt install sox`
- **OpenAI API key** (configured in LinkBoard settings)

## Setup

```bash
cd voicetype-desktop
npm install
```

## Development

```bash
npm start
```

## Build

```bash
# macOS
npm run build:mac

# Windows
npm run build:win

# Both
npm run build
```

## Auth Setup

On first launch, the app needs Supabase auth credentials. For now, manually set them:

```js
// In Electron dev console (Cmd+Opt+I):
const Store = require('electron-store');
const store = new Store({ name: 'voicetype-config' });
store.set('supabase_token', 'YOUR_TOKEN');
store.set('user_id', 'YOUR_USER_ID');
```

A proper login window will be added in Phase 2.

## Architecture

```
src/
├── main.js       # Electron main process, tray, indicator window
├── hotkey.js     # Global hotkey registration with key-up detection
├── recorder.js   # Microphone capture to WAV buffer via SoX
├── whisper.js    # OpenAI Whisper API transcription
├── injector.js   # Clipboard paste injection (AppleScript/PowerShell)
└── sync.js       # Supabase settings sync with offline fallback
```

## Core Flow

1. App launches → syncs settings from Supabase → registers global hotkey
2. Hotkey pressed → recording indicator appears → mic starts capturing
3. Hotkey released → audio sent to Whisper API → text returned
4. Text written to clipboard → Ctrl/Cmd+V simulated → clipboard restored
5. Usage logged to Supabase for the LinkBoard dashboard
