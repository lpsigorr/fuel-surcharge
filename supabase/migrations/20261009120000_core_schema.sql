-- 20261009120000_core_schema.sql
-- Step 2: core data model for the fuel surcharge and quoting system.
--
-- Units, same as surcharge.mjs:
--   diesel price   integer hundredths of EUR per 1000 L   (EUR 1712.50 per 1000 L -> 171250)
--   shares, pct    integer basis points, 1 bp = 0.01 %     (20 % -> 2000)
--   money          integer euro cents                      (EUR 1000.00 -> 100000)
--
-- Security model:
--   * Every table has row level security (RLS) switched on.
--   * The `anon` role (not signed in) has no access to anything.
--   * Signed-in users (`authenticated`) only see rows of carriers they belong to.
--   * Quotes are written only by trusted server code (service role), never by the browser,
--     and the database re-checks the surcharge maths on every quote it stores.

create schema if not exists private;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------------
-- Pure helper functions (no table access), used by CHECK constraints
-- ---------------------------------------------------------------------------

-- Latest Monday on or before (service_date - lag_days). Same rule as referenceMonday() in surcharge.mjs.
create function private.reference_monday(service_date date, lag_days integer)
returns date
language sql
immutable
set search_path = ''
as $$
  select date_trunc('week', (service_date - lag_days)::timestamp)::date
$$;

-- True only if the stored results follow the approved formula exactly.
-- Mirrors computeSurcharge() and quote() in surcharge.mjs. round(numeric) rounds ties away from zero.
create function private.quote_numbers_ok(
  rate_cents integer,
  base_diesel_cents integer,
  current_diesel_cents integer,
  fuel_share_bp integer,
  threshold_bp integer,
  floor_at_zero boolean,
  change_bp integer,
  surcharge_bp integer,
  reason text,
  surcharge_cents integer,
  total_cents integer
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  with x as (
    select
      (current_diesel_cents - base_diesel_cents)::numeric as diff,
      base_diesel_cents::numeric as base
  ), y as (
    select
      diff,
      base,
      (threshold_bp > 0 and abs(diff) * 10000 < threshold_bp::numeric * base) as below,
      round(fuel_share_bp::numeric * diff / nullif(base, 0)) as raw_bp
    from x
  ), z as (
    select
      round(10000::numeric * diff / nullif(base, 0)) as exp_change_bp,
      case
        when below then 0
        when floor_at_zero and raw_bp < 0 then 0
        else raw_bp
      end as exp_surcharge_bp,
      case
        when below then 'BELOW_THRESHOLD'
        when floor_at_zero and raw_bp < 0 then 'FLOORED_AT_ZERO'
        else 'APPLIED'
      end as exp_reason
    from y
  )
  select coalesce(
    change_bp = exp_change_bp
    and surcharge_bp = exp_surcharge_bp
    and reason = exp_reason
    and surcharge_cents = round(rate_cents::numeric * exp_surcharge_bp / 10000)
    and total_cents = rate_cents + surcharge_cents,
    false
  )
  from z
$$;

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

create function private.forbid_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'quotes are immutable: create a new quote instead of changing one'
    using errcode = '55000';
end
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- A carrier (the customer of Manifest). One row per transport company.
create table public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(btrim(name)) between 1 and 120),
  created_at timestamptz not null default now()
);

-- Which signed-in users belong to which carrier, and with what role.
create table public.memberships (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  role            text not null check (role in ('owner', 'staff')),
  created_at      timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index memberships_user_id_idx on public.memberships (user_id);

-- Manifest staff who may publish the shared diesel prices. Not reachable through the API.
create table public.platform_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- The shared diesel price series, one row per Monday, the same for every carrier.
create table public.fuel_prices (
  monday      date primary key check (extract(isodow from monday) = 1),
  price_cents integer not null check (price_cents > 0),
  source      text not null default 'eu_weekly_oil_bulletin_be_diesel_with_taxes',
  entered_by  uuid default auth.uid() references auth.users (id) on delete set null,
  entered_at  timestamptz not null default now()
);

-- Surcharge settings, one row per carrier.
create table public.surcharge_settings (
  organization_id   uuid primary key references public.organizations (id) on delete cascade,
  fuel_share_bp     integer not null check (fuel_share_bp between 0 and 10000),
  lag_days          integer not null default 7 check (lag_days >= 0),
  threshold_bp      integer not null default 0 check (threshold_bp >= 0),
  floor_at_zero     boolean not null default false,
  base_diesel_cents integer not null check (base_diesel_cents > 0),
  updated_at        timestamptz not null default now()
);
create trigger surcharge_settings_touch
  before update on public.surcharge_settings
  for each row execute function private.set_updated_at();

create table public.zones (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 80),
  created_at      timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index zones_org_name_key on public.zones (organization_id, lower(btrim(name)));

create table public.vehicle_types (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 80),
  created_at      timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index vehicle_types_org_name_key on public.vehicle_types (organization_id, lower(btrim(name)));

-- The rate card: one flat base rate per zone and vehicle type.
-- The composite foreign keys make it impossible to point a rate at another carrier's zone or vehicle type.
create table public.rates (
  organization_id uuid not null,
  zone_id         uuid not null,
  vehicle_type_id uuid not null,
  base_rate_cents integer not null check (base_rate_cents >= 0),
  updated_at      timestamptz not null default now(),
  primary key (zone_id, vehicle_type_id),
  foreign key (zone_id, organization_id)
    references public.zones (id, organization_id) on delete cascade,
  foreign key (vehicle_type_id, organization_id)
    references public.vehicle_types (id, organization_id) on delete cascade
);
create index rates_organization_id_idx on public.rates (organization_id);
create trigger rates_touch
  before update on public.rates
  for each row execute function private.set_updated_at();

-- A saved quote: a frozen snapshot of every input used and every result.
-- Later changes to rates, settings or diesel prices never change an old quote.
create table public.quotes (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete cascade,
  source               text not null default 'staff' check (source in ('staff', 'widget')),
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  customer_reference   text check (customer_reference is null or char_length(customer_reference) <= 200),
  zone_name            text not null,
  vehicle_type_name    text not null,
  service_date         date not null,
  -- inputs, frozen
  rate_cents           integer not null check (rate_cents >= 0),
  base_diesel_cents    integer not null check (base_diesel_cents > 0),
  reference_monday     date not null,
  current_diesel_cents integer not null check (current_diesel_cents > 0),
  fuel_share_bp        integer not null check (fuel_share_bp between 0 and 10000),
  lag_days             integer not null check (lag_days >= 0),
  threshold_bp         integer not null check (threshold_bp >= 0),
  floor_at_zero        boolean not null,
  -- results, frozen
  change_bp            integer not null,
  surcharge_bp         integer not null,
  reason               text not null check (reason in ('APPLIED', 'BELOW_THRESHOLD', 'FLOORED_AT_ZERO')),
  surcharge_cents      integer not null,
  total_cents          integer not null check (total_cents >= 0),
  engine_version       text not null check (char_length(engine_version) between 1 and 80),
  constraint quotes_reference_monday_ok
    check (reference_monday = private.reference_monday(service_date, lag_days)),
  constraint quotes_numbers_ok
    check (private.quote_numbers_ok(
      rate_cents, base_diesel_cents, current_diesel_cents, fuel_share_bp, threshold_bp,
      floor_at_zero, change_bp, surcharge_bp, reason, surcharge_cents, total_cents))
);
create index quotes_organization_created_idx on public.quotes (organization_id, created_at desc);
create trigger quotes_no_update
  before update on public.quotes
  for each row execute function private.forbid_update();

-- ---------------------------------------------------------------------------
-- Descriptions shown in the Supabase dashboard
-- ---------------------------------------------------------------------------

comment on table public.organizations       is 'A carrier (customer of Manifest).';
comment on table public.memberships         is 'Which users belong to which carrier, owner or staff.';
comment on table public.platform_admins     is 'Manifest staff allowed to publish shared diesel prices. Not exposed through the API.';
comment on table public.fuel_prices         is 'Shared diesel price per Monday, the same for every carrier.';
comment on table public.surcharge_settings  is 'Fuel surcharge settings per carrier.';
comment on table public.zones               is 'Delivery zones defined by a carrier.';
comment on table public.vehicle_types       is 'Vehicle types defined by a carrier.';
comment on table public.rates               is 'Flat base rate per zone and vehicle type.';
comment on table public.quotes              is 'Immutable snapshot of a quote: all inputs and results as they were when it was made.';
comment on column public.fuel_prices.price_cents          is 'Hundredths of EUR per 1000 L. EUR 1712.50 per 1000 L is stored as 171250.';
comment on column public.surcharge_settings.fuel_share_bp is 'Share of the rate that follows diesel, in basis points. 20 % is 2000.';
comment on column public.surcharge_settings.threshold_bp  is 'Minimum diesel move before any surcharge applies, in basis points. 0 means always apply.';
comment on column public.surcharge_settings.base_diesel_cents is 'Diesel price the rates were set at, hundredths of EUR per 1000 L.';
comment on column public.rates.base_rate_cents            is 'Euro cents, before fuel surcharge.';
comment on column public.quotes.surcharge_cents           is 'Euro cents. Negative when the diesel price fell and credits are allowed.';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.organizations      enable row level security;
alter table public.memberships        enable row level security;
alter table public.platform_admins    enable row level security;
alter table public.fuel_prices        enable row level security;
alter table public.surcharge_settings enable row level security;
alter table public.zones              enable row level security;
alter table public.vehicle_types      enable row level security;
alter table public.rates              enable row level security;
alter table public.quotes             enable row level security;

-- Helpers that look up who the signed-in user is. They run with elevated rights so that policies
-- on `memberships` itself cannot loop, and they return only a yes or no about the caller.
create function private.is_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.organization_id = org and m.user_id = (select auth.uid())
  )
$$;

create function private.is_owner(org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.organization_id = org and m.user_id = (select auth.uid()) and m.role = 'owner'
  )
$$;

create function private.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins a where a.user_id = (select auth.uid())
  )
$$;

revoke all on function private.is_member(uuid), private.is_owner(uuid), private.is_platform_admin() from public;
grant execute on function private.is_member(uuid), private.is_owner(uuid), private.is_platform_admin() to authenticated;

-- Grants: start from nothing, then give signed-in users only what they need.
revoke all on public.organizations, public.memberships, public.platform_admins, public.fuel_prices,
  public.surcharge_settings, public.zones, public.vehicle_types, public.rates, public.quotes
  from anon, authenticated;

grant select on public.organizations to authenticated;
grant update (name) on public.organizations to authenticated;
grant select on public.memberships to authenticated;
grant select, insert, update on public.fuel_prices to authenticated;
grant select, insert, update on public.surcharge_settings to authenticated;
grant select, insert, update, delete on public.zones, public.vehicle_types, public.rates to authenticated;
grant select on public.quotes to authenticated;

-- organizations
create policy organizations_select_member on public.organizations
  for select to authenticated using (private.is_member(id));
create policy organizations_update_owner on public.organizations
  for update to authenticated using (private.is_owner(id)) with check (private.is_owner(id));

-- memberships (read only through the API; changes are made by trusted server code)
create policy memberships_select_member on public.memberships
  for select to authenticated using (private.is_member(organization_id));

-- platform_admins: RLS on, no policies, no grants -> invisible through the API

-- fuel_prices: everyone signed in can read, only platform admins can write, nobody can delete
create policy fuel_prices_select_authenticated on public.fuel_prices
  for select to authenticated using (true);
create policy fuel_prices_insert_admin on public.fuel_prices
  for insert to authenticated with check (private.is_platform_admin());
create policy fuel_prices_update_admin on public.fuel_prices
  for update to authenticated using (private.is_platform_admin()) with check (private.is_platform_admin());

-- surcharge_settings
create policy surcharge_settings_select_member on public.surcharge_settings
  for select to authenticated using (private.is_member(organization_id));
create policy surcharge_settings_insert_owner on public.surcharge_settings
  for insert to authenticated with check (private.is_owner(organization_id));
create policy surcharge_settings_update_owner on public.surcharge_settings
  for update to authenticated using (private.is_owner(organization_id)) with check (private.is_owner(organization_id));

-- zones, vehicle_types, rates: members read, owners write
create policy zones_select_member on public.zones
  for select to authenticated using (private.is_member(organization_id));
create policy zones_insert_owner on public.zones
  for insert to authenticated with check (private.is_owner(organization_id));
create policy zones_update_owner on public.zones
  for update to authenticated using (private.is_owner(organization_id)) with check (private.is_owner(organization_id));
create policy zones_delete_owner on public.zones
  for delete to authenticated using (private.is_owner(organization_id));

create policy vehicle_types_select_member on public.vehicle_types
  for select to authenticated using (private.is_member(organization_id));
create policy vehicle_types_insert_owner on public.vehicle_types
  for insert to authenticated with check (private.is_owner(organization_id));
create policy vehicle_types_update_owner on public.vehicle_types
  for update to authenticated using (private.is_owner(organization_id)) with check (private.is_owner(organization_id));
create policy vehicle_types_delete_owner on public.vehicle_types
  for delete to authenticated using (private.is_owner(organization_id));

create policy rates_select_member on public.rates
  for select to authenticated using (private.is_member(organization_id));
create policy rates_insert_owner on public.rates
  for insert to authenticated with check (private.is_owner(organization_id));
create policy rates_update_owner on public.rates
  for update to authenticated using (private.is_owner(organization_id)) with check (private.is_owner(organization_id));
create policy rates_delete_owner on public.rates
  for delete to authenticated using (private.is_owner(organization_id));

-- quotes: members can read their carrier's quotes. No insert, update or delete policy exists:
-- quotes are written only by trusted server code using the service role, which bypasses RLS.
create policy quotes_select_member on public.quotes
  for select to authenticated using (private.is_member(organization_id));
