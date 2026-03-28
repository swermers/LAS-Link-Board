/**
 * ═══════════════════════════════════════════════════════════════
 * LinkBoard — Daily Transport Digest for Google Chat
 * ═══════════════════════════════════════════════════════════════
 *
 * SETUP:
 * 1. Open https://script.google.com and create a new project
 * 2. Paste this entire file into Code.gs
 * 3. Update the CONFIG section below with your values
 * 4. Run sendDailyDigest() once manually to test
 * 5. Go to Triggers (clock icon) → Add Trigger:
 *    - Function: sendDailyDigest
 *    - Event source: Time-driven
 *    - Type: Day timer
 *    - Time: 6am to 7am (or your preferred morning slot)
 * 6. Authorize when prompted
 *
 * The script will post today's transport requests to your
 * Google Chat space every morning.
 */

// ─── CONFIG (update these) ───
const CONFIG = {
  // Your Google Chat webhook URL (Space → Settings → Integrations → Webhooks)
  CHAT_WEBHOOK_URL: 'https://chat.googleapis.com/v1/spaces/YOUR_SPACE/messages?key=YOUR_KEY&token=YOUR_TOKEN',

  // Your Supabase project URL and service role key
  SUPABASE_URL: 'https://pmhoeqxuamvqlwsatozu.supabase.co',
  SUPABASE_SERVICE_KEY: 'YOUR_SERVICE_ROLE_KEY',

  // The user ID whose transport requests to query
  // (find this in Supabase → Authentication → Users)
  USER_ID: 'YOUR_USER_ID',

  // Timezone for "today" calculation (IANA format)
  TIMEZONE: 'Europe/Zurich'
};

/**
 * Main function — call this on a daily trigger.
 * Fetches today's transport requests and posts to Chat.
 */
function sendDailyDigest() {
  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const tomorrow = getTomorrow(today);

  const requests = fetchTransportRequests(today, tomorrow);

  if (requests.length === 0) {
    postToChat({
      text: 'No transport requests scheduled for today (' +
        Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'EEEE, d MMMM yyyy') + ').'
    });
    return;
  }

  const dateLabel = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'EEEE, d MMMM yyyy');
  const widgets = requests.map(function(tr) {
    const time = tr.date_time
      ? Utilities.formatDate(new Date(tr.date_time), CONFIG.TIMEZONE, 'HH:mm')
      : 'TBD';
    const type = capitalize(tr.appointment_type || 'other');
    const returnTime = tr.return_time
      ? ' (return ~' + Utilities.formatDate(new Date(tr.return_time), CONFIG.TIMEZONE, 'HH:mm') + ')'
      : '';

    return {
      decoratedText: {
        topLabel: time + ' — ' + type + returnTime,
        text: '<b>' + (tr.student_name || 'Unknown') + '</b>' +
          (tr.student_house ? ' (' + tr.student_house + ')' : '') +
          ' → ' + (tr.destination || 'TBD'),
        wrapText: true
      }
    };
  });

  // Add special instructions as a separate section if any have them
  var instructionWidgets = [];
  requests.forEach(function(tr) {
    if (tr.special_instructions) {
      instructionWidgets.push({
        decoratedText: {
          topLabel: tr.student_name,
          text: tr.special_instructions,
          wrapText: true
        }
      });
    }
  });

  var sections = [{
    header: requests.length + ' Transport Request' + (requests.length > 1 ? 's' : ''),
    widgets: widgets
  }];

  if (instructionWidgets.length > 0) {
    sections.push({
      header: 'Special Instructions',
      widgets: instructionWidgets
    });
  }

  postToChat({
    cardsV2: [{
      cardId: 'daily_digest_' + today,
      card: {
        header: {
          title: 'Daily Transport Digest',
          subtitle: dateLabel,
          imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/directions_car/default/48px.svg',
          imageType: 'CIRCLE'
        },
        sections: sections
      }
    }]
  });

  Logger.log('Digest sent: ' + requests.length + ' requests for ' + today);
}

/**
 * Fetch transport requests for a specific date range.
 */
function fetchTransportRequests(fromDate, toDate) {
  var url = CONFIG.SUPABASE_URL + '/rest/v1/transport_requests' +
    '?user_id=eq.' + CONFIG.USER_ID +
    '&date_time=gte.' + fromDate + 'T00:00:00' +
    '&date_time=lt.' + toDate + 'T00:00:00' +
    '&status=neq.cancelled' +
    '&order=date_time.asc';

  var response = UrlFetchApp.fetch(url, {
    headers: {
      'apikey': CONFIG.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + CONFIG.SUPABASE_SERVICE_KEY
    },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    Logger.log('Supabase error: ' + response.getContentText());
    return [];
  }

  return JSON.parse(response.getContentText());
}

/**
 * Post a message/card to Google Chat via webhook.
 */
function postToChat(payload) {
  UrlFetchApp.fetch(CONFIG.CHAT_WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}

/**
 * Get tomorrow's date string from today's.
 */
function getTomorrow(todayStr) {
  var d = new Date(todayStr + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

/**
 * Capitalize first letter.
 */
function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
