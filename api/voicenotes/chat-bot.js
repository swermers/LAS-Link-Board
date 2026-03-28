// ═══════════════════════════════════════════════════
// Google Chat Bot — POST /api/voicenotes/chat-bot
// ═══════════════════════════════════════════════════
//
// HTTP endpoint for a Google Chat App. Receives interaction
// events (messages, added to space) and responds.
//
// Supports:
//   "transport today" / "transport tomorrow" / "transport [date]"
//   "add note [text]" / "note [text]" / just any text → creates to-do
//   #category hashtags for categorization
//   @student mentions for tagging
//
// Setup: Register as a Chat App in Google Cloud Console
//   → Chat API → Configuration → HTTP endpoint URL
//   → Point to: https://las-link-board.vercel.app/api/voicenotes/chat-bot

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

module.exports = async (req, res) => {
  // Wrap everything in try/catch — Google Chat shows "not responding" if we crash
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SERVICE_KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY not set in Vercel environment');
    return res.status(200).json({ text: 'Bot configuration error: SUPABASE_SERVICE_ROLE_KEY not set. Add it in Vercel Settings → Environment Variables.' });
  }

  const event = req.body || {};
  const eventType = event.type;

  // ─── ADDED_TO_SPACE ───
  if (eventType === 'ADDED_TO_SPACE') {
    return res.json({
      text: 'Hi! I\'m LinkBoard. I can help you manage transport requests and to-do notes.\n\n' +
        '*Commands:*\n' +
        '• `transport today` — see today\'s transport requests\n' +
        '• `transport tomorrow` — see tomorrow\'s\n' +
        '• `transport [date]` — e.g. "transport March 30"\n' +
        '• `note [text]` — add a to-do note (use #category and @student)\n' +
        '• `help` — show this message again'
    });
  }

  // ─── REMOVED_FROM_SPACE ───
  if (eventType === 'REMOVED_FROM_SPACE') {
    return res.status(200).end();
  }

  // ─── MESSAGE ───
  if (eventType === 'MESSAGE') {
    const message = event.message || {};
    const text = (message.text || '').trim();
    const sender = event.user || {};
    const senderEmail = sender.email || '';

    // Strip bot mention if present (e.g., "@LinkBoard transport today")
    const cleanText = text.replace(/@\S+\s*/g, '').trim();
    const lowerText = cleanText.toLowerCase();

    // ── Transport query ──
    if (lowerText.startsWith('transport')) {
      return await handleTransportQuery(res, senderEmail, cleanText);
    }

    // ── Help ──
    if (lowerText === 'help' || lowerText === 'commands') {
      return res.json({
        text: '*LinkBoard Commands:*\n' +
          '• `transport today` — today\'s transport requests\n' +
          '• `transport tomorrow` — tomorrow\'s requests\n' +
          '• `transport [date]` — e.g. "transport March 30"\n' +
          '• `note [text]` — add a to-do note\n' +
          '• Use `#medical` `#admin` etc. to categorize notes\n' +
          '• Use `@student name` to tag a student'
      });
    }

    // ── Create note (explicit or default) ──
    // "note ..." or "add note ..." or just any text
    let noteText = cleanText;
    if (lowerText.startsWith('note ')) noteText = cleanText.substring(5).trim();
    else if (lowerText.startsWith('add note ')) noteText = cleanText.substring(9).trim();
    else if (lowerText.startsWith('add ')) noteText = cleanText.substring(4).trim();

    if (noteText) {
      return await handleCreateNote(res, senderEmail, noteText);
    }

    return res.json({ text: 'I didn\'t understand that. Type `help` to see available commands.' });
  }

  // ─── CARD_CLICKED (future: interactive buttons) ───
  if (eventType === 'CARD_CLICKED') {
    return res.json({ text: 'Action received.' });
  }

  return res.status(200).json({ text: 'Message received.' });

  } catch (err) {
    // Always return a valid response so Google Chat doesn't show "not responding"
    console.error('Chat bot error:', err);
    return res.status(200).json({ text: 'Something went wrong. Error: ' + (err.message || 'Unknown error') });
  }
};

// ─── Transport Query Handler ───
async function handleTransportQuery(res, senderEmail, text) {
  const targetDate = parseDateFromText(text);
  const dateStr = targetDate.toISOString().split('T')[0];
  const nextDay = new Date(targetDate);
  nextDay.setDate(nextDay.getDate() + 1);
  const nextDateStr = nextDay.toISOString().split('T')[0];

  // Find user by email
  const userId = await findUserByEmail(senderEmail);
  if (!userId) {
    return res.json({ text: 'I couldn\'t find your LinkBoard account. Make sure you\'re signed up with the same email.' });
  }

  // Query transport requests for that date
  try {
    const trRes = await fetch(
      SUPABASE_URL + '/rest/v1/transport_requests?user_id=eq.' + userId +
      '&date_time=gte.' + dateStr + 'T00:00:00&date_time=lt.' + nextDateStr + 'T00:00:00' +
      '&order=date_time.asc',
      {
        headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY }
      }
    );

    if (!trRes.ok) {
      return res.json({ text: 'Failed to load transport requests. Please try again.' });
    }

    const requests = await trRes.json();
    const dateLabel = targetDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    if (requests.length === 0) {
      return res.json({ text: `No transport requests for *${dateLabel}*.` });
    }

    // Build a card with the day's requests
    const widgets = requests.map(tr => {
      const time = tr.date_time ? new Date(tr.date_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'TBD';
      const type = (tr.appointment_type || 'other').charAt(0).toUpperCase() + (tr.appointment_type || 'other').slice(1);
      return {
        decoratedText: {
          topLabel: time + ' — ' + type,
          text: '<b>' + (tr.student_name || 'Unknown') + '</b>' +
            (tr.student_house ? ' (' + tr.student_house + ')' : '') +
            ' → ' + (tr.destination || 'TBD'),
          wrapText: true
        }
      };
    });

    return res.json({
      cardsV2: [{
        cardId: 'transport_digest_' + dateStr,
        card: {
          header: {
            title: 'Transport Requests',
            subtitle: dateLabel + ' — ' + requests.length + ' request(s)',
            imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/directions_car/default/48px.svg',
            imageType: 'CIRCLE'
          },
          sections: [{ widgets }]
        }
      }]
    });

  } catch (e) {
    return res.json({ text: 'Error loading transport requests: ' + e.message });
  }
}

// ─── Create Note Handler ───
async function handleCreateNote(res, senderEmail, text) {
  const userId = await findUserByEmail(senderEmail);
  if (!userId) {
    return res.json({ text: 'I couldn\'t find your LinkBoard account. Make sure you\'re signed up with the same email.' });
  }

  // Parse hashtag category
  let categoryId = null;
  let cleanText = text;
  const hashMatch = text.match(/#(\w+)/);
  if (hashMatch) {
    const catName = hashMatch[1].toLowerCase();
    cleanText = text.replace(/#\w+/g, '').trim();

    // Look up category
    try {
      const catRes = await fetch(
        SUPABASE_URL + '/rest/v1/todo_categories?user_id=eq.' + userId + '&name=ilike.' + encodeURIComponent(catName),
        { headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY } }
      );
      if (catRes.ok) {
        const cats = await catRes.json();
        if (cats.length > 0) categoryId = cats[0].id;
      }
    } catch (e) { /* skip categorization */ }
  }

  // Parse @student mention
  let taggedStudent = '';
  const atMatch = text.match(/@([\w\s]+?)(?=\s*[#,.\n]|$)/);
  if (atMatch) {
    taggedStudent = atMatch[1].trim();
    cleanText = cleanText.replace(/@[\w\s]+/, '').trim();
  }

  const title = cleanText.split(/[.!?\n]/)[0].substring(0, 80);

  // Create the note
  try {
    const noteRes = await fetch(SUPABASE_URL + '/rest/v1/voice_notes', {
      method: 'POST',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        user_id: userId,
        transcript: cleanText,
        title: title,
        category_id: categoryId,
        tagged_student: taggedStudent,
        priority: 'normal',
        status: 'pending'
      })
    });

    if (noteRes.ok) {
      const catLabel = categoryId ? '' : ' (uncategorized)';
      const studentLabel = taggedStudent ? ' — tagged: ' + taggedStudent : '';
      return res.json({
        text: 'Note added: *' + title + '*' + catLabel + studentLabel
      });
    } else {
      return res.json({ text: 'Failed to save note. Please try again.' });
    }
  } catch (e) {
    return res.json({ text: 'Error creating note: ' + e.message });
  }
}

// ─── Helpers ───

async function findUserByEmail(email) {
  if (!email) return null;
  try {
    const res = await fetch(
      SUPABASE_URL + '/auth/v1/admin/users',
      {
        headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY }
      }
    );
    if (res.ok) {
      const data = await res.json();
      const users = data.users || data || [];
      const user = users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
      return user ? user.id : null;
    }
  } catch (e) {
    console.error('User lookup failed:', e.message);
  }
  return null;
}

function parseDateFromText(text) {
  const lower = text.toLowerCase();

  // "transport today"
  if (lower.includes('today')) return startOfDay(new Date());

  // "transport tomorrow"
  if (lower.includes('tomorrow')) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return startOfDay(d);
  }

  // "transport monday" / "transport tuesday" etc.
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < days.length; i++) {
    if (lower.includes(days[i])) {
      const d = new Date();
      const today = d.getDay();
      const diff = (i - today + 7) % 7 || 7; // next occurrence
      d.setDate(d.getDate() + diff);
      return startOfDay(d);
    }
  }

  // "transport March 30" / "transport 30 March" / "transport 2026-03-30"
  // Try to parse a date from the text after "transport"
  const dateStr = text.replace(/^transport\s*/i, '').trim();
  if (dateStr) {
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) return startOfDay(parsed);
  }

  // Default to today
  return startOfDay(new Date());
}

function startOfDay(d) {
  d.setHours(0, 0, 0, 0);
  return d;
}
