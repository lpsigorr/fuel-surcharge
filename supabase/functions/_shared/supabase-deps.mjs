// supabase-deps.mjs
// Connects create-quote.mjs to Supabase. Nothing here makes a decision about money.
//
// Two clients, on purpose:
//   userClient  carries the caller's own token. Every READ goes through it, so the database's row level
//               security decides what the caller may see. A bug in our code cannot read another carrier's rates.
//   adminClient carries the secret key and bypasses row level security. It is used for ONE thing: saving the quote.

class DatabaseError extends Error {
  constructor(what, error) {
    super(`${what}: ${error?.code ?? ''} ${error?.message ?? 'unknown error'}`.trim());
    this.name = 'DatabaseError';
  }
}

export function makeDeps({ userClient, adminClient, log = (event) => console.error(JSON.stringify(event)) }) {
  // Runs a query that should return at most one row. Returns the row or null; throws on a database error.
  const maybeOne = async (what, query) => {
    const { data, error } = await query;
    if (error) throw new DatabaseError(what, error);
    return data ?? null;
  };

  return {
    log,

    async getCaller(token) {
      const { data, error } = await userClient.auth.getUser(token);
      if (error) {
        // A rejected token (4xx) means "not signed in". Anything else (Auth down, network) is our problem, not theirs.
        if (typeof error.status === 'number' && error.status >= 400 && error.status < 500) return null;
        throw new DatabaseError('auth.getUser', error);
      }
      return data?.user?.id ? { userId: data.user.id } : null;
    },

    async isMember(userId, organizationId) {
      const row = await maybeOne(
        'memberships',
        userClient.from('memberships').select('role').eq('organization_id', organizationId).eq('user_id', userId).maybeSingle(),
      );
      return row !== null;
    },

    getSettings: (organizationId) =>
      maybeOne(
        'surcharge_settings',
        userClient
          .from('surcharge_settings')
          .select('fuel_share_bp, lag_days, threshold_bp, floor_at_zero, base_diesel_cents')
          .eq('organization_id', organizationId)
          .maybeSingle(),
      ),

    getZone: (organizationId, zoneId) =>
      maybeOne('zones', userClient.from('zones').select('name').eq('organization_id', organizationId).eq('id', zoneId).maybeSingle()),

    getVehicleType: (organizationId, vehicleTypeId) =>
      maybeOne(
        'vehicle_types',
        userClient.from('vehicle_types').select('name').eq('organization_id', organizationId).eq('id', vehicleTypeId).maybeSingle(),
      ),

    getRate: (organizationId, zoneId, vehicleTypeId) =>
      maybeOne(
        'rates',
        userClient
          .from('rates')
          .select('base_rate_cents')
          .eq('organization_id', organizationId)
          .eq('zone_id', zoneId)
          .eq('vehicle_type_id', vehicleTypeId)
          .maybeSingle(),
      ),

    async getDieselPrice(mondayIso) {
      const row = await maybeOne('fuel_prices', userClient.from('fuel_prices').select('price_cents').eq('monday', mondayIso).maybeSingle());
      return row ? row.price_cents : null;
    },

    async insertQuote(row) {
      const { data, error } = await adminClient.from('quotes').insert(row).select('id, created_at').single();
      if (error) throw new DatabaseError('quotes insert', error);
      return data;
    },
  };
}
