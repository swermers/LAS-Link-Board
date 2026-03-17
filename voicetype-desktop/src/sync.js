// ═══════════════════════════════════════
//  VoiceType — Supabase Config Sync
// ═══════════════════════════════════════
//
// On launch, pulls user settings from Supabase via
// the LinkBoard API or direct Supabase REST call.
// Falls back to locally cached settings if offline.

const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';
const LINKBOARD_API = 'https://linkboard.vercel.app/api/voicetype/settings';

/**
 * Sync settings from Supabase. Tries the LinkBoard API first,
 * then falls back to direct Supabase REST, then local cache.
 *
 * @param {import('electron-store')} store - Electron persistent store
 * @returns {Promise<Object>} - Settings object
 */
async function syncSettings(store) {
  const token = store.get('supabase_token');
  const userId = store.get('user_id');

  if (!token || !userId) {
    console.log('No auth token stored — using cached settings');
    return getCachedSettings(store);
  }

  // Store Supabase config for other modules
  store.set('supabase_url', SUPABASE_URL);
  store.set('supabase_anon', SUPABASE_ANON);

  // Try LinkBoard API first (handles decryption server-side)
  try {
    const res = await fetch(LINKBOARD_API, {
      headers: { 'Authorization': 'Bearer ' + token },
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const settings = await res.json();
      store.set('cached_settings', settings);
      console.log('Settings synced via LinkBoard API');
      return settings;
    }
  } catch (e) {
    console.warn('LinkBoard API unavailable, trying direct Supabase:', e.message);
  }

  // Fallback: direct Supabase REST
  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/voicetype_settings?user_id=eq.' + userId + '&limit=1',
      {
        headers: {
          'apikey': SUPABASE_ANON,
          'Authorization': 'Bearer ' + token
        },
        signal: AbortSignal.timeout(8000)
      }
    );
    if (res.ok) {
      const rows = await res.json();
      if (rows.length > 0) {
        store.set('cached_settings', rows[0]);
        console.log('Settings synced via Supabase REST');
        return rows[0];
      }
    }
  } catch (e) {
    console.warn('Supabase REST unavailable:', e.message);
  }

  // Final fallback: local cache
  console.log('Using cached settings (offline)');
  return getCachedSettings(store);
}

/**
 * Get locally cached settings or defaults.
 */
function getCachedSettings(store) {
  return store.get('cached_settings') || {
    hotkey: 'CommandOrControl+Shift+Space',
    language: 'en',
    auto_submit: false,
    openai_api_key: '',
    transcription_mode: 'cloud',
    soap_notes: false,
    active_skill_id: null,
    anthropic_api_key: '',
    anthropic_base_url: ''
  };
}

/**
 * Store auth credentials after login.
 * Called from a login flow (future: OAuth window in the app).
 */
function storeAuth(store, { token, refreshToken, userId }) {
  store.set('supabase_token', token);
  store.set('supabase_refresh_token', refreshToken);
  store.set('user_id', userId);
}

/**
 * Clear stored auth and settings.
 */
function clearAuth(store) {
  store.delete('supabase_token');
  store.delete('supabase_refresh_token');
  store.delete('user_id');
  store.delete('cached_settings');
}

module.exports = { syncSettings, storeAuth, clearAuth };
