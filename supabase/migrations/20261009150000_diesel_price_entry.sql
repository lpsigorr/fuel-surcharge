-- 20261009150000_diesel_price_entry.sql
-- Step 4: the safe way to publish the weekly diesel price.
--
-- Every carrier's quotes read the one shared table public.fuel_prices, so one wrong number there gives wrong
-- quotes to everybody for that week. This migration adds two things and changes nothing that already exists
-- (no Step 2 table, policy or grant is touched):
--
--   1. private.fuel_price_changes, plus a trigger on public.fuel_prices that writes one line there for every
--      insert, update or delete, whoever makes it (the function below, the API or the dashboard).
--   2. public.publish_diesel_price(monday, eur_per_1000l, replace, accept_big_move): the checked way to enter
--      a price. Only platform admins can use it.
--
-- The function runs as the person calling it (security invoker), so the Step 2 row level security still decides
-- who may write to fuel_prices. The checks below are typo guards for a trusted admin. They are not a defence
-- against a malicious admin: an admin who writes straight to the table skips them (the audit trail still records it).

-- ---------------------------------------------------------------------------
-- 1. Audit trail (in the private schema: not reachable through the API)
-- ---------------------------------------------------------------------------

create table private.fuel_price_changes (
  id              bigint generated always as identity primary key,
  op              text not null check (op in ('insert', 'update', 'delete')),
  monday          date not null,
  old_price_cents integer,              -- empty for an insert
  new_price_cents integer,              -- empty for a delete
  changed_by      uuid,                 -- empty when the change was made from the dashboard or SQL editor
  changed_at      timestamptz not null default now()
);
create index fuel_price_changes_monday_idx on private.fuel_price_changes (monday, changed_at);

-- No grants and no policies: only the database owner can read it (SQL editor), the API roles cannot.
alter table private.fuel_price_changes enable row level security;
revoke all on private.fuel_price_changes from public, anon, authenticated, service_role;

create function private.log_fuel_price_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  who uuid := (select auth.uid());
begin
  if tg_op = 'INSERT' then
    insert into private.fuel_price_changes (op, monday, old_price_cents, new_price_cents, changed_by)
    values ('insert', new.monday, null, new.price_cents, who);
  elsif tg_op = 'DELETE' then
    insert into private.fuel_price_changes (op, monday, old_price_cents, new_price_cents, changed_by)
    values ('delete', old.monday, old.price_cents, null, who);
  elsif new.monday = old.monday then
    insert into private.fuel_price_changes (op, monday, old_price_cents, new_price_cents, changed_by)
    values ('update', new.monday, old.price_cents, new.price_cents, who);
  else
    -- the Monday itself was edited: that is one Monday removed and another one added
    insert into private.fuel_price_changes (op, monday, old_price_cents, new_price_cents, changed_by)
    values ('delete', old.monday, old.price_cents, null, who),
           ('insert', new.monday, null, new.price_cents, who);
  end if;
  return null;
end
$$;
revoke all on function private.log_fuel_price_change() from public, anon, authenticated, service_role;

create trigger fuel_prices_audit
  after insert or update or delete on public.fuel_prices
  for each row execute function private.log_fuel_price_change();

-- ---------------------------------------------------------------------------
-- 2. The checked way to enter a price
-- ---------------------------------------------------------------------------
-- Checks, in this order. Each refusal has a code (the "message" in the API reply), a plain sentence ("details")
-- and what to do next ("hint"). The HTTP status comes from the PTnnn error code (PostgREST convention).
--
--   NOT_ALLOWED         403  not signed in, or not a platform admin
--   INVALID_MONDAY      422  the date is missing or is not a Monday
--   MONDAY_IN_FUTURE    422  the Monday has not happened yet (Brussels date), so no real price can exist
--   INVALID_PRICE       422  missing, zero or negative, or more than 2 decimals (never rounded silently)
--   PRICE_OUT_OF_RANGE  422  outside EUR 500.00 to 5000.00 per 1000 L (catches a x10 or /10 typo)
--   PRICE_EXISTS        409  that Monday already has a different price and replace was not asked for
--   BIG_MOVE            409  more than 5 % away from the closest stored Monday and the move was not accepted
--
-- A same-price repeat is not an error: it returns status "unchanged" and writes nothing.

-- Today's date in Brussels, in one small function so the tests can set the clock.
create function private.brussels_today()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'Europe/Brussels')::date
$$;
revoke all on function private.brussels_today() from public;
grant execute on function private.brussels_today() to authenticated;

create function public.publish_diesel_price(
  p_monday           date,
  p_eur_per_1000l    numeric,
  p_replace          boolean default false,
  p_accept_big_move  boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c_min_cents  constant integer := 50000;    -- EUR 500.00 per 1000 L
  c_max_cents  constant integer := 500000;   -- EUR 5000.00 per 1000 L
  v_today      date := private.brussels_today();
  v_cents      integer;
  v_found      boolean;
  v_old_cents  integer;
  v_nb_monday  date;
  v_nb_cents   integer;
  v_change_bp  integer;
  v_big        boolean := false;
  v_status     text;
  v_compared   jsonb := null;
begin
  -- who may do this
  if (select auth.uid()) is null or not private.is_platform_admin() then
    raise sqlstate 'PT403' using
      message = 'NOT_ALLOWED',
      detail  = 'Only Manifest platform admins can publish diesel prices.',
      hint    = 'Sign in with a platform admin account.';
  end if;

  -- the Monday
  if p_monday is null or extract(isodow from p_monday) <> 1 then
    raise sqlstate 'PT422' using
      message = 'INVALID_MONDAY',
      detail  = format('%s is not a Monday.', coalesce(p_monday::text, '(empty)')),
      hint    = 'Use the Monday the bulletin price is in force on.';
  end if;
  if p_monday > v_today then
    raise sqlstate 'PT422' using
      message = 'MONDAY_IN_FUTURE',
      detail  = format('%s has not happened yet (today is %s in Brussels), so no real price exists for it.', p_monday, v_today),
      hint    = 'Check the year and the day.';
  end if;

  -- the price (EUR per 1000 L, at most 2 decimals, so it converts to whole hundredths exactly)
  if p_eur_per_1000l is null or p_eur_per_1000l <= 0 then
    raise sqlstate 'PT422' using
      message = 'INVALID_PRICE',
      detail  = format('The price must be a number above zero, got %s.', coalesce(p_eur_per_1000l::text, '(empty)')),
      hint    = 'Type the price as in the bulletin, for example 1534.70.';
  end if;
  if p_eur_per_1000l <> round(p_eur_per_1000l, 2) then
    raise sqlstate 'PT422' using
      message = 'INVALID_PRICE',
      detail  = format('%s has more than 2 decimals.', p_eur_per_1000l),
      hint    = 'The bulletin gives 2 decimals. Nothing is rounded for you.';
  end if;
  if p_eur_per_1000l * 100 < c_min_cents or p_eur_per_1000l * 100 > c_max_cents then
    raise sqlstate 'PT422' using
      message = 'PRICE_OUT_OF_RANGE',
      detail  = format('%s EUR per 1000 L is outside the allowed range of 500.00 to 5000.00.', p_eur_per_1000l),
      hint    = 'This is usually a slipped decimal point or the wrong unit (the bulletin is per 1000 litres, not per litre).';
  end if;
  v_cents := (p_eur_per_1000l * 100)::integer;

  -- is there already a price for this Monday?
  select f.price_cents into v_old_cents from public.fuel_prices f where f.monday = p_monday;
  v_found := found;
  if v_found and v_old_cents = v_cents then
    return jsonb_build_object(
      'status', 'unchanged', 'monday', p_monday, 'price_cents', v_cents,
      'eur_per_1000l', to_char(v_cents / 100.0, 'FM999990.00'),
      'compared_with', null, 'big_move_accepted', false);
  end if;
  if v_found and not p_replace then
    raise sqlstate 'PT409' using
      message = 'PRICE_EXISTS',
      detail  = format('%s already has the price %s.', p_monday, to_char(v_old_cents / 100.0, 'FM999990.00')),
      hint    = 'To correct it on purpose, send replace = true.';
  end if;

  -- how far is it from the closest other stored Monday? (closest in time; on a tie, the earlier one)
  select f.monday, f.price_cents into v_nb_monday, v_nb_cents
  from public.fuel_prices f
  where f.monday <> p_monday
  order by abs(f.monday - p_monday), f.monday
  limit 1;
  if found then
    v_change_bp := round((v_cents - v_nb_cents)::numeric * 10000 / v_nb_cents)::integer;
    -- more than 5 % means more than 1/20: compare in whole cents, no rounding involved
    v_big := abs(v_cents - v_nb_cents) * 20 > v_nb_cents;
    v_compared := jsonb_build_object('monday', v_nb_monday, 'price_cents', v_nb_cents, 'change_bp', v_change_bp);
    if v_big and not p_accept_big_move then
      raise sqlstate 'PT409' using
        message = 'BIG_MOVE',
        detail  = format('%s is %s %% compared with %s on %s. The limit is 5 %%.',
                         to_char(v_cents / 100.0, 'FM999990.00'),
                         to_char(v_change_bp / 100.0, 'FMS990.00'),
                         to_char(v_nb_cents / 100.0, 'FM999990.00'), v_nb_monday),
        hint    = 'Check the number against the bulletin. If it is right, send accept_big_move = true.';
    end if;
  end if;

  -- write it (the audit trigger records the change)
  if v_found then
    update public.fuel_prices
       set price_cents = v_cents, entered_by = (select auth.uid()), entered_at = now()
     where monday = p_monday;
    v_status := 'replaced';
  else
    begin
      insert into public.fuel_prices (monday, price_cents) values (p_monday, v_cents);
    exception when unique_violation then
      raise sqlstate 'PT409' using
        message = 'PRICE_EXISTS',
        detail  = format('%s was entered by someone else a moment ago.', p_monday),
        hint    = 'Reload and check the stored price.';
    end;
    v_status := 'created';
  end if;

  return jsonb_build_object(
    'status', v_status, 'monday', p_monday, 'price_cents', v_cents,
    'eur_per_1000l', to_char(v_cents / 100.0, 'FM999990.00'),
    'compared_with', v_compared, 'big_move_accepted', v_big);
end
$$;

-- Supabase hands new functions in public to anon and authenticated by default, and Postgres adds PUBLIC.
-- Take everything away, then give back exactly one thing: signed-in users may call it (and the checks decide).
revoke all on function public.publish_diesel_price(date, numeric, boolean, boolean) from public, anon, authenticated, service_role;
grant execute on function public.publish_diesel_price(date, numeric, boolean, boolean) to authenticated;
