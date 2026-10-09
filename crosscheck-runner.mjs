// crosscheck-runner.mjs
// Reads a JSON array of cases on stdin, runs them through surcharge.mjs, writes JSON results.
// Used only by crosscheck.py, which recomputes every case independently.

import { computeSurcharge, mulDivRound, referenceMonday } from './surcharge.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;

const results = JSON.parse(input).map((c) => {
  if (c.kind === 'monday') {
    return { referenceDate: referenceMonday(c.serviceDate, c.lagDays) };
  }
  const r = computeSurcharge({
    baseCents: c.baseCents,
    currentCents: c.currentCents,
    fuelShareBp: c.fuelShareBp,
    thresholdBp: c.thresholdBp,
    floorAtZero: c.floorAtZero,
  });
  const surchargeCents = mulDivRound(c.rateCents, r.surchargeBp, 10000);
  return { ...r, surchargeCents, totalCents: c.rateCents + surchargeCents };
});

process.stdout.write(JSON.stringify(results));
