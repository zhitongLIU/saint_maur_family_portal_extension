const GOOGLE_CALENDAR_BASE_NAME = 'Saint-Maur Périscolaire';
const GOOGLE_SYNC_DEBUG_DETAILS = false;
const GOOGLE_SYNC_CODE_VERSION = 'google-sync-id-base32hex-2026-05-31';
const STORAGE_KEYS = {
  calendarIdsByName: 'googleCalendarIdsByName'
};
const GOOGLE_BATCH_LIMIT = 1000;

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

function splitHttpMessage(message) {
  const normalized = String(message || '').replace(/\r\n/g, '\n');
  const idx = normalized.indexOf('\n\n');
  if (idx === -1) return { head: normalized, body: '' };
  return {
    head: normalized.slice(0, idx),
    body: normalized.slice(idx + 2)
  };
}

function readHeader(headersText, headerName) {
  const target = String(headerName || '').toLowerCase();
  for (const line of String(headersText || '').split(/\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    if (line.slice(0, idx).trim().toLowerCase() === target) {
      return line.slice(idx + 1).trim();
    }
  }
  return '';
}

function parseBatchResponse(text, contentType, requests) {
  const boundaryMatch = String(contentType || '').match(/boundary="?([^";]+)"?/i);
  if (!boundaryMatch) {
    return requests.map((request) => ({
      ok: false,
      status: 0,
      json: null,
      text,
      path: request.path
    }));
  }

  const boundary = boundaryMatch[1];
  const results = [];
  String(text || '')
    .split(`--${boundary}`)
    .map((part) => part.trim())
    .filter((part) => part && part !== '--')
    .forEach((part, index) => {
      const { head: partHead, body: httpMessage } = splitHttpMessage(part);
      const { head: responseHead, body } = splitHttpMessage(httpMessage);
      const statusMatch = responseHead.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i);
      const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      const contentId = readHeader(partHead, 'Content-ID');
      const contentIdMatch = contentId.match(/(?:response-)?(\d+)/i);
      const requestIndex = contentIdMatch ? parseInt(contentIdMatch[1], 10) - 1 : index;
      let json = null;
      try { json = body ? JSON.parse(body) : null; } catch { json = null; }
      results[requestIndex] = {
        ok: status >= 200 && status < 300,
        status,
        json,
        text: body,
        path: requests[requestIndex]?.path || ''
      };
    });
  return results;
}

function buildBatchBody(requests, boundary) {
  return requests.map((request, index) => {
    const lines = [
      `--${boundary}`,
      'Content-Type: application/http',
      `Content-ID: ${index + 1}`,
      '',
      `${request.method || 'GET'} ${request.path} HTTP/1.1`
    ];

    if (request.body) {
      lines.push('Content-Type: application/json; charset=UTF-8');
    }

    lines.push('');
    if (request.body) lines.push(JSON.stringify(request.body));
    return lines.join('\r\n');
  }).concat(`--${boundary}--`).join('\r\n');
}

async function googleBatchRequest(requests, auth, { interactive = true } = {}) {
  if (!requests.length) return [];

  const boundary = `batch_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const url = 'https://www.googleapis.com/batch/calendar/v3';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': `multipart/mixed; boundary=${boundary}`
    },
    body: buildBatchBody(requests, boundary)
  });

  const text = await res.text();
  if ((res.status === 401 || res.status === 403) && interactive) {
    await removeCachedAuthToken(auth.token);
    auth.token = await getAuthTokenInteractive();
    return googleBatchRequest(requests, auth, { interactive: false });
  }

  if (!res.ok) {
    return requests.map((request) => ({
      ok: false,
      status: res.status,
      json: null,
      text,
      path: request.path
    }));
  }

  const parsed = parseBatchResponse(text, res.headers.get('Content-Type'), requests);
  return requests.map((request, index) => parsed[index] || {
    ok: false,
    status: 0,
    json: null,
    text: 'Missing batch response part.',
    path: request.path
  });
}

async function googleBatchRequestAll(requests, auth) {
  const results = [];
  for (let i = 0; i < requests.length; i += GOOGLE_BATCH_LIMIT) {
    const chunk = requests.slice(i, i + GOOGLE_BATCH_LIMIT);
    results.push(...await googleBatchRequest(chunk, auth));
  }
  return results;
}

function calendarEventPath(calendarId, eventId) {
  return `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
}

function calendarEventsPath(calendarId) {
  return `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
}

function buildChildCalendarName(child) {
  const childName = String(child?.name || '').trim();
  return childName ? `${childName} - ${GOOGLE_CALENDAR_BASE_NAME}` : GOOGLE_CALENDAR_BASE_NAME;
}

async function getOrCreateDedicatedCalendarId(auth, calendarName) {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.calendarIdsByName]);
  const storedIdsByName = stored?.[STORAGE_KEYS.calendarIdsByName] || {};
  const storedId = storedIdsByName[calendarName];
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
    const match = items.find((c) => c?.summary === calendarName);
    if (match?.id) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.calendarIdsByName]: { ...storedIdsByName, [calendarName]: match.id }
      });
      return match.id;
    }
    pageToken = listRes.json?.nextPageToken;
    if (!pageToken) break;
  }

  const tz = getLocalTimeZone();
  const createRes = await googleApiRequestWithAuthRetry(`/calendar/v3/calendars`, {
    method: 'POST',
    body: { summary: calendarName, timeZone: tz }
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

  await chrome.storage.local.set({
    [STORAGE_KEYS.calendarIdsByName]: { ...storedIdsByName, [calendarName]: calendarId }
  });
  return calendarId;
}

function buildReservationStableKey(event) {
  const whenKey = String(event?.START_DATE_TIME || '').replace(/[^0-9]/g, '');
  return `${event?.ID_INSCRIPTION}-${event?.ID_EVENT}-${whenKey}`;
}

function uniqueEventOps(ops) {
  const byId = new Map();
  for (const op of ops) byId.set(op.eventId, op);
  return [...byId.values()];
}

export function isGoogleEventMissingStatus(status) {
  return status === 404 || status === 410;
}

function formatGoogleBatchError(action, result, calendarId, op, operation) {
  const msg = result.json?.error?.message || result.text || `Failed to ${action}.`;
  return [
    `Google API error while ${action}`,
    `status=${result.status}`,
    `path=${result.path || 'unknown'}`,
    `calendarId=${calendarId}`,
    `eventId=${op.eventId}`,
    `label=${op.label || 'unknown'}`,
    `op=${operation || 'unknown'}`,
    `message=${msg}`
  ].join(' | ');
}

async function batchDeleteEventsIfExists(calendarId, auth, ops, report, stage) {
  const uniqueOps = uniqueEventOps(ops);
  if (!uniqueOps.length) return 0;

  report(stage, `Deleting ${uniqueOps.length} obsolete event(s)…`);
  const requests = uniqueOps.map((op) => ({
    method: 'DELETE',
    path: calendarEventPath(calendarId, op.eventId)
  }));
  const results = await googleBatchRequestAll(requests, auth);

  let deleted = 0;
  results.forEach((result, index) => {
    const op = uniqueOps[index];
    if (result.ok) {
      deleted += 1;
      return;
    }
    if (isGoogleEventMissingStatus(result.status)) return;

    const debug = formatGoogleBatchError('deleting event', result, calendarId, op, 'delete');
    report('error', debug);
    throw new Error(debug);
  });

  return deleted;
}

async function batchUpsertEvents(calendarId, auth, ops, report, stage) {
  const uniqueOps = uniqueEventOps(ops);
  if (!uniqueOps.length) return { created: 0, updated: 0 };

  for (const op of uniqueOps) {
    if (!isValidGoogleEventId(op.eventId)) {
      throw new Error(`Generated invalid Google Calendar event id before API call: ${op.eventId}`);
    }
  }

  report(stage, `Checking ${uniqueOps.length} event(s) before upsert…`);
  const getRequests = uniqueOps.map((op) => ({
    method: 'GET',
    path: calendarEventPath(calendarId, op.eventId)
  }));
  const getResults = await googleBatchRequestAll(getRequests, auth);

  const applyRequests = [];
  const applyOps = [];
  getResults.forEach((result, index) => {
    const op = uniqueOps[index];
    if (result.ok) {
      applyRequests.push({
        method: 'PUT',
        path: calendarEventPath(calendarId, op.eventId),
        body: { ...op.body, id: op.eventId }
      });
      applyOps.push({ ...op, operation: 'update' });
      return;
    }

    if (isGoogleEventMissingStatus(result.status)) {
      applyRequests.push({
        method: 'POST',
        path: calendarEventsPath(calendarId),
        body: { ...op.body, id: op.eventId }
      });
      applyOps.push({ ...op, operation: 'create' });
      return;
    }

    const debug = formatGoogleBatchError('checking event', result, calendarId, op, 'get');
    report('error', debug);
    throw new Error(debug);
  });

  report(stage, `Applying ${applyRequests.length} event upsert(s)…`);
  const applyResults = await googleBatchRequestAll(applyRequests, auth);

  let created = 0;
  let updated = 0;
  applyResults.forEach((result, index) => {
    const op = applyOps[index];
    if (!result.ok) {
      const debug = formatGoogleBatchError('upserting event', result, calendarId, op, op.operation);
      report('error', debug);
      throw new Error(debug);
    }
    if (op.operation === 'create') created += 1;
    else updated += 1;
  });

  return { created, updated };
}

function parseRangeYears(fromDate, toDate) {
  // dd/mm/yyyy
  const fromYear = parseInt(String(fromDate || '').split('/')[2] || '', 10);
  const toYear = parseInt(String(toDate || '').split('/')[2] || '', 10);
  if (!fromYear || !toYear) return { fromYear: null, toYear: null };
  return { fromYear, toYear };
}

async function preparePaymentReminderOps(upsertOps, deleteOps, { reminderDay, fromYear, toYear }) {
  if (!fromYear || !toYear) return;

  for (let year = fromYear; year <= toYear; year++) {
    for (let month = 1; month <= 12; month++) {
      const monthStr = String(month).padStart(2, '0');
      const reminderKey = `SCHOOLFEE-${year}${monthStr}`;
      const reminderId = await buildGoogleEventId('smdfreminder', reminderKey);

      if (!reminderDay) {
        deleteOps.push({ eventId: reminderId, label: `payment reminder ${year}-${monthStr}` });
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

      upsertOps.push({ eventId: reminderId, body, label: `payment reminder ${year}-${monthStr}` });
    }
  }
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

  const tz = getLocalTimeZone();
  const { reminderDay } = await chrome.storage.local.get(['reminderDay']);
  const { fromYear, toYear } = parseRangeYears(fromDate, toDate);

  let created = 0;
  let updated = 0;
  let deleted = 0;
  const calendarIds = {};

  for (const entry of childrenWithEvents) {
    const child = entry.child;
    const events = entry.events || [];
    const calendarName = buildChildCalendarName(child);

    report('calendar', `Ensuring calendar "${calendarName}" exists…`);
    const calendarId = await getOrCreateDedicatedCalendarId(auth, calendarName);
    calendarIds[calendarName] = calendarId;
    report('calendar', `Using calendar "${calendarName}"…`);

    const upsertOps = [];
    const deleteOps = [];

    report('events', `Preparing events for ${child?.name || calendarName}…`);
    for (const ev of events) {
      const stableKey = buildReservationStableKey(ev);
      const eventId = await buildGoogleEventId('smdf', stableKey);
      const start = parsePortalDateTime(ev?.START_DATE_TIME);
      const dayPrefix = `[${toPortalDayLabel(start)}]`;

      if (ev?.IS_SELECTED === 0) {
        deleteOps.push({ eventId, label: `${dayPrefix} cancelled reservation` });
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

      upsertOps.push({ eventId, body, label: `${dayPrefix} ${summary}` });
    }

    report('reminders', `Preparing payment reminders for ${child?.name || calendarName}…`);
    await preparePaymentReminderOps(upsertOps, deleteOps, { reminderDay, fromYear, toYear });

    deleted += await batchDeleteEventsIfExists(calendarId, auth, deleteOps, report, 'events');
    const upserted = await batchUpsertEvents(calendarId, auth, upsertOps, report, 'events');
    created += upserted.created;
    updated += upserted.updated;
  }

  report('done', 'Sync finished.');
  return { calendarIds, created, updated, deleted };
}
