// create-quote.unit.test.mjs
// Tests the rules of the create-quote endpoint with fake database access (no Postgres, no Supabase).
// Run: node --test supabase/tests/functions/create-quote.unit.test.mjs   (or `npm test` from the project root)
//
// Money in these tests is checked by hand:
//   Febetra, March 2022 (real): diesel 1.2446 -> 1.5347 EUR/L = 124460 -> 153470 (hundredths of EUR per 1000 L)
//   change = 29010 / 124460 = 23.31 %        surcharge = 21.10 % x 29010 / 124460 = 4.92 %
//   EUR 333.33 x 4.92 % = EUR 16.3998 -> EUR 16.40      total = EUR 349.73

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handleCreateQuote, ENGINE_VERSION, MAX_BODY_BYTES, parseBody } from '../../functions/_shared/create-quote.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)));

const ORG = '11111111-1111-4111-8111-111111111111';
const ZONE = '22222222-2222-4222-8222-222222222222';
const VEH = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

const SETTINGS = { fuel_share_bp: 2110, lag_days: 7, threshold_bp: 0, floor_at_zero: false, base_diesel_cents: 124460 };

// A fake database. Every call is recorded so tests can prove what was NOT called.
function fake(over = {}) {
  const calls = [];
  const rec = (name, fn) => async (...args) => {
    calls.push(name);
    return fn(...args);
  };
  const deps = {
    log: () => {},
    getCaller: rec('getCaller', async () => ({ userId: USER })),
    isMember: rec('isMember', async () => true),
    getSettings: rec('getSettings', async () => ({ ...SETTINGS })),
    getZone: rec('getZone', async () => ({ name: 'Brussels' })),
    getVehicleType: rec('getVehicleType', async () => ({ name: 'Van 3.5t' })),
    getRate: rec('getRate', async () => ({ base_rate_cents: 33333 })),
    getDieselPrice: rec('getDieselPrice', async () => 153470),
    insertQuote: rec('insertQuote', async () => ({ id: '55555555-5555-4555-8555-555555555555', created_at: '2026-10-09T13:00:00Z' })),
  };
  for (const [name, fn] of Object.entries(over)) deps[name] = rec(name, fn);
  return { deps, calls };
}

const body = (o = {}) => JSON.stringify({ organizationId: ORG, zoneId: ZONE, vehicleTypeId: VEH, serviceDate: '2026-10-09', ...o });
const request = (o = {}) => ({ method: 'POST', authorization: 'Bearer abc.def.ghi', bodyText: body(), ...o });

describe('the happy path (Febetra figures)', () => {
  test('saves the frozen quote and returns it', async () => {
    const { deps } = fake({
      getDieselPrice: async (monday) => {
        assert.equal(monday, '2026-09-28'); // Friday 9 Oct - 7 days = Fri 2 Oct, latest Monday on/before = 28 Sep
        return 153470;
      },
    });
    let saved;
    deps.insertQuote = async (row) => {
      saved = row;
      return { id: '55555555-5555-4555-8555-555555555555', created_at: '2026-10-09T13:00:00Z' };
    };
    const res = await handleCreateQuote(request({ bodyText: body({ customerReference: '  PO-1234  ' }) }), deps);

    assert.equal(res.status, 201);
    assert.deepEqual(saved, {
      organization_id: ORG,
      source: 'staff',
      created_by: USER,
      customer_reference: 'PO-1234',
      zone_name: 'Brussels',
      vehicle_type_name: 'Van 3.5t',
      service_date: '2026-10-09',
      rate_cents: 33333,
      base_diesel_cents: 124460,
      reference_monday: '2026-09-28',
      current_diesel_cents: 153470,
      fuel_share_bp: 2110,
      lag_days: 7,
      threshold_bp: 0,
      floor_at_zero: false,
      change_bp: 2331, // 23.31 %
      surcharge_bp: 492, // 4.92 %
      reason: 'APPLIED',
      surcharge_cents: 1640, // EUR 16.40
      total_cents: 34973, // EUR 349.73
      engine_version: ENGINE_VERSION,
    });
    assert.equal(res.body.quote.id, '55555555-5555-4555-8555-555555555555');
    assert.equal(res.body.quote.totalCents, 34973);
    assert.deepEqual(res.body.display, {
      rate: '€ 333,33',
      dieselChange: '23,31 %',
      surcharge: '4,92 %',
      surchargeAmount: '€ 16,40',
      total: '€ 349,73',
    });
  });

  test('created_by is the user Supabase Auth identified, and a userId in the body is refused', async () => {
    const other = '66666666-6666-4666-8666-666666666666';
    const { deps } = fake({ getCaller: async () => ({ userId: other }) });
    let saved;
    deps.insertQuote = async (row) => ((saved = row), { id: 'x', created_at: 'y' });
    assert.equal((await handleCreateQuote(request(), deps)).status, 201);
    assert.equal(saved.created_by, other);

    saved = undefined;
    const res = await handleCreateQuote(request({ bodyText: body({ userId: USER, createdBy: USER }) }), deps);
    assert.equal(res.status, 400);
    assert.equal(saved, undefined);
  });
});

describe('the reference Monday and the settings are respected', () => {
  test('lag 0 uses the Monday of the service week; lag comes from the carrier settings', async () => {
    const asked = [];
    const { deps } = fake({
      getSettings: async () => ({ ...SETTINGS, lag_days: 0 }),
      getDieselPrice: async (m) => (asked.push(m), 153470),
    });
    const res = await handleCreateQuote(request(), deps);
    assert.equal(res.status, 201);
    assert.deepEqual(asked, ['2026-10-05']); // Friday 9 Oct, no lag -> Monday 5 Oct
    assert.equal(res.body.quote.lagDays, 0);
  });

  test('below the threshold: surcharge is 0 and the reason says why', async () => {
    // base 150000 -> 151500 is +1.00 %, threshold 5.00 %
    const { deps } = fake({
      getSettings: async () => ({ ...SETTINGS, base_diesel_cents: 150000, threshold_bp: 500, fuel_share_bp: 2000 }),
      getDieselPrice: async () => 151500,
      getRate: async () => ({ base_rate_cents: 100000 }),
    });
    const res = await handleCreateQuote(request(), deps);
    assert.equal(res.status, 201);
    assert.equal(res.body.quote.reason, 'BELOW_THRESHOLD');
    assert.equal(res.body.quote.surchargeBp, 0);
    assert.equal(res.body.quote.totalCents, 100000);
  });

  test('a falling price gives a credit by default: -10.00 % x 20 % = -2.00 % of EUR 1000.00 = -EUR 20.00', async () => {
    const { deps } = fake({
      getSettings: async () => ({ ...SETTINGS, base_diesel_cents: 150000, fuel_share_bp: 2000 }),
      getDieselPrice: async () => 135000,
      getRate: async () => ({ base_rate_cents: 100000 }),
    });
    const res = await handleCreateQuote(request(), deps);
    assert.equal(res.status, 201);
    assert.equal(res.body.quote.surchargeBp, -200);
    assert.equal(res.body.quote.surchargeCents, -2000);
    assert.equal(res.body.quote.totalCents, 98000);
  });

  test('with floorAtZero the same fall gives no credit', async () => {
    const { deps } = fake({
      getSettings: async () => ({ ...SETTINGS, base_diesel_cents: 150000, fuel_share_bp: 2000, floor_at_zero: true }),
      getDieselPrice: async () => 135000,
      getRate: async () => ({ base_rate_cents: 100000 }),
    });
    const res = await handleCreateQuote(request(), deps);
    assert.equal(res.status, 201);
    assert.equal(res.body.quote.reason, 'FLOORED_AT_ZERO');
    assert.equal(res.body.quote.totalCents, 100000);
  });
});

describe('who may call it', () => {
  test('no Authorization header -> 401 and nothing is read or written', async () => {
    const { deps, calls } = fake();
    const res = await handleCreateQuote(request({ authorization: undefined }), deps);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHENTICATED');
    assert.deepEqual(calls, []);
  });

  for (const bad of ['', 'Bearer', 'Basic abc', 'Bearer a b', 'abc.def.ghi']) {
    test(`malformed Authorization "${bad}" -> 401`, async () => {
      const { deps, calls } = fake();
      const res = await handleCreateQuote(request({ authorization: bad }), deps);
      assert.equal(res.status, 401);
      assert.deepEqual(calls, []);
    });
  }

  test('a token Supabase Auth does not accept -> 401, nothing else is called', async () => {
    const { deps, calls } = fake({ getCaller: async () => null });
    const res = await handleCreateQuote(request(), deps);
    assert.equal(res.status, 401);
    assert.deepEqual(calls, ['getCaller']);
  });

  test('GET -> 405 before anything else happens', async () => {
    const { deps, calls } = fake();
    const res = await handleCreateQuote(request({ method: 'GET' }), deps);
    assert.equal(res.status, 405);
    assert.deepEqual(calls, []);
  });

  test('signed in but not a member of the carrier -> 403, no data of that carrier is read, nothing saved', async () => {
    const { deps, calls } = fake({ isMember: async () => false });
    const res = await handleCreateQuote(request(), deps);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'NOT_A_MEMBER');
    assert.deepEqual(calls, ['getCaller', 'isMember']);
  });
});

describe('what it refuses to quote', () => {
  const stops = async (over, status, code, expectText) => {
    const { deps, calls } = fake(over);
    const res = await handleCreateQuote(request(), deps);
    assert.equal(res.status, status);
    assert.equal(res.body.error.code, code);
    if (expectText) assert.match(res.body.error.message, expectText);
    assert.ok(!calls.includes('insertQuote'), 'nothing may be saved');
  };

  test('carrier has no settings yet -> 409', () => stops({ getSettings: async () => null }, 409, 'SETTINGS_MISSING'));
  test('zone not found for this carrier -> 404', () => stops({ getZone: async () => null }, 404, 'ZONE_NOT_FOUND'));
  test('vehicle type not found -> 404', () => stops({ getVehicleType: async () => null }, 404, 'VEHICLE_TYPE_NOT_FOUND'));
  test('no rate for that zone and vehicle -> 404', () => stops({ getRate: async () => null }, 404, 'RATE_NOT_FOUND'));
  test('no diesel price for the reference Monday -> 409, never a guess, says which Monday', () =>
    stops({ getDieselPrice: async () => null }, 409, 'DIESEL_PRICE_MISSING', /2026-09-28/));
  test('corrupt settings (fuel share 200 %) -> 500, nothing saved', async () => {
    const { deps, calls } = fake({ getSettings: async () => ({ ...SETTINGS, fuel_share_bp: 20000 }) });
    const res = await handleCreateQuote(request(), deps);
    assert.equal(res.status, 500);
    assert.match(res.body.error.message, /Nothing was saved/);
    assert.ok(!calls.includes('insertQuote'));
  });
});

describe('request validation', () => {
  const rejects = async (bodyText, field) => {
    const { deps, calls } = fake();
    const res = await handleCreateQuote(request({ bodyText }), deps);
    assert.equal(res.status, 400, bodyText);
    if (field) assert.equal(res.body.error.field, field);
    assert.ok(!calls.includes('insertQuote'));
  };

  test('not JSON', () => rejects('{nope'));
  test('JSON but not an object', async () => {
    await rejects('[1,2]');
    await rejects('"text"');
    await rejects('null');
  });
  test('unknown field is refused (catches typos such as "zone")', () => rejects(body({ zone: 'x' }), 'zone'));
  for (const field of ['organizationId', 'zoneId', 'vehicleTypeId']) {
    test(`${field} must be a UUID`, async () => {
      await rejects(body({ [field]: 'not-a-uuid' }), field);
      await rejects(body({ [field]: 123 }), field);
      await rejects(JSON.stringify({ organizationId: ORG, zoneId: ZONE, vehicleTypeId: VEH, serviceDate: '2026-10-09', [field]: undefined }), field);
    });
  }
  test('serviceDate must be a real YYYY-MM-DD date', async () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-5', '09/10/2026', '', 20261009, null]) {
      await rejects(body({ serviceDate: bad }), 'serviceDate');
    }
  });
  test('a leap day is a real date', async () => {
    const { deps } = fake();
    assert.equal((await handleCreateQuote(request({ bodyText: body({ serviceDate: '2028-02-29' }) }), deps)).status, 201);
  });
  test('customerReference must be text and at most 200 characters', async () => {
    await rejects(body({ customerReference: 5 }), 'customerReference');
    await rejects(body({ customerReference: 'x'.repeat(201) }), 'customerReference');
  });
  test('customerReference: 200 characters is fine, counted like the database (code points, not UTF-16 units)', () => {
    assert.equal(parseBody(body({ customerReference: 'x'.repeat(200) })).customerReference.length, 200);
    const emoji200 = '😀'.repeat(200); // 400 UTF-16 units but 200 characters
    assert.equal([...parseBody(body({ customerReference: emoji200 })).customerReference].length, 200);
    assert.throws(() => parseBody(body({ customerReference: '😀'.repeat(201) })));
  });
  test('customerReference: blank or missing becomes null', () => {
    assert.equal(parseBody(body({ customerReference: '   ' })).customerReference, null);
    assert.equal(parseBody(body({ customerReference: null })).customerReference, null);
    assert.equal(parseBody(body()).customerReference, null);
  });
  test('UUIDs are accepted in upper case and saved in lower case', () => {
    assert.equal(parseBody(body({ organizationId: ORG.toUpperCase() })).organizationId, ORG);
  });
  test('a body over the size limit -> 413', async () => {
    const { deps, calls } = fake();
    const res = await handleCreateQuote(request({ bodyText: body({ customerReference: 'x'.repeat(MAX_BODY_BYTES) }) }), deps);
    assert.equal(res.status, 413);
    assert.ok(!calls.includes('insertQuote'));
  });
});

describe('when something breaks', () => {
  test('failure before saving: 500 says nothing was saved, and does not leak the internal message', async () => {
    const logged = [];
    const { deps, calls } = fake({
      getSettings: async () => {
        throw new Error('password=hunter2 host=db.internal');
      },
    });
    deps.log = (e) => logged.push(e);
    const res = await handleCreateQuote(request(), deps);
    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, 'INTERNAL_ERROR');
    assert.match(res.body.error.message, /Nothing was saved/);
    assert.doesNotMatch(JSON.stringify(res.body), /hunter2|db\.internal/);
    assert.ok(!calls.includes('insertQuote'));
    assert.equal(logged.length, 1); // the detail goes to the log instead
    assert.match(logged[0].message, /hunter2/);
    assert.equal(logged[0].insertStarted, false);
  });

  test('failure while saving: 500 says it may not have been saved', async () => {
    const logged = [];
    const { deps } = fake({
      insertQuote: async () => {
        throw new Error('connection reset');
      },
    });
    deps.log = (e) => logged.push(e);
    const res = await handleCreateQuote(request(), deps);
    assert.equal(res.status, 500);
    assert.match(res.body.error.message, /may not have been saved/);
    assert.equal(logged[0].insertStarted, true);
  });
});

describe('guards on the code itself', () => {
  const rootEngine = read('../../../surcharge.mjs');
  const sharedEngine = read('../../functions/_shared/surcharge.mjs');

  test('the engine copy used by the function is byte-identical to the Step 1 engine (surcharge.mjs)', () => {
    assert.equal(createHash('sha256').update(sharedEngine).digest('hex'), createHash('sha256').update(rootEngine).digest('hex'));
  });

  test('ENGINE_VERSION names the exact engine bytes: change the engine and this fails until the version is bumped on purpose', () => {
    const hash = createHash('sha256').update(sharedEngine).digest('hex');
    assert.equal(ENGINE_VERSION, `surcharge.mjs sha256:${hash.slice(0, 12)}`);
    assert.ok(ENGINE_VERSION.length <= 80); // the database allows 1 to 80 characters
  });
});
