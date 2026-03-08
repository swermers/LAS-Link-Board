// Debug endpoint — visit /api/debug in browser to check if API routes work
module.exports = function handler(req, res) {
  const testUrl = 'http://facebook.com/leysinamericanschool';
  const b64 = Buffer.from(testUrl).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(`
    <h2>LAS LinkBoard API — Debug</h2>
    <p><strong>Status:</strong> API routes are working!</p>
    <p><strong>Node version:</strong> ${process.version}</p>
    <p><strong>SUPABASE_URL set:</strong> ${process.env.SUPABASE_URL ? 'yes' : 'no (using default)'}</p>
    <p><strong>SUPABASE_SERVICE_ROLE_KEY set:</strong> ${process.env.SUPABASE_SERVICE_ROLE_KEY ? 'yes (' + process.env.SUPABASE_SERVICE_ROLE_KEY.substring(0, 20) + '...)' : 'NO — tracking inserts will fail if RLS is enabled'}</p>
    <hr>
    <h3>Test Links</h3>
    <p><a href="/api/t/debug-test-pixel">Test tracking pixel</a> (should show tiny image)</p>
    <p><a href="/api/c/debug-test/${b64}">Test click redirect</a> (should redirect to Facebook)</p>
    <p><strong>Encoded destination:</strong> ${b64}</p>
    <p><strong>Decoded destination:</strong> ${testUrl}</p>
  `);
};
