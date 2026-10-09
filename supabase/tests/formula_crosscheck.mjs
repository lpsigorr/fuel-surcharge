// formula_crosscheck.mjs
// LOCAL TESTING ONLY. Run by run-local.sh against the throwaway database.
//
// Computes quotes with the Step 1 engine (surcharge.mjs) and sends them to the database's own copy of
// the formula (private.quote_numbers_ok and private.reference_monday). Checks that:
//   1. every correct quote is accepted by the database
//   2. every deliberately altered quote is rejected by the database
//   3. every reference Monday matches
// Connection settings come from the PG* environment variables that run-local.sh sets.

import { spawnSync } from 'node:child_process';
import { computeSurcharge, mulDivRound, referenceMonday } from '../../surcharge.mjs';

const SEED = 20261009;
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (list) => list[int(0, list.length - 1)];

// ---- inputs, in the same four families as crosscheck.py
const inputs = [];
const add = (base, cur, share, thr, floor, rate) => inputs.push({ base, cur, share, thr, floor, rate });
for (let i = 0; i < 12000; i++) {
  const base = int(50000, 400000);
  const cur = Math.max(1, Math.round(base * (0.6 + 0.8 * rand())));
  add(base, cur, int(0, 10000), rand() < 0.5 ? 0 : int(1, 3000), rand() < 0.3, int(0, 10_000_000));
}
for (let i = 0; i < 6000; i++) {
  add(int(2, 400), int(1, 800), pick([500, 1000, 1250, 2000, 2500, 5000, int(0, 10000)]), 0, rand() < 0.3, int(0, 5000));
}
for (let i = 0; i < 3000; i++) {
  const k = int(5, 30);
  const base = 10000 * k;
  add(base, base + pick([-1, 1]) * 500 * k + pick([-2, -1, 0, 1, 2]), int(0, 10000), 500, false, int(0, 1_000_000));
}
for (let i = 0; i < 2000; i++) {
  const bp = pick([50, 100, 150, 250, 500]);
  const diff = Math.floor((bp * 150000) / 2000);
  add(150000, 150000 + pick([-1, 1]) * diff, 2000, 0, false, int(0, 2000));
}

// ---- results from the Step 1 engine
const rows = inputs.map((c) => {
  const r = computeSurcharge({ baseCents: c.base, currentCents: c.cur, fuelShareBp: c.share, thresholdBp: c.thr, floorAtZero: c.floor });
  const surchargeCents = mulDivRound(c.rate, r.surchargeBp, 10000);
  return {
    ...c,
    change_bp: r.changeBp,
    surcharge_bp: r.surchargeBp,
    reason: r.reason,
    surcharge_cents: surchargeCents,
    total_cents: c.rate + surchargeCents,
  };
});

const REASONS = ['APPLIED', 'BELOW_THRESHOLD', 'FLOORED_AT_ZERO'];
const MUTATIONS = [
  ['total +1 cent', (r) => ({ ...r, total_cents: r.total_cents + 1 })],
  ['surcharge amount +1 cent (total adjusted)', (r) => ({ ...r, surcharge_cents: r.surcharge_cents + 1, total_cents: r.total_cents + 1 })],
  ['surcharge % +0.01 (amounts adjusted)', (r) => {
    const bp = r.surcharge_bp + 1;
    const cents = mulDivRound(r.rate, bp, 10000);
    return { ...r, surcharge_bp: bp, surcharge_cents: cents, total_cents: r.rate + cents };
  }],
  ['surcharge % -0.01 (amounts adjusted)', (r) => {
    const bp = r.surcharge_bp - 1;
    const cents = mulDivRound(r.rate, bp, 10000);
    return { ...r, surcharge_bp: bp, surcharge_cents: cents, total_cents: r.rate + cents };
  }],
  ['diesel change % +0.01', (r) => ({ ...r, change_bp: r.change_bp + 1 })],
  ['wrong reason', (r) => ({ ...r, reason: REASONS[(REASONS.indexOf(r.reason) + 1) % 3] })],
];

const payload = [
  ...rows.map((r) => ({ group: 'correct', ...r })),
  ...rows.map((r, i) => {
    const [name, mutate] = MUTATIONS[i % MUTATIONS.length];
    return { group: name, ...mutate(r) };
  }),
];

// ---- reference Mondays
const dates = [];
for (let i = 0; i < 6000; i++) {
  const d = new Date(Date.UTC(2020, 0, 1) + int(0, 5843) * 86_400_000).toISOString().slice(0, 10);
  const lag = int(0, 14);
  dates.push({ d, lag, expected: referenceMonday(d, lag) });
}

function psql(sql) {
  const out = spawnSync('psql', ['-X', '-q', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1'], {
    input: sql, encoding: 'utf8', maxBuffer: 1 << 30,
  });
  if (out.status !== 0) {
    console.error(out.stderr);
    process.exit(2);
  }
  return out.stdout.trim().split('\n').filter(Boolean).map((l) => l.split('|'));
}

const quoteRows = psql(`
  with r as (
    select * from jsonb_to_recordset($j$${JSON.stringify(payload)}$j$::jsonb)
      as x("group" text, rate int, base int, cur int, share int, thr int, floor boolean,
           change_bp int, surcharge_bp int, reason text, surcharge_cents int, total_cents int))
  select "group", count(*),
         count(*) filter (where private.quote_numbers_ok(rate, base, cur, share, thr, floor,
                                  change_bp, surcharge_bp, reason, surcharge_cents, total_cents))
  from r group by "group" order by "group" = 'correct' desc, "group"`);

const dateRows = psql(`
  with r as (
    select * from jsonb_to_recordset($j$${JSON.stringify(dates)}$j$::jsonb)
      as x(d date, lag int, expected date))
  select count(*), count(*) filter (where private.reference_monday(d, lag) = expected) from r`);

let failed = 0;
console.log(`seed ${SEED}`);
for (const [group, n, accepted] of quoteRows) {
  const isCorrect = group === 'correct';
  const good = isCorrect ? accepted === n : accepted === '0';
  if (!good) failed++;
  console.log(
    `${good ? 'OK  ' : 'FAIL'} ${isCorrect ? 'correct quotes' : 'altered: ' + group}`.padEnd(58) +
      `sent ${n.padStart(6)}   ${isCorrect ? 'accepted' : 'accepted'} ${accepted.padStart(6)}   ` +
      `${isCorrect ? '(all should be accepted)' : '(none should be accepted)'}`,
  );
}
const [dn, dm] = dateRows[0];
if (dn !== dm) failed++;
console.log(`${dn === dm ? 'OK  ' : 'FAIL'} reference Mondays`.padEnd(58) + `sent ${dn.padStart(6)}   matching ${dm.padStart(5)}   (all should match)`);
console.log(`RESULT: ${failed === 0 ? 'ALL MATCH' : 'MISMATCH'}`);
process.exit(failed === 0 ? 0 : 1);
