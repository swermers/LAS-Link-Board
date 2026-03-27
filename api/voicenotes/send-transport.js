// ═══════════════════════════════════════════════════
// Send Transport Request — POST /api/voicenotes/send-transport
// ═══════════════════════════════════════════════════
//
// Receives a transport request PDF and metadata,
// then sends it via email or logs to Google Sheets.
//
// Request: multipart/form-data with "pdf" file and
//   "transport_request" JSON, "transport_email",
//   "google_sheets_id" fields
// Auth: Bearer token from Supabase session

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const token = auth.replace('Bearer ', '');
  let user;
  try {
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + token }
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Invalid session' });
    user = await userRes.json();
  } catch (e) {
    return res.status(401).json({ error: 'Auth check failed' });
  }

  // Parse multipart body — on Vercel, body is auto-parsed
  // For multipart, we need the raw fields
  let transportRequest, transportEmail, googleSheetsId;

  try {
    // Vercel with bodyParser: false won't auto-parse multipart
    // We'll accept JSON as a fallback for simpler cases
    if (req.headers['content-type']?.includes('application/json')) {
      const body = req.body || {};
      transportRequest = body.transport_request;
      transportEmail = body.transport_email;
      googleSheetsId = body.google_sheets_id;
    } else {
      // For multipart, try to extract from body fields
      transportRequest = req.body?.transport_request ? JSON.parse(req.body.transport_request) : null;
      transportEmail = req.body?.transport_email || '';
      googleSheetsId = req.body?.google_sheets_id || '';
    }
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  if (!transportRequest) {
    return res.status(400).json({ error: 'Missing transport_request data' });
  }

  const results = { email: null, sheets: null };

  // ─── Option 1: Send via Email using Supabase Edge Function or mailto link ───
  if (transportEmail) {
    try {
      // Construct an email-friendly HTML version of the transport request
      const tr = typeof transportRequest === 'string' ? JSON.parse(transportRequest) : transportRequest;
      const emailHtml = buildTransportEmailHtml(tr, user);

      // Use Supabase's built-in email or a configured SMTP endpoint
      // For now, we'll use Supabase's auth.admin to send via the platform
      // If no email service is configured, the client will fall back to PDF download
      const emailRes = await fetch(SUPABASE_URL + '/rest/v1/rpc/send_transport_email', {
        method: 'POST',
        headers: {
          'apikey': SERVICE_KEY,
          'Authorization': 'Bearer ' + SERVICE_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          to_email: transportEmail,
          subject: 'Transport Request: ' + tr.student_name + ' — ' + (tr.appointment_type || 'Appointment'),
          html_body: emailHtml
        })
      });

      if (emailRes.ok) {
        results.email = 'sent';
      } else {
        // Fallback: tell client to use mailto link
        results.email = 'fallback';
        results.mailto = buildMailtoLink(tr, transportEmail);
      }
    } catch (e) {
      results.email = 'error';
      results.error = e.message;
    }
  }

  // ─── Option 2: Append to Google Sheet ───
  if (googleSheetsId) {
    try {
      const tr = typeof transportRequest === 'string' ? JSON.parse(transportRequest) : transportRequest;
      // Google Sheets append via the Sheets API would require OAuth
      // For simplicity, we store as a pending row and the client can
      // use a Google Apps Script web app to push data
      results.sheets = 'pending';
      results.sheets_data = {
        spreadsheet_id: googleSheetsId,
        row: [
          new Date().toISOString(),
          tr.student_name,
          tr.student_id || '',
          tr.student_house || '',
          tr.student_year || '',
          tr.appointment_type || '',
          tr.destination || '',
          tr.pickup_location || '',
          tr.date_time || '',
          tr.return_time || '',
          tr.appointment_details || '',
          tr.special_instructions || '',
          tr.status || 'submitted',
          tr.id || ''
        ]
      };
    } catch (e) {
      results.sheets = 'error';
    }
  }

  return res.status(200).json({ success: true, results });
};

function buildTransportEmailHtml(tr, user) {
  const dateStr = tr.date_time
    ? new Date(tr.date_time).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'TBD';
  const returnStr = tr.return_time
    ? new Date(tr.return_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : 'TBD';
  const userName = user?.user_metadata?.full_name || user?.email || 'Staff';

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:20px">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
  <div style="background:#0B2545;color:#fff;padding:20px 24px">
    <h1 style="margin:0;font-size:20px">Transport Request</h1>
    <p style="margin:4px 0 0;opacity:0.7;font-size:13px">Submitted by ${userName}</p>
  </div>
  <div style="padding:24px">
    <h2 style="color:#0B2545;font-size:16px;margin:0 0 16px;border-bottom:2px solid #C5963B;padding-bottom:8px">Student Information</h2>
    <table style="width:100%;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:6px 0;font-weight:bold;width:140px;color:#5A7080">Name</td><td style="padding:6px 0">${tr.student_name}</td></tr>
      <tr><td style="padding:6px 0;font-weight:bold;color:#5A7080">House</td><td style="padding:6px 0">${tr.student_house || 'N/A'}</td></tr>
      <tr><td style="padding:6px 0;font-weight:bold;color:#5A7080">Year</td><td style="padding:6px 0">${tr.student_year || 'N/A'}</td></tr>
    </table>

    <h2 style="color:#0B2545;font-size:16px;margin:24px 0 16px;border-bottom:2px solid #C5963B;padding-bottom:8px">Transport Details</h2>
    <table style="width:100%;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:6px 0;font-weight:bold;width:140px;color:#5A7080">Type</td><td style="padding:6px 0">${(tr.appointment_type || 'Other').charAt(0).toUpperCase() + (tr.appointment_type || 'other').slice(1)}</td></tr>
      <tr><td style="padding:6px 0;font-weight:bold;color:#5A7080">Destination</td><td style="padding:6px 0">${tr.destination || 'N/A'}</td></tr>
      <tr><td style="padding:6px 0;font-weight:bold;color:#5A7080">Pickup</td><td style="padding:6px 0">${tr.pickup_location || 'School Reception'}</td></tr>
      <tr><td style="padding:6px 0;font-weight:bold;color:#5A7080">Date & Time</td><td style="padding:6px 0">${dateStr}</td></tr>
      <tr><td style="padding:6px 0;font-weight:bold;color:#5A7080">Return</td><td style="padding:6px 0">${returnStr}</td></tr>
    </table>

    ${tr.appointment_details ? `
    <h2 style="color:#0B2545;font-size:16px;margin:24px 0 16px;border-bottom:2px solid #C5963B;padding-bottom:8px">Appointment Details</h2>
    <p style="font-size:14px;line-height:1.6;color:#333">${tr.appointment_details}</p>
    ` : ''}

    ${tr.special_instructions ? `
    <h2 style="color:#0B2545;font-size:16px;margin:24px 0 16px;border-bottom:2px solid #C5963B;padding-bottom:8px">Special Instructions</h2>
    <p style="font-size:14px;line-height:1.6;color:#333">${tr.special_instructions}</p>
    ` : ''}
  </div>
  <div style="background:#f8f9fa;padding:16px 24px;font-size:12px;color:#6B7C8D;border-top:1px solid #e2e6ea">
    Generated via LAS LinkBoard Voice Notes · Request ID: ${tr.id || 'N/A'}
  </div>
</div>
</body>
</html>`;
}

function buildMailtoLink(tr, email) {
  const subject = encodeURIComponent('Transport Request: ' + tr.student_name);
  const body = encodeURIComponent(
    `Transport Request\n\nStudent: ${tr.student_name}\nHouse: ${tr.student_house || 'N/A'}\nYear: ${tr.student_year || 'N/A'}\n\nType: ${tr.appointment_type || 'Other'}\nDestination: ${tr.destination || 'N/A'}\nPickup: ${tr.pickup_location || 'School Reception'}\nDate: ${tr.date_time || 'TBD'}\nReturn: ${tr.return_time || 'TBD'}\n\nDetails: ${tr.appointment_details || 'N/A'}\nSpecial Instructions: ${tr.special_instructions || 'None'}\n\nGenerated via LAS LinkBoard`
  );
  return `mailto:${email}?subject=${subject}&body=${body}`;
}
