// Voice booking. The point of these is the shape of the refusal: the desk
// falls back to a human-dialled call either way, and the difference between a
// useful fallback and a confusing one is whether the server said why.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-book-'));
process.env.STATE_FILE = path.join(stateDir, 'state.json');
process.env.AUTONOMY_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';

const { createApp } = await import('../src/app.js');
const { callScript } = await import('../src/routes/book.js');
const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const post = (body) =>
  fetch(`${base}/api/book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const valid = {
  venue: 'Osteria Mozza',
  phone: '+1 323 297 0100',
  partySize: 4,
  when: 'Friday at 8pm',
  onBehalfOf: 'Suhas',
};

test('an unconfigured server says so instead of 404ing', async () => {
  const res = await post(valid);
  assert.equal(res.status, 501, 'not 404 — the endpoint exists, the capability does not');
  const json = await res.json();
  assert.equal(json.ok, false);
  assert.equal(json.configured, false);
  assert.match(json.reason, /TWILIO_ACCOUNT_SID/, 'names what to set');
});

test('the refusal carries everything needed to dial by hand', async () => {
  const { fallback } = await (await post(valid)).json();
  assert.equal(fallback.venue, 'Osteria Mozza');
  assert.equal(fallback.phone, '+1 323 297 0100');
  assert.match(fallback.script, /table for 4/);
  assert.match(fallback.script, /Friday at 8pm/);
  assert.match(fallback.script, /Suhas/);
});

test('a malformed request is a 400 whether or not Twilio is wired up', async () => {
  const noVenue = await post({ phone: '+13232970100' });
  assert.equal(noVenue.status, 400);
  assert.match((await noVenue.json()).error, /venue/);

  const noPhone = await post({ venue: 'Somewhere' });
  assert.equal(noPhone.status, 400);
  assert.match((await noPhone.json()).error, /phone/);
});

test('a phone number scraped off a page is rejected here, not by Twilio', async () => {
  for (const phone of ['call us!', '555-CALL', '12', '+1 (323) 297 0100 ext 4']) {
    const res = await post({ venue: 'X', phone });
    assert.equal(res.status, 400, `${phone} should be refused`);
    assert.match((await res.json()).error, /unusable phone/);
  }
  // Human separators are fine; what is left has to be digits.
  const ok = await post({ venue: 'X', phone: '(323) 297-0100' });
  assert.equal(ok.status, 501, 'a usable number gets past validation');
});

test('the desk’s other spellings of the same fields are understood', async () => {
  const { fallback } = await (
    await post({ restaurant: 'Bestia', number: '+13232970100', people: 2, time: 'tomorrow 7pm' })
  ).json();
  assert.equal(fallback.venue, 'Bestia');
  assert.equal(fallback.partySize, 2);
  assert.match(fallback.script, /table for 2/);
});

test('status for a call that cannot exist is 501, not a fabricated state', async () => {
  const res = await fetch(`${base}/api/book/status/CA1234567890`);
  assert.equal(res.status, 501);
  const json = await res.json();
  assert.equal(json.ok, false);
  assert.equal(json.sid, 'CA1234567890');
  assert.equal(json.configured, false);
});

test('the capability is advertised as off rather than left to be discovered', async () => {
  const json = await (await fetch(`${base}/api/config`)).json();
  assert.equal(json.booking.configured, false);
  assert.equal(json.booking.provider, 'twilio');
});

test('the script degrades cleanly when half the details are missing', () => {
  assert.match(callScript({ venue: 'X', phone: '1' }), /book a table\./);
  assert.match(callScript({ partySize: 2, notes: 'Window seat please.' }), /Window seat please\./);
});
