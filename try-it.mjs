// try-it.mjs
// A playground for surcharge.mjs. Nothing here is part of the real product.
//
// 1. Change the numbers in the YOUR INPUTS block below (they are made-up examples).
// 2. Save the file.
// 3. In the terminal, in this folder, run:   node try-it.mjs

import { quote, toCents, formatBp, formatEuroCents, SurchargeError } from './surcharge.mjs';

// ------------------------------------------------------------------ YOUR INPUTS
const rateEuros = 1000.0; //          transport price before fuel surcharge, in euros
const baseDieselPer1000L = 1500.0; // diesel price when the contract started, euros per 1000 litres
const fuelSharePercent = 20; //       how much of the rate follows diesel, in percent
const serviceDate = '2026-10-09'; //  date of the transport, written YYYY-MM-DD
const thresholdPercent = 0; //        0 = always apply. 5 = only apply if diesel moved at least 5 %
const onlyIncreases = false; //       true = never give a credit when diesel falls

const mondayPrices = {
  // diesel price on each Monday, euros per 1000 litres (made-up numbers)
  '2026-09-21': 1480.0,
  '2026-09-28': 1650.0,
  '2026-10-05': 1900.0,
};
// ----------------------------------------------------------------------------

const REASONS = {
  APPLIED: 'applied',
  BELOW_THRESHOLD: 'NOT applied: diesel moved less than the threshold',
  FLOORED_AT_ZERO: 'NOT applied: diesel fell and "only increases" is on',
};

try {
  const prices = Object.fromEntries(
    Object.entries(mondayPrices).map(([monday, euros]) => [monday, toCents(euros)]),
  );
  const q = quote({
    rateCents: toCents(rateEuros),
    prices,
    baseCents: toCents(baseDieselPer1000L),
    serviceDate,
    fuelShareBp: toCents(fuelSharePercent), // 20 % -> 2000 (same "at most 2 decimals" rule)
    thresholdBp: toCents(thresholdPercent),
    floorAtZero: onlyIncreases,
  });

  const signed = (bp) => (bp > 0 ? '+' : '') + formatBp(bp);
  const row = (label, value) => console.log(label.padEnd(24) + value);

  console.log('');
  row('Service date', serviceDate);
  row('Diesel price used', `Monday ${q.referenceDate}: ${formatEuroCents(q.currentCents)} per 1000 L`);
  row('Diesel price at start', `${formatEuroCents(q.baseCents)} per 1000 L`);
  row('Diesel price change', signed(q.changeBp));
  row('Fuel surcharge', `${signed(q.surchargeBp)}  (${REASONS[q.reason]})`);
  console.log('');
  row('Transport rate', formatEuroCents(q.rateCents));
  row('Surcharge amount', formatEuroCents(q.surchargeCents));
  row('TOTAL', formatEuroCents(q.totalCents));
  console.log('');
} catch (error) {
  if (error instanceof SurchargeError) {
    console.log(`\nNo quote was produced: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
