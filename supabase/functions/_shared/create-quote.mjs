// create-quote.mjs
// The rules of the "create a quote" endpoint, with no Deno and no Supabase in it.
// Everything that touches the outside world comes in through `deps`, so the tests can swap it.
//
// WHAT THE ENDPOINT DOES (staff quotes only; the website widget is a later step)
//   1. Reads the caller's token and asks Supabase Auth who it is.            -> 401 if unknown
//   2. Checks the body (exact fields, real UUIDs, a real calendar date).     -> 400 / 413 if wrong
//   3. Checks that the caller is a member of the carrier.                    -> 403 if not
//   4. Reads the carrier's settings, zone, vehicle type and rate, AS THE CALLER,
//      so the database's own row level security applies to every read.       -> 409 / 404 if missing
//   5. Finds the reference Monday and its diesel price.                      -> 409 if missing (never guesses)
//   6. Runs the Step 1 engine (surcharge.mjs).
//   7. Saves the frozen quote. This is the ONLY step that uses the powerful server key,
//      and the database re-checks the maths before accepting the row.        -> 201

import { quote, referenceMonday, formatBp, formatEuroCents } from './surcharge.mjs';

// Tied to the exact bytes of surcharge.mjs. A test fails if the engine file changes without this being
// updated on purpose, so every saved quote says which version of the maths produced it.
export const ENGINE_VERSION = 'surcharge.mjs sha256:885ef680a329';

export const MAX_BODY_BYTES = 2048;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_FIELDS = new Set(['organizationId', 'zoneId', 'vehicleTypeId', 'serviceDate', 'customerReference']);
const MAX_REFERENCE_LENGTH = 200; // counted in characters (code points), same as the database check

class ApiError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field; // which request field is wrong, when that applies
  }
}

const reply = (status, body) => ({ status, body });
const errorBody = (code, message, extra = {}) => ({ error: { code, message, ...extra } });

// ---------------------------------------------------------------- reading the request

function readBearerToken(authorization) {
  const m = typeof authorization === 'string' ? /^Bearer\s+(\S+)$/i.exec(authorization.trim()) : null;
  if (!m) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in first. No valid sign-in token was sent.');
  return m[1];
}

function isRealDate(text) {
  if (!ISO_DATE.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const invalid = (field, message) => new ApiError(400, 'INVALID_REQUEST', message, field);

export function parseBody(bodyText) {
  if (typeof bodyText !== 'string' || new TextEncoder().encode(bodyText).length > MAX_BODY_BYTES) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `The request body may be at most ${MAX_BODY_BYTES} bytes.`);
  }
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'The request body is not valid JSON.');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'The request body must be a JSON object.');
  }
  for (const key of Object.keys(data)) {
    if (!ALLOWED_FIELDS.has(key)) throw invalid(key, `Unknown field "${key}".`);
  }

  const uuid = (field) => {
    const v = data[field];
    if (typeof v !== 'string' || !UUID.test(v.toLowerCase())) {
      throw invalid(field, `${field} must be a UUID.`);
    }
    return v.toLowerCase();
  };
  const organizationId = uuid('organizationId');
  const zoneId = uuid('zoneId');
  const vehicleTypeId = uuid('vehicleTypeId');

  const serviceDate = data.serviceDate;
  if (typeof serviceDate !== 'string' || !isRealDate(serviceDate)) {
    throw invalid('serviceDate', 'serviceDate must be a real calendar date written YYYY-MM-DD.');
  }

  let customerReference = null;
  if (data.customerReference !== undefined && data.customerReference !== null) {
    if (typeof data.customerReference !== 'string') {
      throw invalid('customerReference', 'customerReference must be text.');
    }
    const trimmed = data.customerReference.trim();
    if ([...trimmed].length > MAX_REFERENCE_LENGTH) {
      throw invalid('customerReference', `customerReference may be at most ${MAX_REFERENCE_LENGTH} characters.`);
    }
    customerReference = trimmed === '' ? null : trimmed;
  }
  return { organizationId, zoneId, vehicleTypeId, serviceDate, customerReference };
}

// ---------------------------------------------------------------- the endpoint

// req:  { method, authorization, bodyText }
// deps: getCaller(token) -> { userId } | null          (null = the token is not accepted)
//       isMember(userId, organizationId) -> boolean
//       getSettings(organizationId) -> { fuel_share_bp, lag_days, threshold_bp, floor_at_zero, base_diesel_cents } | null
//       getZone(organizationId, zoneId) -> { name } | null
//       getVehicleType(organizationId, vehicleTypeId) -> { name } | null
//       getRate(organizationId, zoneId, vehicleTypeId) -> { base_rate_cents } | null
//       getDieselPrice(mondayIso) -> price_cents | null
//       insertQuote(row) -> { id, created_at }
//       log(event)  optional
// returns { status, body }. Never throws.
export async function handleCreateQuote(req, deps) {
  const progress = { insertStarted: false };
  try {
    return await run(req, deps, progress);
  } catch (e) {
    if (e instanceof ApiError) {
      return reply(e.status, errorBody(e.code, e.message, e.field ? { field: e.field } : {}));
    }
    deps.log?.({ event: 'create_quote_failed', insertStarted: progress.insertStarted, message: String(e?.message ?? e) });
    return reply(
      500,
      errorBody(
        'INTERNAL_ERROR',
        progress.insertStarted
          ? 'The quote may not have been saved. Check the quote list before trying again.'
          : 'Something went wrong. Nothing was saved.',
      ),
    );
  }
}

async function run(req, deps, progress) {
  if (req.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use POST.');

  const token = readBearerToken(req.authorization);
  const caller = await deps.getCaller(token);
  if (!caller || typeof caller.userId !== 'string') {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in first. The sign-in token was not accepted.');
  }

  const input = parseBody(req.bodyText);

  if (!(await deps.isMember(caller.userId, input.organizationId))) {
    throw new ApiError(403, 'NOT_A_MEMBER', 'You are not a member of this carrier, or it does not exist.');
  }

  const [settings, zone, vehicleType, rate] = await Promise.all([
    deps.getSettings(input.organizationId),
    deps.getZone(input.organizationId, input.zoneId),
    deps.getVehicleType(input.organizationId, input.vehicleTypeId),
    deps.getRate(input.organizationId, input.zoneId, input.vehicleTypeId),
  ]);
  if (!settings) {
    throw new ApiError(409, 'SETTINGS_MISSING', 'This carrier has no fuel surcharge settings yet. An owner must set them first.');
  }
  if (!zone) throw new ApiError(404, 'ZONE_NOT_FOUND', 'This zone does not exist for this carrier.');
  if (!vehicleType) throw new ApiError(404, 'VEHICLE_TYPE_NOT_FOUND', 'This vehicle type does not exist for this carrier.');
  if (!rate) throw new ApiError(404, 'RATE_NOT_FOUND', 'No rate is set for this zone and vehicle type.');

  const monday = referenceMonday(input.serviceDate, settings.lag_days);
  const currentCents = await deps.getDieselPrice(monday);
  if (currentCents === null || currentCents === undefined) {
    throw new ApiError(
      409,
      'DIESEL_PRICE_MISSING',
      `No diesel price has been published for the week of Monday ${monday}, so no quote can be made for ${input.serviceDate}.`,
    );
  }

  const result = quote({
    rateCents: rate.base_rate_cents,
    prices: { [monday]: currentCents },
    baseCents: settings.base_diesel_cents,
    serviceDate: input.serviceDate,
    fuelShareBp: settings.fuel_share_bp,
    lagDays: settings.lag_days,
    thresholdBp: settings.threshold_bp,
    floorAtZero: settings.floor_at_zero,
  });

  const row = {
    organization_id: input.organizationId,
    source: 'staff',
    created_by: caller.userId,
    customer_reference: input.customerReference,
    zone_name: zone.name,
    vehicle_type_name: vehicleType.name,
    service_date: input.serviceDate,
    rate_cents: result.rateCents,
    base_diesel_cents: result.baseCents,
    reference_monday: result.referenceDate,
    current_diesel_cents: result.currentCents,
    fuel_share_bp: settings.fuel_share_bp,
    lag_days: settings.lag_days,
    threshold_bp: settings.threshold_bp,
    floor_at_zero: settings.floor_at_zero,
    change_bp: result.changeBp,
    surcharge_bp: result.surchargeBp,
    reason: result.reason,
    surcharge_cents: result.surchargeCents,
    total_cents: result.totalCents,
    engine_version: ENGINE_VERSION,
  };

  progress.insertStarted = true;
  const saved = await deps.insertQuote(row);

  return reply(201, {
    quote: {
      id: saved.id,
      createdAt: saved.created_at,
      organizationId: row.organization_id,
      customerReference: row.customer_reference,
      zone: row.zone_name,
      vehicleType: row.vehicle_type_name,
      serviceDate: row.service_date,
      referenceMonday: row.reference_monday,
      rateCents: row.rate_cents,
      baseDieselCents: row.base_diesel_cents,
      currentDieselCents: row.current_diesel_cents,
      fuelShareBp: row.fuel_share_bp,
      lagDays: row.lag_days,
      thresholdBp: row.threshold_bp,
      floorAtZero: row.floor_at_zero,
      changeBp: row.change_bp,
      surchargeBp: row.surcharge_bp,
      reason: row.reason,
      surchargeCents: row.surcharge_cents,
      totalCents: row.total_cents,
      engineVersion: row.engine_version,
    },
    display: {
      rate: formatEuroCents(row.rate_cents),
      dieselChange: formatBp(row.change_bp),
      surcharge: formatBp(row.surcharge_bp),
      surchargeAmount: formatEuroCents(row.surcharge_cents),
      total: formatEuroCents(row.total_cents),
    },
  });
}
