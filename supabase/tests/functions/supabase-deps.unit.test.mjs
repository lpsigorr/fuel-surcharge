// supabase-deps.unit.test.mjs
// Checks HOW the function talks to Supabase, using fake Supabase clients that record every call.
// The point: reads must go through the caller's own client (so row level security applies),
// and the powerful server client may be used for one thing only: inserting the quote.
// Run: node --test supabase/tests/functions/supabase-deps.unit.test.mjs   (or `npm test`)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDeps } from '../../functions/_shared/supabase-deps.mjs';

const ORG = '11111111-1111-4111-8111-111111111111';
const ZONE = '22222222-2222-4222-8222-222222222222';
const VEH = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

function fakeClient(name, log, { rows = {}, error = null, authResult } = {}) {
  return {
    from(table) {
      const call = { client: name, table, op: null, filters: [] };
      log.push(call);
      const q = {
        select(cols) { call.op = call.op ?? 'select'; call.cols = cols; return q; },
        insert(row) { call.op = 'insert'; call.row = row; return q; },
        eq(col, val) { call.filters.push([col, val]); return q; },
        maybeSingle: () => Promise.resolve({ data: rows[table] ?? null, error }),
        single: () => Promise.resolve({ data: rows[table] ?? { id: 'new-id', created_at: 'now' }, error }),
      };
      return q;
    },
    auth: { getUser: async () => authResult ?? { data: { user: { id: USER } }, error: null } },
  };
}

function setup(options = {}) {
  const log = [];
  const deps = makeDeps({
    userClient: fakeClient('user', log, options.user),
    adminClient: fakeClient('admin', log, options.admin),
    log: () => {},
  });
  return { deps, log };
}

describe('which client is used for what', () => {
  test('every read goes through the caller\'s own client; the server client is never used to read', async () => {
    const { deps, log } = setup({ user: { rows: { memberships: { role: 'owner' }, fuel_prices: { price_cents: 1 } } } });
    await deps.isMember(USER, ORG);
    await deps.getSettings(ORG);
    await deps.getZone(ORG, ZONE);
    await deps.getVehicleType(ORG, VEH);
    await deps.getRate(ORG, ZONE, VEH);
    await deps.getDieselPrice('2026-09-28');
    assert.deepEqual(log.map((c) => c.table), ['memberships', 'surcharge_settings', 'zones', 'vehicle_types', 'rates', 'fuel_prices']);
    assert.ok(log.every((c) => c.client === 'user' && c.op === 'select'), JSON.stringify(log));
  });

  test('the server client is used for exactly one thing: inserting into quotes', async () => {
    const { deps, log } = setup();
    const row = { organization_id: ORG, total_cents: 1 };
    const saved = await deps.insertQuote(row);
    assert.equal(log.length, 1);
    assert.equal(log[0].client, 'admin');
    assert.equal(log[0].table, 'quotes');
    assert.equal(log[0].op, 'insert');
    assert.deepEqual(log[0].row, row);
    assert.deepEqual(saved, { id: 'new-id', created_at: 'now' });
  });

  test('index.ts builds the caller\'s client from the publishable key and the server client from the secret key, once each', () => {
    const source = readFileSync(fileURLToPath(new URL('../../functions/create-quote/index.ts', import.meta.url)), 'utf8');
    assert.equal((source.match(/createClient\(url, publishableKey/g) || []).length, 1);
    assert.equal((source.match(/createClient\(url, secretKey/g) || []).length, 1);
    assert.match(source, /adminClient \?\?= createClient\(url, secretKey, CLIENT_OPTIONS\);/); // the server client carries no caller token
    assert.match(source, /global: \{ headers: \{ Authorization: authorization \} \}/); // the caller's client carries the caller's token
  });
});

describe('what each read asks for', () => {
  const filters = (log) => Object.fromEntries(log[0].filters);

  test('membership: this user in this carrier', async () => {
    const { deps, log } = setup({ user: { rows: { memberships: { role: 'staff' } } } });
    assert.equal(await deps.isMember(USER, ORG), true);
    assert.deepEqual(filters(log), { organization_id: ORG, user_id: USER });
  });
  test('membership: no row means not a member', async () => {
    const { deps } = setup();
    assert.equal(await deps.isMember(USER, ORG), false);
  });
  test('rate: this carrier, this zone, this vehicle type', async () => {
    const { deps, log } = setup({ user: { rows: { rates: { base_rate_cents: 5 } } } });
    assert.deepEqual(await deps.getRate(ORG, ZONE, VEH), { base_rate_cents: 5 });
    assert.deepEqual(filters(log), { organization_id: ORG, zone_id: ZONE, vehicle_type_id: VEH });
  });
  test('zone and vehicle type: this carrier and this id', async () => {
    const { deps, log } = setup();
    await deps.getZone(ORG, ZONE);
    await deps.getVehicleType(ORG, VEH);
    assert.deepEqual(Object.fromEntries(log[0].filters), { organization_id: ORG, id: ZONE });
    assert.deepEqual(Object.fromEntries(log[1].filters), { organization_id: ORG, id: VEH });
  });
  test('settings: only the five columns the maths needs', async () => {
    const { deps, log } = setup();
    await deps.getSettings(ORG);
    assert.equal(log[0].cols, 'fuel_share_bp, lag_days, threshold_bp, floor_at_zero, base_diesel_cents');
    assert.deepEqual(filters(log), { organization_id: ORG });
  });
  test('diesel price: the exact Monday, returned as a plain number', async () => {
    const { deps, log } = setup({ user: { rows: { fuel_prices: { price_cents: 153470 } } } });
    assert.equal(await deps.getDieselPrice('2026-09-28'), 153470);
    assert.deepEqual(filters(log), { monday: '2026-09-28' });
  });
  test('diesel price: no row gives null (so the quote is refused)', async () => {
    const { deps } = setup();
    assert.equal(await deps.getDieselPrice('2026-09-28'), null);
  });
});

describe('errors are never mistaken for "not found"', () => {
  const dbError = { code: '42501', message: 'permission denied' };

  for (const [name, call] of [
    ['isMember', (d) => d.isMember(USER, ORG)],
    ['getSettings', (d) => d.getSettings(ORG)],
    ['getZone', (d) => d.getZone(ORG, ZONE)],
    ['getVehicleType', (d) => d.getVehicleType(ORG, VEH)],
    ['getRate', (d) => d.getRate(ORG, ZONE, VEH)],
    ['getDieselPrice', (d) => d.getDieselPrice('2026-09-28')],
  ]) {
    test(`${name}: a database error throws instead of returning "nothing found"`, async () => {
      const { deps } = setup({ user: { error: dbError } });
      await assert.rejects(() => call(deps), /42501/);
    });
  }

  test('insertQuote: a database error throws', async () => {
    const { deps } = setup({ admin: { error: { code: '23514', message: 'check violation' } } });
    await assert.rejects(() => deps.insertQuote({}), /23514/);
  });

  test('getCaller: a user comes back as { userId }', async () => {
    const { deps } = setup();
    assert.deepEqual(await deps.getCaller('tok'), { userId: USER });
  });
  test('getCaller: Auth refusing the token (4xx) means "not signed in"', async () => {
    for (const status of [400, 401, 403, 404]) {
      const { deps } = setup({ user: { authResult: { data: { user: null }, error: { status, message: 'invalid JWT' } } } });
      assert.equal(await deps.getCaller('tok'), null, `status ${status}`);
    }
  });
  test('getCaller: Auth being down (5xx or no status) is an error, not "not signed in"', async () => {
    for (const status of [500, 502, 503, undefined, 0]) {
      const { deps } = setup({ user: { authResult: { data: { user: null }, error: { status, message: 'unavailable' } } } });
      await assert.rejects(() => deps.getCaller('tok'), /auth\.getUser/, `status ${status}`);
    }
  });
  test('getCaller: no user and no error means "not signed in"', async () => {
    const { deps } = setup({ user: { authResult: { data: { user: null }, error: null } } });
    assert.equal(await deps.getCaller('tok'), null);
  });
});
