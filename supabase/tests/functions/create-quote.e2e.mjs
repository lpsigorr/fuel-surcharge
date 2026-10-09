// create-quote.e2e.mjs
// End-to-end test of the create-quote function: real Deno running the real index.ts, real supabase-js,
// real PostgREST, real Postgres with our migration and our row level security. See rig.mjs for what is
// real and what is a stand-in.
//
// Run: PGBIN=... POSTGREST_BIN=... DENO_BIN=... node --test --test-reporter=spec supabase/tests/functions/create-quote.e2e.mjs
// (supabase/tests/run-function-tests.sh does this for you.)

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startRig, userToken, serviceRoleToken, signJwt } from './rig.mjs';

// The engine version every saved quote must carry: the first 12 hex digits of the engine file's SHA-256.
const ENGINE_HASH = createHash('sha256')
  .update(readFileSync(fileURLToPath(new URL('../../functions/_shared/surcharge.mjs', import.meta.url))))
  .digest('hex')
  .slice(0, 12);

const U = (n) => `a0000000-0000-4000-8000-00000000000${n}`;
const A = U(1); // owner of carrier 1
const B = U(2); // staff of carrier 1
const C = U(3); // owner of carrier 2
const D = U(4); // signed in, belongs to no carrier
const E = U(5); // owner of carrier 3 (which has no settings)
const O1 = '10000000-0000-4000-8000-000000000001';
const O2 = '10000000-0000-4000-8000-000000000002';
const O3 = '10000000-0000-4000-8000-000000000003';
const Z1 = '20000000-0000-4000-8000-000000000001';
const Z2 = '20000000-0000-4000-8000-000000000002';
const Z3 = '20000000-0000-4000-8000-000000000003';
const V1 = '30000000-0000-4000-8000-000000000001';
const V2 = '30000000-0000-4000-8000-000000000002';
const V3 = '30000000-0000-4000-8000-000000000003';

let rig;
const seen = []; // every response body, to prove no secret ever leaks

before(async () => {
  rig = await startRig();
  rig.sql(`
    insert into auth.users (id) values ('${A}'), ('${B}'), ('${C}'), ('${D}'), ('${E}');
    insert into public.organizations (id, name) values ('${O1}', 'Alpha Transport'), ('${O2}', 'Beta Express'), ('${O3}', 'Gamma Freight');
    insert into public.memberships (organization_id, user_id, role) values
      ('${O1}', '${A}', 'owner'), ('${O1}', '${B}', 'staff'), ('${O2}', '${C}', 'owner'), ('${O3}', '${E}', 'owner');
    -- Carrier 1: the Febetra figures. Carrier 2: lag 0, 5 % threshold, no credits. Carrier 3: no settings yet.
    insert into public.surcharge_settings (organization_id, fuel_share_bp, lag_days, threshold_bp, floor_at_zero, base_diesel_cents) values
      ('${O1}', 2110, 7, 0, false, 124460),
      ('${O2}', 2000, 0, 500, true, 150000);
    insert into public.zones (id, organization_id, name) values ('${Z1}', '${O1}', 'Brussels'), ('${Z2}', '${O2}', 'Antwerp'), ('${Z3}', '${O3}', 'Ghent');
    insert into public.vehicle_types (id, organization_id, name) values ('${V1}', '${O1}', 'Van 3.5t'), ('${V2}', '${O2}', 'Truck 12t'), ('${V3}', '${O3}', 'Bike');
    insert into public.rates (organization_id, zone_id, vehicle_type_id, base_rate_cents) values
      ('${O1}', '${Z1}', '${V1}', 33333), ('${O2}', '${Z2}', '${V2}', 100000), ('${O3}', '${Z3}', '${V3}', 5000);
    insert into public.fuel_prices (monday, price_cents) values
      ('2026-09-28', 153470),  -- +23.31 % on carrier 1's base
      ('2026-10-05', 151500),  -- +1.00 % on carrier 2's base
      ('2026-10-12', 135000);  -- -10.00 % on carrier 2's base
  `);
});

after(async () => {
  await rig?.stop();
});

async function post(token, body, { raw = false, headers = {} } = {}) {
  const res = await fetch(rig.functionUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  seen.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers, text };
}
const req1 = (o = {}) => ({ organizationId: O1, zoneId: Z1, vehicleTypeId: V1, serviceDate: '2026-10-09', ...o });
const quoteCount = () => Number(rig.sql('select count(*) from public.quotes')[0][0]);

describe('a carrier member creates a quote (Febetra figures)', () => {
  test('owner A: 201, and the database row holds exactly the frozen numbers', async () => {
    const before = quoteCount();
    const res = await post(userToken(A), req1({ customerReference: 'PO-1234' }));
    assert.equal(res.status, 201, res.text);
    const q = res.json.quote;
    // by hand: 29010 / 124460 = 23.31 %, x 21.10 % = 4.92 %, EUR 333.33 x 4.92 % = 16.3998 -> EUR 16.40, total EUR 349.73
    assert.equal(q.changeBp, 2331);
    assert.equal(q.surchargeBp, 492);
    assert.equal(q.surchargeCents, 1640);
    assert.equal(q.totalCents, 34973);
    assert.equal(q.referenceMonday, '2026-09-28');
    assert.equal(res.json.display.total, '€ 349,73');
    assert.equal(quoteCount(), before + 1);

    const [row] = rig.sql(`select id, organization_id, source, created_by, customer_reference, zone_name, vehicle_type_name,
        service_date, rate_cents, base_diesel_cents, reference_monday, current_diesel_cents, fuel_share_bp, lag_days, threshold_bp,
        floor_at_zero, change_bp, surcharge_bp, reason, surcharge_cents, total_cents, engine_version
      from public.quotes where id = '${q.id}'`);
    assert.deepEqual(row, [
      q.id, O1, 'staff', A, 'PO-1234', 'Brussels', 'Van 3.5t', '2026-10-09', '33333', '124460', '2026-09-28', '153470',
      '2110', '7', '0', 'f', '2331', '492', 'APPLIED', '1640', '34973', `surcharge.mjs sha256:${ENGINE_HASH}`,
    ]);
  });

  test('staff B may create quotes too', async () => {
    const res = await post(userToken(B), req1());
    assert.equal(res.status, 201, res.text);
    assert.equal(rig.sql(`select created_by from public.quotes where id = '${res.json.quote.id}'`)[0][0], B);
  });

  test('carrier 2 (lag 0, 5 % threshold): +1.00 % is below the threshold, so no surcharge', async () => {
    const res = await post(userToken(C), { organizationId: O2, zoneId: Z2, vehicleTypeId: V2, serviceDate: '2026-10-09' });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.quote.referenceMonday, '2026-10-05'); // lag 0: Friday 9 Oct -> Monday 5 Oct
    assert.equal(res.json.quote.reason, 'BELOW_THRESHOLD');
    assert.equal(res.json.quote.totalCents, 100000);
  });

  test('carrier 2: a 10.00 % fall is floored at zero (no credit)', async () => {
    const res = await post(userToken(C), { organizationId: O2, zoneId: Z2, vehicleTypeId: V2, serviceDate: '2026-10-14' });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.quote.referenceMonday, '2026-10-12');
    assert.equal(res.json.quote.reason, 'FLOORED_AT_ZERO');
    assert.equal(res.json.quote.totalCents, 100000);
  });

  test('sending the same request twice saves two quotes (no duplicate protection yet: known limit)', async () => {
    const before = quoteCount();
    const one = await post(userToken(A), req1({ customerReference: 'DOUBLE' }));
    const two = await post(userToken(A), req1({ customerReference: 'DOUBLE' }));
    assert.equal(one.status, 201);
    assert.equal(two.status, 201);
    assert.notEqual(one.json.quote.id, two.json.quote.id);
    assert.equal(quoteCount(), before + 2);
  });

  test('several requests at the same moment all succeed and are saved separately', async () => {
    const before = quoteCount();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => post(userToken(A), req1({ customerReference: `PAR-${i}` }))));
    assert.ok(results.every((r) => r.status === 201));
    assert.equal(new Set(results.map((r) => r.json.quote.id)).size, 8);
    assert.equal(quoteCount(), before + 8);
  });
});

describe('who is turned away (and nothing is saved)', () => {
  const refuses = async (label, token, body, status, code) => {
    const before = quoteCount();
    const res = await post(token, body);
    assert.equal(res.status, status, `${label}: ${res.text}`);
    assert.equal(res.json.error.code, code, label);
    assert.equal(quoteCount(), before, `${label}: a quote was saved`);
  };

  test('no token -> 401', () => refuses('no token', null, req1(), 401, 'UNAUTHENTICATED'));
  test('garbage token -> 401', () => refuses('garbage', 'not-a-token', req1(), 401, 'UNAUTHENTICATED'));
  test('token signed with the wrong secret -> 401', () => refuses('forged', signJwt({ sub: A, role: 'authenticated', exp: 9999999999 }, 'some-other-secret-some-other-secret-123'), req1(), 401, 'UNAUTHENTICATED'));
  test('expired token -> 401', () => refuses('expired', userToken(A, { exp: 1000 }), req1(), 401, 'UNAUTHENTICATED'));
  test('the server key used as if it were a user -> 401', () => refuses('service role', serviceRoleToken(), req1(), 401, 'UNAUTHENTICATED'));
  test('signed in but belonging to no carrier -> 403', () => refuses('D', userToken(D), req1(), 403, 'NOT_A_MEMBER'));
  test('a user that does not exist in the database at all -> 403', () => refuses('ghost', userToken('a0000000-0000-4000-8000-0000000000ff'), req1(), 403, 'NOT_A_MEMBER'));
  test("carrier 2's owner naming carrier 1 -> 403", () => refuses('C->O1', userToken(C), req1(), 403, 'NOT_A_MEMBER'));
  test("carrier 1's owner naming carrier 2 -> 403", () => refuses('A->O2', userToken(A), { organizationId: O2, zoneId: Z2, vehicleTypeId: V2, serviceDate: '2026-10-09' }, 403, 'NOT_A_MEMBER'));
  test("own carrier but another carrier's zone -> 404", () => refuses('zone', userToken(A), req1({ zoneId: Z2 }), 404, 'ZONE_NOT_FOUND'));
  test("own carrier but another carrier's vehicle type -> 404", () => refuses('vehicle', userToken(A), req1({ vehicleTypeId: V2 }), 404, 'VEHICLE_TYPE_NOT_FOUND'));
  test('a zone that exists but has no rate for that vehicle -> 404', async () => {
    rig.sql(`insert into public.vehicle_types (id, organization_id, name) values ('30000000-0000-4000-8000-0000000000aa', '${O1}', 'Truck 7.5t')`);
    await refuses('no rate', userToken(A), req1({ vehicleTypeId: '30000000-0000-4000-8000-0000000000aa' }), 404, 'RATE_NOT_FOUND');
  });
  test('carrier without settings -> 409', () => refuses('no settings', userToken(E), { organizationId: O3, zoneId: Z3, vehicleTypeId: V3, serviceDate: '2026-10-09' }, 409, 'SETTINGS_MISSING'));
  test('no diesel price for the reference Monday -> 409, never guessed', async () => {
    const before = quoteCount();
    const res = await post(userToken(A), req1({ serviceDate: '2026-11-20' })); // reference Monday 2026-11-09 has no price
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'DIESEL_PRICE_MISSING');
    assert.match(res.json.error.message, /2026-11-09/);
    assert.equal(quoteCount(), before);
  });
  test('bad input -> 400', () => refuses('bad date', userToken(A), req1({ serviceDate: '2026-02-30' }), 400, 'INVALID_REQUEST'));
  test('not JSON -> 400', async () => {
    const res = await post(userToken(A), '{nope', { raw: true });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'INVALID_JSON');
  });
  test('GET -> 405', async () => {
    const res = await fetch(rig.functionUrl, { method: 'GET', headers: { authorization: `Bearer ${userToken(A)}` } });
    assert.equal(res.status, 405);
    await res.text();
  });
  test('a body declared larger than 2048 bytes -> 413', async () => {
    const res = await post(userToken(A), req1({ customerReference: 'x'.repeat(3000) }));
    assert.equal(res.status, 413);
    assert.equal(res.json.error.code, 'PAYLOAD_TOO_LARGE');
  });
  test('after an owner removes a member, that member is turned away on the very next call', async () => {
    assert.equal((await post(userToken(B), req1())).status, 201);
    rig.sql(`delete from public.memberships where user_id = '${B}'`);
    const res = await post(userToken(B), req1());
    assert.equal(res.status, 403);
    rig.sql(`insert into public.memberships (organization_id, user_id, role) values ('${O1}', '${B}', 'staff')`); // restore
  });
});

describe('the browser still cannot write quotes itself', () => {
  test('a signed-in owner posting straight to the quotes table is refused by the database', async () => {
    const before = quoteCount();
    const res = await fetch(`${rig.restUrl}/quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${userToken(A)}`, apikey: 'x' },
      body: JSON.stringify({ organization_id: O1, zone_name: 'x', vehicle_type_name: 'x', service_date: '2026-10-09' }),
    });
    const body = await res.json();
    assert.equal(res.status, 403, JSON.stringify(body)); // 403 = the token was accepted but the role has no insert privilege
    assert.equal(body.code, '42501'); // Postgres "permission denied"
    assert.equal(quoteCount(), before);
  });
});

describe('browser rules (CORS) and secrets', () => {
  test('the preflight request is answered and allows the headers supabase-js sends', async () => {
    const res = await fetch(rig.functionUrl, { method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type, apikey, x-client-info' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const allowed = (res.headers.get('access-control-allow-headers') || '').toLowerCase();
    for (const h of ['authorization', 'content-type', 'apikey', 'x-client-info']) assert.ok(allowed.includes(h), `${h} missing from ${allowed}`);
    await res.text();
  });
  test('real responses carry the CORS header and are not cacheable', async () => {
    const res = await post(userToken(A), req1());
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-type'), /application\/json/);
  });
  test('the server key never appears in any response or in the function log', () => {
    const key = serviceRoleToken().split('.')[1]; // the payload part is enough to recognise it
    assert.ok(seen.length > 10);
    for (const text of seen) assert.ok(!text.includes(key) && !/service_role/.test(text), 'a response contained the server key');
    assert.ok(!rig.denoLog().includes(key));
  });
});

describe('many random quotes through the whole chain, checked by an independent calculation', () => {
  // Independent of surcharge.mjs: BigInt, written separately from the spec in README.
  const roundDiv = (n, d) => {
    const neg = n < 0n;
    const abs = neg ? -n : n;
    const q = (2n * abs + d) / (2n * d);
    return Number(neg ? -q : q);
  };
  const expected = ({ rate, base, cur, share, thr, floor }) => {
    const diff = BigInt(cur - base);
    const changeBp = roundDiv(10000n * diff, BigInt(base));
    const below = thr > 0 && (diff < 0n ? -diff : diff) * 10000n < BigInt(thr) * BigInt(base);
    let surchargeBp = below ? 0 : roundDiv(BigInt(share) * diff, BigInt(base));
    let reason = below ? 'BELOW_THRESHOLD' : 'APPLIED';
    if (floor && surchargeBp < 0) { surchargeBp = 0; reason = 'FLOORED_AT_ZERO'; }
    const surchargeCents = roundDiv(BigInt(rate) * BigInt(surchargeBp), 10000n);
    return { changeBp, surchargeBp, reason, surchargeCents, totalCents: rate + surchargeCents };
  };
  // A different way to find the Monday: count days from a known Monday (2024-01-01).
  const mondayOnOrBefore = (iso, lag) => {
    const day = Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000) - lag;
    const monday0 = Math.floor(Date.parse('2024-01-01T00:00:00Z') / 86400000);
    const m = day - (((day - monday0) % 7) + 7) % 7;
    return new Date(m * 86400000).toISOString().slice(0, 10);
  };
  function mulberry32(a) { return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  test('250 carriers with random settings, rates and prices: every saved number matches', async () => {
    const rand = mulberry32(20261009);
    const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
    // 120 Mondays of prices in 2030
    const prices = new Map();
    for (let i = 0; i < 120; i++) {
      const d = new Date(Date.parse('2030-01-07T00:00:00Z') + i * 7 * 86400000).toISOString().slice(0, 10);
      if (rand() < 0.1) continue; // leave about one Monday in ten without a price, to exercise the refusal
      prices.set(d, int(80000, 260000));
    }
    const F = 'f0000000-0000-4000-8000-00000000000f';
    const cases = [];
    let script = `insert into auth.users (id) values ('${F}');\n`;
    script += `insert into public.fuel_prices (monday, price_cents) values ${[...prices].map(([d, p]) => `('${d}', ${p})`).join(', ')};\n`;
    for (let i = 0; i < 250; i++) {
      const o = `e${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`;
      const z = `e${String(i).padStart(7, '0')}-0000-4000-8000-00000000000a`;
      const v = `e${String(i).padStart(7, '0')}-0000-4000-8000-00000000000b`;
      const c = {
        o, z, v,
        base: int(80000, 260000), share: int(0, 10000), lag: int(0, 14),
        thr: rand() < 0.5 ? 0 : int(1, 3000), floor: rand() < 0.3, rate: int(0, 9_000_000),
        service: new Date(Date.parse('2030-01-28T00:00:00Z') + int(0, 700) * 86400000).toISOString().slice(0, 10),
      };
      cases.push(c);
      script += `insert into public.organizations (id, name) values ('${o}', 'org ${i}');
        insert into public.memberships (organization_id, user_id, role) values ('${o}', '${F}', 'staff');
        insert into public.surcharge_settings (organization_id, fuel_share_bp, lag_days, threshold_bp, floor_at_zero, base_diesel_cents)
          values ('${o}', ${c.share}, ${c.lag}, ${c.thr}, ${c.floor}, ${c.base});
        insert into public.zones (id, organization_id, name) values ('${z}', '${o}', 'Z${i}');
        insert into public.vehicle_types (id, organization_id, name) values ('${v}', '${o}', 'V${i}');
        insert into public.rates (organization_id, zone_id, vehicle_type_id, base_rate_cents) values ('${o}', '${z}', '${v}', ${c.rate});\n`;
    }
    rig.sql(script);

    let checked = 0;
    let refusedForMissingPrice = 0;
    for (const c of cases) {
      const monday = mondayOnOrBefore(c.service, c.lag);
      const res = await post(userToken(F), { organizationId: c.o, zoneId: c.z, vehicleTypeId: c.v, serviceDate: c.service });
      if (!prices.has(monday)) {
        assert.equal(res.status, 409, `${c.service} lag ${c.lag} -> ${monday}: ${res.text}`);
        refusedForMissingPrice++;
        continue;
      }
      assert.equal(res.status, 201, res.text);
      const want = expected({ rate: c.rate, base: c.base, cur: prices.get(monday), share: c.share, thr: c.thr, floor: c.floor });
      const got = res.json.quote;
      assert.equal(got.referenceMonday, monday);
      assert.deepEqual(
        { changeBp: got.changeBp, surchargeBp: got.surchargeBp, reason: got.reason, surchargeCents: got.surchargeCents, totalCents: got.totalCents },
        want,
        JSON.stringify(c),
      );
      checked++;
    }
    const stored = Number(rig.sql(`select count(*) from public.quotes where created_by = '${F}'`)[0][0]);
    assert.equal(stored, checked);
    assert.ok(checked >= 150 && refusedForMissingPrice >= 5, `checked ${checked}, refused ${refusedForMissingPrice}`);
    console.log(`      ${checked} quotes checked and saved, ${refusedForMissingPrice} correctly refused for a missing price`);
  });
});
