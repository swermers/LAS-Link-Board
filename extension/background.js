const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';

console.log('[LB] Background service worker loaded');

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'googleSignIn') {
    console.log('[LB] Received googleSignIn message');
    handleGoogleSignIn();
    sendResponse({ started: true });
  }
  return true;
});

async function handleGoogleSignIn() {
  // Clear any previous error
  await chrome.storage.local.remove(['lb_auth_error']);

  const redirectUrl = chrome.identity.getRedirectURL();
  console.log('[LB] Redirect URL:', redirectUrl);

  const authUrl = SUPABASE_URL + '/auth/v1/authorize?' + new URLSearchParams({
    provider: 'google',
    redirect_to: redirectUrl,
    response_type: 'token'
  }).toString();

  console.log('[LB] Starting launchWebAuthFlow...');

  try {
    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true
    });

    console.log('[LB] Got response URL:', responseUrl);

    // Parse tokens from hash fragment or query params
    const url = new URL(responseUrl);
    const hashParams = new URLSearchParams(url.hash.substring(1));
    const queryParams = new URLSearchParams(url.search);

    const accessToken = hashParams.get('access_token') || queryParams.get('access_token');
    const refreshToken = hashParams.get('refresh_token') || queryParams.get('refresh_token');

    if (!accessToken) {
      const errMsg = 'No token in response. URL: ' + responseUrl.substring(0, 300);
      console.error('[LB]', errMsg);
      await chrome.storage.local.set({ lb_auth_error: errMsg });
      return;
    }

    console.log('[LB] Got access token, fetching user info...');

    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: {
        'apikey': SUPABASE_ANON,
        'Authorization': 'Bearer ' + accessToken
      }
    });
    const user = await userRes.json();
    console.log('[LB] User:', JSON.stringify(user).substring(0, 200));

    const name = user.user_metadata?.full_name || user.email?.split('@')[0] || 'User';

    await chrome.storage.local.set({
      lb_token: accessToken,
      lb_refresh: refreshToken,
      lb_user_id: user.id,
      lb_user_name: name
    });

    console.log('[LB] SUCCESS - saved to storage. User:', name);
  } catch (e) {
    console.error('[LB] OAuth error:', e);
    await chrome.storage.local.set({ lb_auth_error: e.message || 'Sign-in failed' });
  }
}
