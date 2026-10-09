// entry_crosscheck.mjs
// LOCAL TESTING ONLY. Run by run-entry-local.sh against the throwaway database, after the Step 4 SQL tests.
//
// For thousands of (stored price, new price) pairs it asks the database function to publish the new price
// one week after the stored one, and compares the answer with an independent calculation:
//   - the change in basis points, rounded half away from zero, by the Step 1 engine (mulDivRound, BigInt inside)
//   - "more than 5 %" decided with BigInt cross-multiplication: |difference| x 20 > stored price
//   - the exact sentence the refusal must contain
// Each pair is tried twice: without a confirmation (a big move must be refused) and with accept_big_move
// (it must be created, flagged as a big move). Everything is undone after each try.
// Connection settings come from the PG* environment variables that run-entry-local.sh sets.

import { spawnSync } from 'node:child_process';
import { mulDivRound } from '../../surcharge.mjs';

const SEED = 20261010;
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
const MIN = 50000;
const MAX = 500000;
const clamp = (n) => Math.min(MAX, Math.max(MIN, n));

// ---- the pairs, in three families
const pairs = [];
const add = (family, oldC, newC) => pairs.push({ family, old: oldC, new: clamp(newC) });

for (let i = 0; i < 6000; i++) {                       // 1. anywhere in the allowed range, moves of up to +-15 %
  const o = int(MIN, MAX);
  add('random', o, Math.round(o * (0.85 + 0.3 * rand())));
}
for (let i = 0; i < 3000; i++) {                       // 2. right at the 5 % line (and one hundredth either side)
  const o = i % 2 === 0 ? 20 * int(MIN / 20, MAX / 20) : int(MIN, MAX);
  const d = pick([Math.floor(o / 20), Math.ceil(o / 20)]) + pick([-1, 0, 1]);
  add('line', o, o + pick([-1, 1]) * d);
}
for (let i = 0; i < 1500; i++) {                       // 3. exact rounding ties: stored 20000 q, difference q x odd -> exactly n.5 bp
  const q = int(3, 25);
  const odd = 2 * int(0, 20) + 1;
  add('tie', 20000 * q, 20000 * q + pick([-1, 1]) * q * odd);
}
pairs.forEach((p, i) => { p.i = i; });

const text = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

// ---- send to the database
const psql = (args, input) => {
  const r = spawnSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', ...args], {
    input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, PATH: `${process.env.PGBIN ? process.env.PGBIN + ':' : ''}${process.env.PATH}` },
  });
  if (r.status !== 0) { console.error(r.stderr); process.exit(2); }
  return r.stdout;
};

let sql = 'drop table if exists t.cc_in; drop table if exists t.cc_out;\n';
sql += 'create table t.cc_in (i int primary key, old_cents int, new_text text);\n';
for (let k = 0; k < pairs.length; k += 1000) {
  const chunk = pairs.slice(k, k + 1000).map((p) => `(${p.i}, ${p.old}, '${text(p.new)}')`).join(',');
  sql += `insert into t.cc_in values ${chunk};\n`;
}
sql += `
create table t.cc_out (i int primary key, r1 jsonb, r2 jsonb);
do $$
declare x record; r1 jsonb; r2 jsonb;
begin
  for x in select * from t.cc_in order by i loop
    perform t.reset_prices();
    insert into public.fuel_prices (monday, price_cents) values ('2025-06-02', x.old_cents);
    perform t.as_user(t.id('EP'));
    r1 := t.pub_rb('2025-06-09', x.new_text);
    r2 := t.pub_rb('2025-06-09', x.new_text, false, true);
    perform t.back();
    insert into t.cc_out values (x.i, r1, r2);
  end loop;
  perform t.reset_prices();
end $$;
`;
psql([], sql);
const out = psql(['-F', '\u001f', '-c', 'select i, r1::text, r2::text from t.cc_out order by i']);

// ---- compare
const answers = new Map();
for (const line of out.split('\n').filter(Boolean)) {
  const [i, r1, r2] = line.split('\u001f');
  answers.set(Number(i), { r1: JSON.parse(r1), r2: JSON.parse(r2) });
}

let mismatches = 0;
const shown = [];
const bad = (p, why) => { mismatches++; if (shown.length < 10) shown.push(`${p.family} old=${p.old} new=${p.new}: ${why}`); };
const counts = { big: 0, onLine: 0, ties: 0, same: 0 };
// jsonb does not keep the order of keys, so compare field by field
const sameCmp = (got, want) => got && got.monday === want.monday && got.price_cents === want.price_cents && got.change_bp === want.change_bp;

for (const p of pairs) {
  const a = answers.get(p.i);
  if (!a) { bad(p, 'no answer from the database'); continue; }
  const delta = p.new - p.old;
  const changeBp = mulDivRound(delta, 10000, p.old);                    // Step 1 engine, half away from zero
  const abs = delta < 0 ? -delta : delta;
  const big = BigInt(abs) * 20n > BigInt(p.old);                        // more than 5 %, exact
  if (big) counts.big++;
  if (BigInt(abs) * 20n === BigInt(p.old)) counts.onLine++;
  if (BigInt(abs) * 10000n * 2n % BigInt(p.old) === 0n && (BigInt(abs) * 10000n * 2n / BigInt(p.old)) % 2n === 1n) counts.ties++;
  if (delta === 0) counts.same++;

  const cmp = { monday: '2025-06-02', price_cents: p.old, change_bp: changeBp };

  // without a confirmation
  if (big) {
    const sentence = `${text(p.new)} is ${changeBp >= 0 ? '+' : '-'}${text(Math.abs(changeBp))} % compared with ${text(p.old)} on 2025-06-02. The limit is 5 %.`;
    if (a.r1.ok !== false || a.r1.sqlstate !== 'PT409' || a.r1.message !== 'BIG_MOVE') bad(p, `expected BIG_MOVE, got ${JSON.stringify(a.r1)}`);
    else if (a.r1.detail !== sentence) bad(p, `wrong sentence: ${a.r1.detail} (expected: ${sentence})`);
  } else {
    const res = a.r1.result;
    if (a.r1.ok !== true || res.status !== 'created' || res.price_cents !== p.new || res.big_move_accepted !== false
        || !sameCmp(res.compared_with, cmp)) bad(p, `expected created with ${JSON.stringify(cmp)}, got ${JSON.stringify(a.r1)}`);
  }
  // with accept_big_move: always created, flagged exactly when it was a big move
  const res2 = a.r2.result;
  if (a.r2.ok !== true || res2.status !== 'created' || res2.price_cents !== p.new || res2.big_move_accepted !== big
      || !sameCmp(res2.compared_with, cmp)) bad(p, `with accept_big_move: expected created, big=${big}, ${JSON.stringify(cmp)}; got ${JSON.stringify(a.r2)}`);
}

console.log(`${pairs.length} price pairs checked (${pairs.length * 2} calls): ${counts.big} over 5 %, ${counts.onLine} exactly on the 5 % line, ${counts.ties} exact rounding ties, ${counts.same} unchanged prices.`);
console.log(`Mismatches between the database and the independent calculation: ${mismatches}`);
if (mismatches) { console.log(shown.join('\n')); process.exit(1); }
