import assert from 'node:assert/strict';
import { buildGoogleEventId } from '../background/google-calendar.js';

const id = await buildGoogleEventId(
  'smdf',
  '123456-987654-20250106163000'
);

assert.match(id, /^[0-9a-v]{5,80}$/);
assert.equal(id.includes('_'), false);
assert.equal(/[w-zA-Z-]/.test(id), false);
assert.equal(id.startsWith('smdf'), true);

const sanitized = await buildGoogleEventId(
  'Smdf_Reminder-WXYZ',
  'SCHOOLFEE-202501'
);

assert.match(sanitized, /^[0-9a-v]{5,80}$/);
assert.equal(sanitized.includes('_'), false);
assert.equal(/[w-zA-Z-]/.test(sanitized), false);

console.log('Google Calendar event ids are Calendar API-safe.');
