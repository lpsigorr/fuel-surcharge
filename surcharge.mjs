// surcharge.mjs
// Fuel surcharge (BAF) for road transport quotes. Integer arithmetic only.
//
// FORMULA
//   change    = (current - base) / base          relative move of the diesel price
//   surcharge = fuelShare x change               share of the rate that follows fuel
//   total     = rate x (1 + surcharge)
//
// UNITS (all integers; no floating point after the input boundary in toCents)
//   diesel price   hundredths of EUR per 1000 L   (EUR 1712.50 per 1000 L -> 171250)
//   shares, pct    basis points, 1 bp = 0.01 %    (20 % -> 2000)
//   money          euro cents                     (EUR 1000.00 -> 100000)
//
// ROUNDING
//   Every division rounds half away from zero, once per quantity, from raw inputs:
//     changeBp       = round(10000 x (current - base) / base)
//     surchargeBp    = round(fuelShareBp x (current - base) / base)   (not fuelShare x changeBp)
//     surchargeCents = round(rateCents x surchargeBp / 10000)
//   total = rate + surchargeCents, so the lines on an invoice always add up, and the
//   customer can reproduce the amount from the printed percentage (2 decimals).
//
// REFERENCE PRICE
//   The price used for a service date is the Monday price of the latest Monday that is
//   on or before (serviceDate - lagDays). Later Mondays are never used (no look-ahead).
//   A missing price is an error, never a guess.
//
// THRESHOLD (optional)
//   If thresholdBp > 0 the surcharge is 0 unless |change| >= threshold. The test uses the
//   exact change (integer cross-multiplication), not the rounded changeBp, so a change
//   that displays as 5.00 % can still be below a 5.00 % threshold.
//   Once the threshold is met the surcharge applies to the whole change (cliff), not
//   only to the part above the threshold.

export class SurchargeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SurchargeError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new SurchargeError(code, message);
};

function requireInt(name, value, min, max) {
  const ok =
    Number.isSafeInteger(value) &&
    (min === undefined || value >= min) &&
    (max === undefined || value <= max);
  if (!ok) {
    const range =
      min !== undefined && max !== undefined
        ? ` from ${min} to ${max}`
        : min !== undefined
          ? ` of at least ${min}`
          : '';
    fail('INVALID_INPUT', `${name} must be an integer${range}, got ${String(value)}`);
  }
}

// ---------------------------------------------------------------- input boundary

// Euros (as a JS number with at most 2 decimals) -> integer hundredths.
// Rejects anything with a third decimal instead of silently rounding it.
export function toCents(euros) {
  if (typeof euros !== 'number' || !Number.isFinite(euros)) {
    fail('INVALID_INPUT', `amount must be a finite number, got ${String(euros)}`);
  }
  const scaled = euros * 100;
  const cents = Math.round(scaled);
  if (Math.abs(scaled - cents) > 1e-6) {
    fail('INVALID_INPUT', `${euros} has more than 2 decimals`);
  }
  if (!Number.isSafeInteger(cents)) fail('INVALID_INPUT', `${euros} is too large`);
  return cents === 0 ? 0 : cents; // normalises -0
}

// ---------------------------------------------------------------- rounding

// round(a x b / d), half away from zero, exact for any safe-integer inputs (BigInt inside).
export function mulDivRound(a, b, d) {
  requireInt('a', a);
  requireInt('b', b);
  requireInt('denominator', d, 1);
  const n = BigInt(a) * BigInt(b);
  const abs = n < 0n ? -n : n;
  const q = (2n * abs + BigInt(d)) / (2n * BigInt(d));
  const result = n < 0n ? -q : q;
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < -BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('RESULT_TOO_LARGE', 'result does not fit in a safe integer');
  }
  return Number(result);
}

// round(n / d), half away from zero.
export function divRound(n, d) {
  return mulDivRound(n, 1, d);
}

// ---------------------------------------------------------------- reference Monday

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function parseIsoDate(name, text) {
  const m = typeof text === 'string' ? ISO_DATE.exec(text) : null;
  if (!m) fail('INVALID_DATE', `${name} must be a YYYY-MM-DD date, got ${String(text)}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const check = new Date(t);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    fail('INVALID_DATE', `${name} is not a real calendar date: ${text}`);
  }
  return t;
}

// Latest Monday on or before (serviceDate - lagDays), as YYYY-MM-DD.
export function referenceMonday(serviceDate, lagDays = 7) {
  requireInt('lagDays', lagDays, 0);
  const t = parseIsoDate('serviceDate', serviceDate) - lagDays * DAY_MS;
  const dayOfWeek = new Date(t).getUTCDay(); // 0 = Sunday ... 6 = Saturday
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  return new Date(t - daysSinceMonday * DAY_MS).toISOString().slice(0, 10);
}

// prices: { 'YYYY-MM-DD' (a Monday): integer hundredths of EUR per 1000 L }
export function pickPrice(prices, mondayIso) {
  if (typeof prices !== 'object' || prices === null) {
    fail('INVALID_INPUT', 'prices must be an object keyed by Monday date');
  }
  if (!Object.hasOwn(prices, mondayIso)) {
    fail('MISSING_PRICE', `No diesel price for Monday ${mondayIso}. Refusing to guess.`);
  }
  const value = prices[mondayIso];
  requireInt(`prices[${mondayIso}]`, value, 1);
  return value;
}

// ---------------------------------------------------------------- the formula

export function computeSurcharge({
  baseCents,
  currentCents,
  fuelShareBp,
  thresholdBp = 0,
  floorAtZero = false,
}) {
  requireInt('baseCents', baseCents, 1);
  requireInt('currentCents', currentCents, 1);
  requireInt('fuelShareBp', fuelShareBp, 0, 10000);
  requireInt('thresholdBp', thresholdBp, 0);
  if (typeof floorAtZero !== 'boolean') fail('INVALID_INPUT', 'floorAtZero must be true or false');

  const diff = currentCents - baseCents;
  const changeBp = mulDivRound(10000, diff, baseCents);

  // |diff| / base < thresholdBp / 10000, compared exactly without division.
  const belowThreshold =
    thresholdBp > 0 &&
    BigInt(Math.abs(diff)) * 10000n < BigInt(thresholdBp) * BigInt(baseCents);

  let surchargeBp = belowThreshold ? 0 : mulDivRound(fuelShareBp, diff, baseCents);
  let reason = belowThreshold ? 'BELOW_THRESHOLD' : 'APPLIED';

  if (floorAtZero && surchargeBp < 0) {
    surchargeBp = 0;
    reason = 'FLOORED_AT_ZERO';
  }
  return { changeBp, surchargeBp, reason };
}

export function quote({
  rateCents,
  prices,
  baseCents,
  serviceDate,
  fuelShareBp,
  lagDays = 7,
  thresholdBp = 0,
  floorAtZero = false,
}) {
  requireInt('rateCents', rateCents, 0);
  const referenceDate = referenceMonday(serviceDate, lagDays);
  const currentCents = pickPrice(prices, referenceDate);
  const { changeBp, surchargeBp, reason } = computeSurcharge({
    baseCents,
    currentCents,
    fuelShareBp,
    thresholdBp,
    floorAtZero,
  });
  const surchargeCents = mulDivRound(rateCents, surchargeBp, 10000);
  return {
    referenceDate,
    baseCents,
    currentCents,
    changeBp,
    surchargeBp,
    reason,
    rateCents,
    surchargeCents,
    totalCents: rateCents + surchargeCents,
  };
}

// ---------------------------------------------------------------- display only (Belgian style)

const withDots = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// 492 -> "4,92 %"   -5 -> "-0,05 %"
export function formatBp(bp) {
  requireInt('bp', bp);
  const abs = Math.abs(bp);
  return `${bp < 0 ? '-' : ''}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')} %`;
}

// 123456 -> "€ 1.234,56"   -1640 -> "-€ 16,40"
export function formatEuroCents(cents) {
  requireInt('cents', cents);
  const abs = Math.abs(cents);
  const body = `${withDots(Math.floor(abs / 100))},${String(abs % 100).padStart(2, '0')}`;
  return `${cents < 0 ? '-' : ''}€ ${body}`;
}
