const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'googleSignIn') {
    // Fire and forget — don't rely on sendResponse since popup will close
    handleGoogleSignIn();
    sendResponse({ started: true });
  }
});

async function handleGoogleSignIn() {
  const redirectUrl = chrome.identity.getRedirectURL();
  console.log('[LB] Redirect URL:', redirectUrl);

  const authUrl = SUPABASE_URL + '/auth/v1/authorize?' + new URLSearchParams({
    provider: 'google',
    redirect_to: redirectUrl,
    response_type: 'token'
  }).toString();

  console.log('[LB] Auth URL:', authUrl);

  try {
    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true
    });

    console.log('[LB] Response URL:', responseUrl);

    // Parse tokens from hash fragment (#access_token=...&refresh_token=...)
    const url = new URL(responseUrl);
    const hashStr = url.hash.substring(1);
    const hashParams = new URLSearchParams(hashStr);
    const queryParams = new URLSearchParams(url.search);

    let accessToken = hashParams.get('access_token') || queryParams.get('access_token');
    let refreshToken = hashParams.get('refresh_token') || queryParams.get('refresh_token');

    if (!accessToken) {
      console.error('[LB] No token found. Hash:', hashStr, 'Search:', url.search);
      await chrome.storage.local.set({
        lb_auth_error: 'No token received. URL: ' + responseUrl.substring(0, 300)
      });
      return;
    }

    console.log('[LB] Got access token, fetching user info...');

    // Fetch user info from Supabase
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: {
        'apikey': SUPABASE_ANON,
        'Authorization': 'Bearer ' + accessToken
      }
    });
    const user = await userRes.json();
    console.log('[LB] User response:', JSON.stringify(user).substring(0, 200));
    const name = user.user_metadata?.full_name || user.email?.split('@')[0] || 'User';

    // Save to storage — popup's init() or storage listener will pick this up
    await chrome.storage.local.set({
      lb_token: accessToken,
      lb_refresh: refreshToken,
      lb_user_id: user.id,
      lb_user_name: name
    });
    // Clear any previous error
    await chrome.storage.local.remove(['lb_auth_error']);

    console.log('[LB] Saved to storage. User:', name, 'ID:', user.id);
  } catch (e) {
    console.error('[LB] OAuth error:', e);
    await chrome.storage.local.set({
      lb_auth_error: e.message || 'Sign-in cancelled'
    });
  }
}
