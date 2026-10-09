// surcharge.test.mjs
// Run: npm test   (node --test)
//
// Every expected value below can be reproduced by hand; the arithmetic is in the comments.
// Data is labelled REAL (from an opened public source) or ILLUSTRATIVE (made up round numbers).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SurchargeError,
  toCents,
  divRound,
  mulDivRound,
  referenceMonday,
  pickPrice,
  computeSurcharge,
  quote,
  formatBp,
  formatEuroCents,
} from './surcharge.mjs';

const throwsCode = (fn, code) =>
  assert.throws(fn, (e) => e instanceof SurchargeError && e.code === code);

describe('toCents (input boundary)', () => {
  const ok = [
    [1712.5, 171250],
    [1244.6, 124460],
    [1534.7, 153470],
    [0.07, 7],
    [0, 0],
    [-16.4, -1640],
  ];
  for (const [euros, cents] of ok) {
    it(`${euros} -> ${cents}`, () => assert.equal(toCents(euros), cents));
  }
  it('normalises negative zero', () => assert.ok(Object.is(toCents(-0), 0)));
  for (const bad of [1.005, 1712.505, NaN, Infinity, '12.50', null, undefined, 1e15]) {
    it(`rejects ${String(bad)}`, () => throwsCode(() => toCents(bad), 'INVALID_INPUT'));
  }
});

describe('divRound (half away from zero)', () => {
  const table = [
    [0, 5, 0],
    [1, 2, 1], //  0.5 -> 1
    [-1, 2, -1], // -0.5 -> -1
    [3, 2, 2], //  1.5 -> 2
    [-3, 2, -2], // -1.5 -> -2
    [5, 10, 1],
    [-5, 10, -1],
    [4, 10, 0], //  0.4 -> 0
    [-4, 10, 0], // -0.4 -> 0, and never -0
    [7, 3, 2], //  2.33 -> 2
    [8, 3, 3], //  2.67 -> 3
    [-7, 3, -2],
    [-8, 3, -3],
    [1, 3, 0],
    [10, 5, 2],
  ];
  for (const [n, d, expected] of table) {
    it(`${n} / ${d} -> ${expected}`, () => assert.equal(divRound(n, d), expected));
  }
  it('is exact beyond 2^53 intermediates (a x b / b = a)', () => {
    const big = Number.MAX_SAFE_INTEGER;
    assert.equal(mulDivRound(big, big, big), big);
  });
  it('refuses a result that does not fit', () =>
    throwsCode(() => mulDivRound(1e8, 1e8, 1), 'RESULT_TOO_LARGE'));
  for (const d of [0, -3, 1.5]) {
    it(`rejects denominator ${d}`, () => throwsCode(() => divRound(1, d), 'INVALID_INPUT'));
  }
  it('rejects non-integer numerator', () => throwsCode(() => divRound(1.5, 2), 'INVALID_INPUT'));
});

describe('referenceMonday', () => {
  // [serviceDate, lagDays, expected, why]
  const table = [
    ['2026-10-09', 7, '2026-09-28', 'Fri 9 Oct - 7 = Fri 2 Oct -> Mon 28 Sep'],
    ['2026-10-11', 7, '2026-09-28', 'Sun 11 Oct - 7 = Sun 4 Oct -> Mon 28 Sep'],
    ['2026-10-12', 7, '2026-10-05', 'Mon 12 Oct - 7 = Mon 5 Oct -> itself'],
    ['2026-10-05', 0, '2026-10-05', 'a Monday with no lag is itself'],
    ['2026-10-11', 0, '2026-10-05', 'Sunday -> the Monday six days earlier'],
    ['2026-10-04', 0, '2026-09-28', 'Sunday 4 Oct -> Mon 28 Sep'],
    ['2026-01-05', 7, '2025-12-29', 'year boundary: Mon 5 Jan - 7 = Mon 29 Dec'],
    ['2026-01-01', 7, '2025-12-22', 'year boundary: Thu 1 Jan - 7 = Thu 25 Dec -> Mon 22 Dec'],
    ['2024-03-04', 7, '2024-02-26', 'leap year: Mon 4 Mar - 7 = Mon 26 Feb'],
    ['2024-03-03', 7, '2024-02-19', 'leap year: Sun 3 Mar - 7 = Sun 25 Feb -> Mon 19 Feb'],
    ['2024-02-29', 0, '2024-02-26', 'leap day itself is a Thursday'],
  ];
  for (const [date, lag, expected, why] of table) {
    it(`${date} lag ${lag} -> ${expected} (${why})`, () =>
      assert.equal(referenceMonday(date, lag), expected));
  }
  it('default lag is 7 days', () =>
    assert.equal(referenceMonday('2026-10-09'), referenceMonday('2026-10-09', 7)));
  for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-10-00', '2026-10-9', '10/09/2026', '', null, 20261009]) {
    it(`rejects date ${JSON.stringify(bad)}`, () =>
      throwsCode(() => referenceMonday(bad, 7), 'INVALID_DATE'));
  }
  for (const bad of [-1, 1.5, '7']) {
    it(`rejects lag ${JSON.stringify(bad)}`, () =>
      throwsCode(() => referenceMonday('2026-10-09', bad), 'INVALID_INPUT'));
  }
});

describe('pickPrice', () => {
  const prices = { '2026-09-28': 165000 };
  it('returns the price for an exact Monday', () => assert.equal(pickPrice(prices, '2026-09-28'), 165000));
  it('missing Monday is an error, never a guess', () =>
    throwsCode(() => pickPrice(prices, '2026-10-05'), 'MISSING_PRICE'));
  it('inherited object keys do not count as prices', () =>
    throwsCode(() => pickPrice(prices, 'toString'), 'MISSING_PRICE'));
  for (const bad of [0, -5, 1.5, '1500']) {
    it(`rejects stored price ${JSON.stringify(bad)}`, () =>
      throwsCode(() => pickPrice({ '2026-09-28': bad }, '2026-09-28'), 'INVALID_INPUT'));
  }
  it('rejects a non-object price table', () => throwsCode(() => pickPrice(null, '2026-09-28'), 'INVALID_INPUT'));
});

describe('computeSurcharge', () => {
  it('W1 REAL: reproduces Febetra 2022 (1.2446 -> 1.5347 EUR/L, +23.31 %, 4.92 %)', () => {
    // Prices are the published excl-VAT figures per litre, written per 1000 L in hundredths:
    //   base 1.2446 EUR/L = 1244.60 per 1000 L = 124460
    //   now  1.5347 EUR/L = 1534.70 per 1000 L = 153470      diff = 29010
    // change    = 29010 / 124460                         = 23.309 %  -> 2331 bp  (published: 23.31 %)
    // surcharge = 2110 bp x 29010 / 124460 = 491.81 bp   -> 492 bp   (published: 4.92 %)
    // 2110 bp (21.1 %) is the share that back-solves to 4.92 %; Febetra states "about 20 %".
    const r = computeSurcharge({ baseCents: 124460, currentCents: 153470, fuelShareBp: 2110 });
    assert.deepEqual(r, { changeBp: 2331, surchargeBp: 492, reason: 'APPLIED' });
  });

  it('W2 ILLUSTRATIVE: +10.00 % diesel with 20 % share is +2.00 %', () => {
    // base 1500.00, now 1650.00 per 1000 L: diff 15000 / 150000 = 10 %; 20 % x 10 % = 2 %
    const r = computeSurcharge({ baseCents: 150000, currentCents: 165000, fuelShareBp: 2000 });
    assert.deepEqual(r, { changeBp: 1000, surchargeBp: 200, reason: 'APPLIED' });
  });

  it('W3 ILLUSTRATIVE: symmetric by default, a fall gives a negative surcharge', () => {
    // base 1500.00, now 1350.00: -10 %; 20 % x -10 % = -2 %
    const r = computeSurcharge({ baseCents: 150000, currentCents: 135000, fuelShareBp: 2000 });
    assert.deepEqual(r, { changeBp: -1000, surchargeBp: -200, reason: 'APPLIED' });
  });

  it('floorAtZero turns a negative surcharge into 0 and says so', () => {
    const r = computeSurcharge({ baseCents: 150000, currentCents: 135000, fuelShareBp: 2000, floorAtZero: true });
    assert.deepEqual(r, { changeBp: -1000, surchargeBp: 0, reason: 'FLOORED_AT_ZERO' });
  });

  it('floorAtZero does not touch a positive surcharge', () => {
    const r = computeSurcharge({ baseCents: 150000, currentCents: 165000, fuelShareBp: 2000, floorAtZero: true });
    assert.equal(r.surchargeBp, 200);
    assert.equal(r.reason, 'APPLIED');
  });

  it('no price change gives 0', () => {
    const r = computeSurcharge({ baseCents: 150000, currentCents: 150000, fuelShareBp: 2000 });
    assert.deepEqual(r, { changeBp: 0, surchargeBp: 0, reason: 'APPLIED' });
  });

  it('share 0 gives 0 and share 100 % passes the full change through', () => {
    const none = computeSurcharge({ baseCents: 150000, currentCents: 165000, fuelShareBp: 0 });
    const full = computeSurcharge({ baseCents: 150000, currentCents: 165000, fuelShareBp: 10000 });
    assert.equal(none.surchargeBp, 0);
    assert.equal(full.surchargeBp, full.changeBp);
  });

  describe('ties round away from zero', () => {
    // base 200000, share 2500: surchargeBp = 2500 x diff / 200000 = diff / 80
    it('diff +40 -> 0.5 -> 1', () =>
      assert.equal(computeSurcharge({ baseCents: 200000, currentCents: 200040, fuelShareBp: 2500 }).surchargeBp, 1));
    it('diff -40 -> -0.5 -> -1', () =>
      assert.equal(computeSurcharge({ baseCents: 200000, currentCents: 199960, fuelShareBp: 2500 }).surchargeBp, -1));
    it('diff +39 -> 0.4875 -> 0', () =>
      assert.equal(computeSurcharge({ baseCents: 200000, currentCents: 200039, fuelShareBp: 2500 }).surchargeBp, 0));
  });

  describe('threshold (5.00 % = 500 bp), cliff semantics, exact comparison', () => {
    // base 150000: 5.00 % is exactly 7500
    const run = (currentCents) =>
      computeSurcharge({ baseCents: 150000, currentCents, fuelShareBp: 2000, thresholdBp: 500 });
    it('exactly +5.00 % applies to the whole change', () =>
      assert.deepEqual(run(157500), { changeBp: 500, surchargeBp: 100, reason: 'APPLIED' }));
    it('exactly -5.00 % applies', () =>
      assert.deepEqual(run(142500), { changeBp: -500, surchargeBp: -100, reason: 'APPLIED' }));
    it('+4.9993 % is below, although it displays as 5.00 %', () =>
      // 7499 / 150000 = 4.9993 %, changeBp rounds to 500 but the exact test says below
      assert.deepEqual(run(157499), { changeBp: 500, surchargeBp: 0, reason: 'BELOW_THRESHOLD' }));
    it('-4.9993 % is below', () =>
      assert.deepEqual(run(142501), { changeBp: -500, surchargeBp: 0, reason: 'BELOW_THRESHOLD' }));
    it('threshold 0 means always apply', () =>
      assert.equal(computeSurcharge({ baseCents: 150000, currentCents: 150001, fuelShareBp: 2000, thresholdBp: 0 }).reason, 'APPLIED'));
  });

  describe('input validation', () => {
    const good = { baseCents: 150000, currentCents: 165000, fuelShareBp: 2000 };
    const cases = [
      ['baseCents 0', { baseCents: 0 }],
      ['baseCents negative', { baseCents: -1 }],
      ['baseCents fractional', { baseCents: 1500.5 }],
      ['currentCents 0', { currentCents: 0 }],
      ['currentCents string', { currentCents: '165000' }],
      ['fuelShareBp above 100 %', { fuelShareBp: 10001 }],
      ['fuelShareBp negative', { fuelShareBp: -1 }],
      ['fuelShareBp fractional', { fuelShareBp: 20.5 }],
      ['thresholdBp negative', { thresholdBp: -1 }],
      ['floorAtZero not boolean', { floorAtZero: 'yes' }],
    ];
    for (const [name, override] of cases) {
      it(`rejects ${name}`, () =>
        throwsCode(() => computeSurcharge({ ...good, ...override }), 'INVALID_INPUT'));
    }
  });
});

describe('quote', () => {
  // ILLUSTRATIVE Monday prices, hundredths of EUR per 1000 L
  const PRICES = {
    '2026-09-21': 148000, // 1480.00
    '2026-09-28': 165000, // 1650.00
    '2026-10-05': 190000, // 1900.00
  };
  const base = { rateCents: 100000, prices: PRICES, baseCents: 150000, fuelShareBp: 2000 };

  it('W4: service Fri 2026-10-09 uses Monday 2026-09-28 and never the later 2026-10-05', () => {
    // 165000 vs base 150000: +10.00 %, surcharge 2.00 %; EUR 1000.00 x 2 % = EUR 20.00
    const r = quote({ ...base, serviceDate: '2026-10-09' });
    assert.deepEqual(r, {
      referenceDate: '2026-09-28',
      baseCents: 150000,
      currentCents: 165000,
      changeBp: 1000,
      surchargeBp: 200,
      reason: 'APPLIED',
      rateCents: 100000,
      surchargeCents: 2000,
      totalCents: 102000,
    });
  });

  it('W5: service Mon 2026-10-12 uses Monday 2026-10-05', () => {
    // 190000 vs 150000: diff 40000. change 26.67 % -> 2667 bp. surcharge 2000 x 40000 / 150000 = 533.33 -> 533 bp.
    // EUR 1000.00 x 5.33 % = EUR 53.30
    const r = quote({ ...base, serviceDate: '2026-10-12' });
    assert.equal(r.referenceDate, '2026-10-05');
    assert.equal(r.changeBp, 2667);
    assert.equal(r.surchargeBp, 533);
    assert.equal(r.surchargeCents, 5330);
    assert.equal(r.totalCents, 105330);
  });

  it('W6: a fall gives a credit', () => {
    // service Wed 2026-09-30 - 7 = Wed 09-23 -> Mon 2026-09-21 = 148000; diff -2000.
    // change -1.33 % -> -133 bp. surcharge 2000 x -2000 / 150000 = -26.67 -> -27 bp.
    // EUR 1000.00 x -0.27 % = -EUR 2.70
    const r = quote({ ...base, serviceDate: '2026-09-30' });
    assert.equal(r.referenceDate, '2026-09-21');
    assert.equal(r.changeBp, -133);
    assert.equal(r.surchargeBp, -27);
    assert.equal(r.surchargeCents, -270);
    assert.equal(r.totalCents, 99730);
  });

  it('W7: with floorAtZero the same fall costs the customer nothing extra and gives no credit', () => {
    const r = quote({ ...base, serviceDate: '2026-09-30', floorAtZero: true });
    assert.equal(r.surchargeCents, 0);
    assert.equal(r.totalCents, 100000);
    assert.equal(r.reason, 'FLOORED_AT_ZERO');
  });

  it('missing Monday price refuses to quote', () =>
    // service 2026-10-19 - 7 = 2026-10-12 (Monday), which has no price
    throwsCode(() => quote({ ...base, serviceDate: '2026-10-19' }), 'MISSING_PRICE'));

  it('below threshold the surcharge is 0 and the total is the rate', () => {
    // 165000 vs 150000 = +10 %, threshold 15 % not met
    const r = quote({ ...base, serviceDate: '2026-10-09', thresholdBp: 1500 });
    assert.equal(r.reason, 'BELOW_THRESHOLD');
    assert.equal(r.surchargeCents, 0);
    assert.equal(r.totalCents, 100000);
  });

  it('W8 REAL price levels (Febetra 2022), rate EUR 333.33: rounding to the cent', () => {
    // Dates are synthetic; only the two price levels are from the Febetra page. surcharge 492 bp.
    // 33333 x 492 / 10000 = 16399836 / 10000 = 1639.98 -> 1640 cents. total 33333 + 1640 = 34973.
    const r = quote({
      rateCents: 33333,
      prices: { '2026-09-28': 153470 },
      baseCents: 124460,
      serviceDate: '2026-10-09',
      fuelShareBp: 2110,
    });
    assert.equal(r.surchargeBp, 492);
    assert.equal(r.surchargeCents, 1640);
    assert.equal(r.totalCents, 34973);
    assert.equal(mulDivRound(33333, -492, 10000), -1640); // mirror image
  });

  it('a tie in euro cents rounds away from zero (EUR 0.50 x 1.00 % = 0.5 cent)', () => {
    const up = quote({ ...base, rateCents: 50, prices: { '2026-09-28': 157500 }, serviceDate: '2026-10-09' });
    assert.equal(up.surchargeBp, 100);
    assert.equal(up.surchargeCents, 1);
    const down = quote({ ...base, rateCents: 50, prices: { '2026-09-28': 142500 }, serviceDate: '2026-10-09' });
    assert.equal(down.surchargeBp, -100);
    assert.equal(down.surchargeCents, -1);
  });

  it('total can never go below zero (100 % share, price collapses)', () => {
    const r = quote({ ...base, prices: { '2026-09-28': 1 }, fuelShareBp: 10000, serviceDate: '2026-10-09' });
    assert.equal(r.surchargeBp, -10000);
    assert.equal(r.totalCents, 0);
  });

  it('total always equals rate + surcharge', () => {
    for (const serviceDate of ['2026-09-30', '2026-10-09', '2026-10-12']) {
      const r = quote({ ...base, serviceDate });
      assert.equal(r.totalCents, r.rateCents + r.surchargeCents);
    }
  });

  it('rejects a negative rate', () =>
    throwsCode(() => quote({ ...base, rateCents: -1, serviceDate: '2026-10-09' }), 'INVALID_INPUT'));
});

describe('display formatting (Belgian style, integers only)', () => {
  const bp = [
    [492, '4,92 %'],
    [-492, '-4,92 %'],
    [5, '0,05 %'],
    [-5, '-0,05 %'],
    [0, '0,00 %'],
    [10000, '100,00 %'],
    [2331, '23,31 %'],
  ];
  for (const [value, text] of bp) {
    it(`formatBp(${value}) = ${text}`, () => assert.equal(formatBp(value), text));
  }
  const euro = [
    [123456, '€ 1.234,56'],
    [5, '€ 0,05'],
    [0, '€ 0,00'],
    [-1640, '-€ 16,40'],
    [100000000, '€ 1.000.000,00'],
    [99999, '€ 999,99'],
    [100000, '€ 1.000,00'],
  ];
  for (const [value, text] of euro) {
    it(`formatEuroCents(${value}) = ${text}`, () => assert.equal(formatEuroCents(value), text));
  }
  it('rejects non-integers', () => {
    throwsCode(() => formatBp(1.5), 'INVALID_INPUT');
    throwsCode(() => formatEuroCents(0.5), 'INVALID_INPUT');
  });
});
