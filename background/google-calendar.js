const GOOGLE_CALENDAR_NAME = 'Saint-Maur Périscolaire';
const GOOGLE_SYNC_DEBUG_DETAILS = false;
const GOOGLE_SYNC_CODE_VERSION = 'google-sync-id-base32hex-2026-05-31';
const STORAGE_KEYS = {
  calendarId: 'googleCalendarId'
};

function getLocalTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Paris';
  } catch {
    return 'Europe/Paris';
  }
}

function parsePortalDateTime(dateTimeStr) {
  // Example: "06/01/2025 16:30:00"
  const [datePart, timePart] = String(dateTimeStr || '').split(' ');
  const [day, month, year] = (datePart || '').split('/').map(v => parseInt(v, 10));
  const [hour, minute, second] = (timePart || '').split(':').map(v => parseInt(v, 10));
  if (!year || !month || !day) return null;
  return { year, month, day, hour: hour || 0, minute: minute || 0, second: second || 0 };
}

function toRfc3339Local({ year, month, day, hour, minute, second }) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

function toPortalDayLabel(parts) {
  if (!parts) return 'unknown date';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(parts.day)}/${pad(parts.month)}/${parts.year}`;
}

function addDaysYmd(year, month, day, deltaDays) {
  const dt = new Date(year, month - 1, day);
  dt.setDate(dt.getDate() + deltaDays);
  const y = dt.getFullYear();
  const m = dt.getMonth() + 1;
  const d = dt.getDate();
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}`;
}

function bytesToBase32Hex(bytes) {
  // RFC2938 base32hex alphabet: 0-9, a-v
  const alphabet = '0123456789abcdefghijklmnopqrstuv';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      const idx = (value >>> (bits - 5)) & 31;
      output += alphabet[idx];
      bits -= 5;
    }
  }
  if (bits > 0) {
    const idx = (value << (5 - bits)) & 31;
    output += alphabet[idx];
  }
  return output;
}

async function sha256Base32Hex(input) {
  const enc = new TextEncoder();
  const data = enc.encode(String(input));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToBase32Hex(new Uint8Array(digest));
}

export async function buildGoogleEventId(prefix, stableKey) {
  // Google Calendar API requires base32hex characters: lowercase a-v and digits 0-9.
  // (No dashes/underscores, no uppercase, no other letters.)
  const safePrefix = String(prefix || '')
    .toLowerCase()
    .replace(/[^0-9a-v]/g, '');
  const h = await sha256Base32Hex(stableKey);
  const id = `${safePrefix}${h}`.slice(0, 80);
  return id.length >= 5 ? id : `${safePrefix}${h}`.padEnd(5, '0').slice(0, 5);
}

function isValidGoogleEventId(eventId) {
  return /^[0-9a-v]{5,80}$/.test(String(eventId || ''));
}

async function getAuthTokenInteractive() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      const err = chrome.runtime.lastError;
      if (err || !token) reject(new Error(err?.message || 'Failed to get Google auth token.'));
      else resolve(token);
    });
  });
}

async function removeCachedAuthToken(token) {
  return new Promise((resolve) => {
    if (!token) return resolve();
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

async function googleApiRequest(path, { method = 'GET', token, body } = {}) {
  const url = `https://www.googleapis.com${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (res.status === 204) return { ok: true, status: res.status, json: null, url };
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ok: res.ok, status: res.status, json, text, url };
}

async function googleApiRequestWithAuthRetry(path, opts, auth, { interactive = true } = {}) {
  let res = await googleApiRequest(path, { ...opts, token: auth.token });
  if (res.ok) return res;

  if ((res.status === 401 || res.status === 403) && interactive) {
    await removeCachedAuthToken(auth.token);
    auth.token = await getAuthTokenInteractive();
    res = await googleApiRequest(path, { ...opts, token: auth.token });
    return res;
  }

  return res;
}

async function getOrCreateDedicatedCalendarId(auth) {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.calendarId]);
  const storedId = stored?.[STORAGE_KEYS.calendarId];
  if (storedId) {
    // Validate it still exists and is accessible.
    const check = await googleApiRequestWithAuthRetry(`/calendar/v3/calendars/${encodeURIComponent(storedId)}`, {}, auth);
    if (check.ok) return storedId;
  }

  // Search calendarList for an existing matching summary.
  let pageToken = undefined;
  while (true) {
    const query = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : '';
    const listRes = await googleApiRequestWithAuthRetry(`/calendar/v3/users/me/calendarList${query}`, {}, auth);
    if (!listRes.ok) break;
    const items = listRes.json?.items || [];
    const match = items.find((c) => c?.summary === GOOGLE_CALENDAR_NAME);
    if (match?.id) {
      await chrome.storage.local.set({ [STORAGE_KEYS.calendarId]: match.id });
      return match.id;
    }
    pageToken = listRes.json?.nextPageToken;
    if (!pageToken) break;
  }

  const tz = getLocalTimeZone();
  const createRes = await googleApiRequestWithAuthRetry(`/calendar/v3/calendars`, {
    method: 'POST',
    body: { summary: GOOGLE_CALENDAR_NAME, timeZone: tz }
  }, auth);
  if (!createRes.ok) {
    throw new Error(createRes.json?.error?.message || 'Failed to create Google calendar.');
  }

  const calendarId = createRes.json?.id;
  if (!calendarId) throw new Error('Google calendar created but no id returned.');

  // Ensure the calendar is present in the user's calendar list (some accounts require this before events are writable).
  const addToList = await googleApiRequestWithAuthRetry(`/calendar/v3/users/me/calendarList`, {
    method: 'POST',
    body: { id: calendarId }
  }, auth);
  // Ignore failures here; even if it fails, the calendar may still be usable by id.
  if (!addToList.ok) {
    // no-op
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.calendarId]: calendarId });
  return calendarId;
}

function buildReservationStableKey(event) {
  const whenKey = String(event?.START_DATE_TIME || '').replace(/[^0-9]/g, '');
  return `${event?.ID_INSCRIPTION}-${event?.ID_EVENT}-${whenKey}`;
}

async function upsertEvent(calendarId, token, eventId, eventBody) {
  if (!isValidGoogleEventId(eventId)) {
    throw new Error(`Generated invalid Google Calendar event id before API call: ${eventId}`);
  }

  const auth = { token };
  const eventPath = `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;

  // Google Calendar API does not create new events via PUT /events/{eventId}.
  // Create must be done via POST /events (optionally with body.id), while updates use PUT /events/{eventId}.
  const getRes = await googleApiRequestWithAuthRetry(eventPath, {}, auth);
  if (getRes.ok) {
    const putRes = await googleApiRequestWithAuthRetry(
      eventPath,
      { method: 'PUT', body: { ...eventBody, id: eventId } },
      auth
    );
    return { res: putRes, token: auth.token, op: 'update' };
  }

  if (getRes.status === 404) {
    const postRes = await googleApiRequestWithAuthRetry(
      `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      { method: 'POST', body: { ...eventBody, id: eventId } },
      auth
    );
    return { res: postRes, token: auth.token, op: 'create' };
  }

  // If GET failed for another reason, bubble it up for better error context.
  return { res: getRes, token: auth.token, op: 'get_failed' };
}

async function deleteEventIfExists(calendarId, token, eventId) {
  const auth = { token };
  const res = await googleApiRequestWithAuthRetry(
    `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE' },
    auth
  );
  if (res.ok) return { deleted: true, token: auth.token };
  if (res.status === 404) return { deleted: false, token: auth.token };
  return { deleted: false, token: auth.token, error: res.json?.error?.message || res.text || 'Delete failed' };
}

function parseRangeYears(fromDate, toDate) {
  // dd/mm/yyyy
  const fromYear = parseInt(String(fromDate || '').split('/')[2] || '', 10);
  const toYear = parseInt(String(toDate || '').split('/')[2] || '', 10);
  if (!fromYear || !toYear) return { fromYear: null, toYear: null };
  return { fromYear, toYear };
}

export async function syncReservationsToGoogleCalendar(childrenWithEvents, { fromDate, toDate }, onProgress) {
  const report = (stage, detail) => {
    try {
      if (typeof onProgress === 'function') onProgress({ stage, detail });
    } catch {
      // ignore
    }
  };

  if (GOOGLE_SYNC_DEBUG_DETAILS) {
    report('debug', `Google sync code version: ${GOOGLE_SYNC_CODE_VERSION}`);
  }
  report('auth', 'Authorizing with Google…');
  const auth = { token: await getAuthTokenInteractive() };

  report('calendar', `Ensuring calendar "${GOOGLE_CALENDAR_NAME}" exists…`);
  const calendarId = await getOrCreateDedicatedCalendarId(auth);
  report('calendar', `Using calendarId: ${calendarId}`);
  const tz = getLocalTimeZone();

  let created = 0;
  let updated = 0;
  let deleted = 0;

  report('events', 'Syncing reservation events…');
  for (const entry of childrenWithEvents) {
    const child = entry.child;
    const events = entry.events || [];

    if (child?.name) report('events', `Syncing events for ${child.name}…`);
    for (const ev of events) {
      const stableKey = buildReservationStableKey(ev);
      const eventId = await buildGoogleEventId('smdf', stableKey);
      const start = parsePortalDateTime(ev?.START_DATE_TIME);
      const dayPrefix = `[${toPortalDayLabel(start)}]`;

      if (ev?.IS_SELECTED === 0) {
        report('events', `${dayPrefix} Removing cancelled reservation…`);
        const delRes = await deleteEventIfExists(calendarId, auth.token, eventId);
        auth.token = delRes.token;
        if (delRes.deleted) deleted += 1;
        continue;
      }

      const end = parsePortalDateTime(ev?.END_DATE_TIME);
      if (!start || !end) continue;

      const summary = `${child?.name || ''} — ${ev?.FULL_DESCRIPTION || ev?.DESCRIPTION || ''}`.trim();
      const descriptionLines = [
        `Enfant: ${child?.name || ''} ${child?.lastName || ''}`.trim(),
        `Source: Portail Famille Saint-Maur (AgoraPlus)`,
        `Generated by extension: saint_maur_family_portal_extension`,
        `Portal IDs: ID_INSCRIPTION=${ev?.ID_INSCRIPTION ?? ''}, ID_EVENT=${ev?.ID_EVENT ?? ''}, ID_TARGET=${ev?.ID_TARGET ?? ''}`
      ];

      const body = {
        summary,
        description: descriptionLines.join('\n'),
        start: { dateTime: toRfc3339Local(start), timeZone: tz },
        end: { dateTime: toRfc3339Local(end), timeZone: tz }
      };

      report('events', `${dayPrefix} Upserting: ${summary}`);
      const up = await upsertEvent(calendarId, auth.token, eventId, body);
      auth.token = up.token;
      if (!up.res.ok) {
        const msg = up.res.json?.error?.message || up.res.text || 'Failed to upsert event.';
        const debug = [
          `Google API error while upserting event`,
          `status=${up.res.status}`,
          `url=${up.res.url || 'unknown'}`,
          `calendarId=${calendarId}`,
          `eventId=${eventId}`,
          `op=${up.op || 'unknown'}`,
          `message=${msg}`
        ].join(' | ');
        report('error', debug);
        throw new Error(debug);
      }
      if (up.op === 'create') created += 1;
      else updated += 1;
    }
  }

  const { reminderDay } = await chrome.storage.local.get(['reminderDay']);
  const { fromYear, toYear } = parseRangeYears(fromDate, toDate);
  if (fromYear && toYear) {
    report('reminders', 'Syncing payment reminders…');
    for (let year = fromYear; year <= toYear; year++) {
      for (let month = 1; month <= 12; month++) {
        const monthStr = String(month).padStart(2, '0');
        const reminderKey = `SCHOOLFEE-${year}${monthStr}`;
        const reminderId = await buildGoogleEventId('smdfreminder', reminderKey);

        if (!reminderDay) {
          const delRes = await deleteEventIfExists(calendarId, auth.token, reminderId);
          auth.token = delRes.token;
          if (delRes.deleted) deleted += 1;
          continue;
        }

        const day = Math.min(Math.max(parseInt(reminderDay, 10) || 1, 1), 28);
        const startDate = `${year}-${monthStr}-${String(day).padStart(2, '0')}`;
        const endDate = addDaysYmd(year, month, day, 1);

        const body = {
          summary: 'Paiement Frais Scolaires',
          description: [
            'Rappel de paiement frais scolaires',
            'Generated by extension: saint_maur_family_portal_extension'
          ].join('\n'),
          start: { date: startDate },
          end: { date: endDate }
        };

        report('reminders', `Upserting reminder ${year}-${monthStr}`);
        const up = await upsertEvent(calendarId, auth.token, reminderId, body);
        auth.token = up.token;
        if (!up.res.ok) {
          const msg = up.res.json?.error?.message || up.res.text || 'Failed to upsert reminder.';
          const debug = `Google API error while upserting reminder | status=${up.res.status} | url=${up.res.url || 'unknown'} | calendarId=${calendarId} | eventId=${reminderId} | op=${up.op || 'unknown'} | message=${msg}`;
          report('error', debug);
          throw new Error(debug);
        }
        if (up.op === 'create') created += 1;
        else updated += 1;
      }
    }
  }

  report('done', 'Sync finished.');
  return { calendarId, created, updated, deleted };
}
