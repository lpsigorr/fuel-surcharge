// entry-api.e2e.mjs
// LOCAL TESTING ONLY. Calls publish_diesel_price the way a website would: as an HTTP request to the REAL PostgREST
// (the program Supabase uses to turn the database into a web API), against a real local Postgres that has both
// migrations. It checks what the SQL tests cannot: the HTTP status codes, the JSON shapes and how numbers arrive.
//
//   node --test supabase/tests/entry-api.e2e.mjs      (needs PGBIN and POSTGREST_BIN, see run-function-tests.sh)
//
// What is a stand-in: the gateway and Supabase Auth (see functions/rig.mjs). Deno is not needed here.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startRig, userToken, anonToken } from './functions/rig.mjs';

const ENTRY = process.env.ENTRY_MIGRATION || fileURLToPath(new URL('../migrations/20261009150000_diesel_price_entry.sql', import.meta.url));
const ADMIN = randomUUID();
const PLAIN = randomUUID();
let rig;

before(async () => {
  rig = await startRig({ extraMigrations: [ENTRY], withFunction: false });
  rig.sql(`insert into auth.users (id) values ('${ADMIN}'), ('${PLAIN}');
           insert into public.platform_admins (user_id) values ('${ADMIN}');`);
});
after(async () => { await rig?.stop(); });

async function rpc(token, body, { method = 'POST', name = 'publish_diesel_price' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) { headers.authorization = `Bearer ${token}`; headers.apikey = token; }
  const r = await fetch(`${rig.restUrl}/rpc/${name}`, { method, headers, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text, type: r.headers.get('content-type') };
}
const admin = () => userToken(ADMIN);
const plain = () => userToken(PLAIN);
const prices = () => rig.sql('select monday, price_cents from public.fuel_prices order by monday').map(([m, c]) => `${m}:${c}`);

describe('publish_diesel_price over HTTP (real PostgREST, real Postgres)', () => {
  test('1. an admin publishes a price sent as a JSON number: 200 and the stored cents', async () => {
    const r = await rpc(admin(), { p_monday: '2026-09-21', p_eur_per_1000l: 1431.5 });
    assert.equal(r.status, 200, r.text);
    assert.match(r.type, /application\/json/);
    assert.equal(r.json.status, 'created');
    assert.equal(r.json.price_cents, 143150);
    assert.equal(r.json.eur_per_1000l, '1431.50');
    assert.equal(r.json.compared_with, null);
    assert.deepEqual(prices(), ['2026-09-21:143150']);
  });

  test('2. the same price sent as a JSON string is the same price: 200 unchanged', async () => {
    const r = await rpc(admin(), { p_monday: '2026-09-21', p_eur_per_1000l: '1431.50' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'unchanged');
    assert.deepEqual(prices(), ['2026-09-21:143150']);
  });

  test('3. a big move is refused with HTTP 409 and the code, sentence and hint in the standard error shape', async () => {
    const r = await rpc(admin(), { p_monday: '2026-09-28', p_eur_per_1000l: 1534.7 });
    assert.equal(r.status, 409, r.text);
    assert.deepEqual(Object.keys(r.json).sort(), ['code', 'details', 'hint', 'message']);
    assert.equal(r.json.code, 'PT409');
    assert.equal(r.json.message, 'BIG_MOVE');
    assert.equal(r.json.details, '1534.70 is +7.21 % compared with 1431.50 on 2026-09-21. The limit is 5 %.');
    assert.match(r.json.hint, /accept_big_move = true/);
    assert.deepEqual(prices(), ['2026-09-21:143150']);
  });

  test('4. the same call with p_accept_big_move = true creates it, and says what it was compared with', async () => {
    const r = await rpc(admin(), { p_monday: '2026-09-28', p_eur_per_1000l: 1534.7, p_accept_big_move: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'created');
    assert.equal(r.json.big_move_accepted, true);
    assert.deepEqual(r.json.compared_with, { monday: '2026-09-21', price_cents: 143150, change_bp: 721 });
    assert.deepEqual(prices(), ['2026-09-21:143150', '2026-09-28:153470']);
  });

  test('5. a different price for a stored Monday: 409 PRICE_EXISTS; with p_replace = true: 200 replaced', async () => {
    const refused = await rpc(admin(), { p_monday: '2026-09-28', p_eur_per_1000l: 1500 });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.json.message, 'PRICE_EXISTS');
    assert.equal(refused.json.details, '2026-09-28 already has the price 1534.70.');
    const replaced = await rpc(admin(), { p_monday: '2026-09-28', p_eur_per_1000l: 1500, p_replace: true });
    assert.equal(replaced.status, 200, replaced.text);
    assert.equal(replaced.json.status, 'replaced');
    assert.deepEqual(prices(), ['2026-09-21:143150', '2026-09-28:150000']);
  });

  test('6. input mistakes are HTTP 422 with their own codes', async () => {
    const tuesday = await rpc(admin(), { p_monday: '2026-09-29', p_eur_per_1000l: 1500 });
    assert.equal(tuesday.status, 422, tuesday.text);
    assert.equal(tuesday.json.code, 'PT422');
    assert.equal(tuesday.json.message, 'INVALID_MONDAY');
    const slipped = await rpc(admin(), { p_monday: '2026-10-05', p_eur_per_1000l: 15347 });
    assert.equal(slipped.status, 422, slipped.text);
    assert.equal(slipped.json.message, 'PRICE_OUT_OF_RANGE');
    const three = await rpc(admin(), { p_monday: '2026-10-05', p_eur_per_1000l: 1534.705 });
    assert.equal(three.status, 422, three.text);
    assert.equal(three.json.message, 'INVALID_PRICE');
    assert.equal(three.json.details, '1534.705 has more than 2 decimals.');
    assert.equal(prices().length, 2);
  });

  test('7. a number with floating-point noise (1534.7000000000001) is refused, not rounded', async () => {
    const r = await rpc(admin(), '{"p_monday":"2026-10-05","p_eur_per_1000l":1534.7000000000001}');
    assert.equal(r.status, 422, r.text);
    assert.equal(r.json.message, 'INVALID_PRICE');
    assert.equal(prices().length, 2);
  });

  test('8. a signed-in user who is not a platform admin: 403 NOT_ALLOWED', async () => {
    const r = await rpc(plain(), { p_monday: '2026-10-05', p_eur_per_1000l: 1540 });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.code, 'PT403');
    assert.equal(r.json.message, 'NOT_ALLOWED');
    assert.equal(prices().length, 2);
  });

  test('9. not signed in (anon key, or no key at all): 401, permission denied for the function', async () => {
    for (const token of [anonToken(), null]) {
      const r = await rpc(token, { p_monday: '2026-10-05', p_eur_per_1000l: 1540 });
      assert.equal(r.status, 401, r.text);
      assert.equal(r.json.code, '42501');
    }
    assert.equal(prices().length, 2);
  });

  test('10. a GET request cannot write (the function is volatile, so only POST is allowed): 405', async () => {
    const r = await fetch(`${rig.restUrl}/rpc/publish_diesel_price?p_monday=2026-10-05&p_eur_per_1000l=1540`, { headers: { authorization: `Bearer ${admin()}`, apikey: admin() } });
    assert.equal(r.status, 405, await r.text());
    assert.equal(prices().length, 2);
  });

  test('11. wrong parameter names do not find the function (404), so a typo in the website code fails loudly', async () => {
    const r = await rpc(admin(), { monday: '2026-10-05', price: 1540 });
    assert.equal(r.status, 404, r.text);
    assert.equal(r.json.code, 'PGRST202');
    assert.equal(prices().length, 2);
  });

  test('12. a date that is not a date is refused by the database before the function runs: 400', async () => {
    const r = await rpc(admin(), { p_monday: 'banana', p_eur_per_1000l: 1540 });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.code, '22007');
  });

  test('13. everyone signed in can read the price list; only the function (or an admin) writes it', async () => {
    const read = await fetch(`${rig.restUrl}/fuel_prices?select=monday,price_cents&order=monday`, { headers: { authorization: `Bearer ${plain()}`, apikey: plain() } });
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), [{ monday: '2026-09-21', price_cents: 143150 }, { monday: '2026-09-28', price_cents: 150000 }]);
    const write = await fetch(`${rig.restUrl}/fuel_prices`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${plain()}`, apikey: plain() },
      body: JSON.stringify({ monday: '2026-10-05', price_cents: 150000 }) });
    assert.equal(write.status, 403);
    assert.equal(prices().length, 2);
  });

  test('14. the audit trail saw all of it (read here as the database owner)', () => {
    const rows = rig.sql(`select op, monday, coalesce(old_price_cents::text, '-'), coalesce(new_price_cents::text, '-'),
                                 case when changed_by = '${ADMIN}' then 'admin' else 'other' end
                          from private.fuel_price_changes order by id`);
    assert.deepEqual(rows, [
      ['insert', '2026-09-21', '-', '143150', 'admin'],
      ['insert', '2026-09-28', '-', '153470', 'admin'],
      ['update', '2026-09-28', '153470', '150000', 'admin'],
    ]);
  });
});
