// ═══════════════════════════════════════
//  VoiceType — Supabase Config Sync
// ═══════════════════════════════════════
//
// On launch, pulls user settings from Supabase via
// the LinkBoard API or direct Supabase REST call.
// Falls back to locally cached settings if offline.

const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';
const LINKBOARD_API = 'https://las-link-board.vercel.app/api/voicetype/settings';

/**
 * Refresh the Supabase access token using the stored refresh_token.
 * Returns true if refresh succeeded, false otherwise.
 */
async function refreshToken(store) {
  const refreshTok = store.get('supabase_refresh_token');
  if (!refreshTok) return false;

  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ refresh_token: refreshTok }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      console.warn('Token refresh failed:', res.status);
      return false;
    }
    const data = await res.json();
    if (data.access_token && data.refresh_token) {
      store.set('supabase_token', data.access_token);
      store.set('supabase_refresh_token', data.refresh_token);
      if (data.user && data.user.email) {
        store.set('user_email', data.user.email);
      }
      if (data.user && data.user.id) {
        store.set('user_id', data.user.id);
      }
      console.log('Token refreshed successfully');
      return true;
    }
    return false;
  } catch (e) {
    console.warn('Token refresh error:', e.message);
    return false;
  }
}

/**
 * Ensure we have a valid token. Try the current one first,
 * and if it's expired, refresh it automatically.
 */
async function ensureValidToken(store) {
  const token = store.get('supabase_token');
  if (!token) return false;

  // Quick check: try to validate the current token
  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: {
        'apikey': SUPABASE_ANON,
        'Authorization': 'Bearer ' + token
      },
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok) {
      const user = await res.json();
      if (user && user.email) store.set('user_email', user.email);
      return true; // Token is still valid
    }
  } catch (e) {
    // Network error — don't clear token, might be offline
    console.warn('Token validation failed (network?):', e.message);
  }

  // Token is expired or invalid — try to refresh
  console.log('Token expired, attempting refresh...');
  return await refreshToken(store);
}

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
      headers: { 'Authorization': 'Bearer ' + store.get('supabase_token') },
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const settings = await res.json();
      store.set('cached_settings', settings);
      console.log('Settings synced via LinkBoard API');
      return settings;
    }
    // If 401, try refreshing token and retry once
    if (res.status === 401) {
      const refreshed = await refreshToken(store);
      if (refreshed) {
        const retry = await fetch(LINKBOARD_API, {
          headers: { 'Authorization': 'Bearer ' + store.get('supabase_token') },
          signal: AbortSignal.timeout(8000)
        });
        if (retry.ok) {
          const settings = await retry.json();
          store.set('cached_settings', settings);
          console.log('Settings synced via LinkBoard API (after token refresh)');
          return settings;
        }
      }
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
          'Authorization': 'Bearer ' + store.get('supabase_token')
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
function storeAuth(store, { token, refreshToken, userId, email }) {
  store.set('supabase_token', token);
  store.set('supabase_refresh_token', refreshToken);
  store.set('user_id', userId);
  if (email) store.set('user_email', email);
}

/**
 * Clear stored auth and settings.
 */
function clearAuth(store) {
  store.delete('supabase_token');
  store.delete('supabase_refresh_token');
  store.delete('user_id');
  store.delete('user_email');
  store.delete('cached_settings');
  store.delete('cached_skills');
}

/**
 * Save a subset of settings back to LinkBoard API.
 * @param {import('electron-store')} store
 * @param {Object} updates - key/value pairs to update (e.g. { transcription_mode: 'local' })
 */
async function saveSettings(store, updates) {
  const token = store.get('supabase_token');
  if (!token) throw new Error('Not signed in');

  let res = await fetch(LINKBOARD_API, {
    method: 'PUT',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updates),
    signal: AbortSignal.timeout(8000)
  });

  // If 401, try refreshing token and retry
  if (res.status === 401) {
    const refreshed = await refreshToken(store);
    if (refreshed) {
      res = await fetch(LINKBOARD_API, {
        method: 'PUT',
        headers: {
          'Authorization': 'Bearer ' + store.get('supabase_token'),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updates),
        signal: AbortSignal.timeout(8000)
      });
    }
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error('Save failed: ' + text);
  }
  // Update local cache
  const cached = store.get('cached_settings') || {};
  Object.assign(cached, updates);
  store.set('cached_settings', cached);
  return cached;
}

// ═══════════════════════════════════════
//  Voice Notes — Save & Sync
// ═══════════════════════════════════════

/**
 * Fetch the user's todo categories from Supabase.
 */
async function fetchVoiceNoteCategories(store) {
  const token = store.get('supabase_token');
  const userId = store.get('user_id');
  if (!token || !userId) return store.get('cached_vn_categories') || [];

  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/todo_categories?user_id=eq.' + userId + '&order=sort_order.asc',
      {
        headers: { 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + token },
        signal: AbortSignal.timeout(8000)
      }
    );
    if (res.ok) {
      const cats = await res.json();
      store.set('cached_vn_categories', cats);
      return cats;
    }
    if (res.status === 401) {
      const refreshed = await refreshToken(store);
      if (refreshed) return fetchVoiceNoteCategories(store); // retry once
    }
  } catch (e) {
    console.warn('Failed to fetch voice note categories:', e.message);
  }
  return store.get('cached_vn_categories') || [];
}

/**
 * Save a voice note to Supabase (voice_notes table).
 * @param {Object} note - { transcript, title, category_id, priority, tagged_student, tagged_student_id, duration_seconds }
 */
async function saveVoiceNote(store, note) {
  const token = store.get('supabase_token');
  const userId = store.get('user_id');
  if (!token || !userId) throw new Error('Not signed in');

  const payload = {
    user_id: userId,
    transcript: note.transcript || '',
    title: note.title || note.transcript.split(/[.!?\n]/)[0].substring(0, 80),
    category_id: note.category_id || null,
    priority: note.priority || 'normal',
    tagged_student: note.tagged_student || '',
    tagged_student_id: note.tagged_student_id || '',
    duration_seconds: note.duration_seconds || 0,
    status: 'pending'
  };

  let res = await fetch(SUPABASE_URL + '/rest/v1/voice_notes', {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON,
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });

  if (res.status === 401) {
    const refreshed = await refreshToken(store);
    if (refreshed) {
      res = await fetch(SUPABASE_URL + '/rest/v1/voice_notes', {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON,
          'Authorization': 'Bearer ' + store.get('supabase_token'),
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000)
      });
    }
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error('Failed to save voice note: ' + text);
  }
  const created = await res.json();
  return created[0] || created;
}

/**
 * Fetch students from Orah via the LinkBoard proxy.
 * @param {Object} orahConfig - { region, api_key }
 * @param {string} query - search string
 */
async function fetchOrahStudents(store, orahConfig, query) {
  const token = store.get('supabase_token');
  if (!token || !orahConfig || !orahConfig.api_key) return [];

  try {
    const res = await fetch('https://las-link-board.vercel.app/api/voicenotes/orah-proxy', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        region: orahConfig.region || 'https://open-api-ireland.orah.com/open-api',
        api_key: orahConfig.api_key,
        endpoint: 'students/list',
        body: query ? { search: query, limit: 20 } : { limit: 200 }
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (res.ok) {
      const data = await res.json();
      const students = data.students || data.data || data || [];
      // Cache the roster locally
      if (!query) store.set('cached_orah_students', students);
      return students;
    }
  } catch (e) {
    console.warn('Orah student fetch error:', e.message);
  }

  return store.get('cached_orah_students') || [];
}

module.exports = { syncSettings, saveSettings, storeAuth, clearAuth, refreshToken, ensureValidToken, saveVoiceNote, fetchOrahStudents, fetchVoiceNoteCategories };
