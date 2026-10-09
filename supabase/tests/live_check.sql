-- live_check.sql
-- Safe-to-run security and data-rule check for the REAL Supabase project (and for the local test database).
-- Everything happens inside one DO block that ends by raising an error, so ALL test data is rolled back
-- and nothing is left behind. The results are printed in that error message ("LIVE_CHECK_RESULTS").
-- Needs the migration to be applied first. Run it as the `postgres` role (SQL editor or MCP execute_sql).
--
-- ONLY RUN IT ON AN EMPTY PROJECT. It inserts its own diesel prices (Mondays 2026-09-28 and 2026-10-05) and
-- one check counts all quotes ("exactly 2"). Once real data exists, those inserts can collide with real rows
-- and that count will be wrong, so use a separate test project or a Supabase branch then.

do $$
declare
  res text[] := '{}';
  r text;
  n bigint;
  ok boolean;
  tbl text;
  tbls text[] := array['organizations','memberships','platform_admins','fuel_prices','surcharge_settings','zones','vehicle_types','rates','quotes'];
  uA uuid := gen_random_uuid(); uB uuid := gen_random_uuid(); uC uuid := gen_random_uuid();
  uD uuid := gen_random_uuid(); uP uuid := gen_random_uuid();
  o1 uuid := gen_random_uuid(); o2 uuid := gen_random_uuid();
  z1 uuid := gen_random_uuid(); z2 uuid := gen_random_uuid();
  v1 uuid := gen_random_uuid(); v2 uuid := gen_random_uuid();
  all_refused boolean := true;
  a_org bigint; a_zone bigint; a_rate bigint; a_set bigint; a_quote bigint; a_org2_zone bigint; a_org2_set bigint; a_own_set bigint;
  a_ins_other text; a_ins_quote text; a_admins text; a_cross text;
  b_zone bigint; b_quote bigint; b_ins text; b_rate_upd bigint;
  c_org bigint; c_zone bigint; c_quote bigint; c_org1_zone bigint;
  d_org bigint; d_zone bigint; d_quote bigint; d_fuel bigint;
  p_org bigint; p_ins text; p_bad text; p_del text; p_admins text;
  s_quotes bigint; s_ins text; s_upd text; s_bad text; an_helper text;
begin
  ---------------------------------------------------------------- seed (as postgres)
  insert into auth.users (id) values (uA), (uB), (uC), (uD), (uP);
  insert into public.platform_admins (user_id) values (uP);
  insert into public.organizations (id, name) values (o1, 'Alpha Transport'), (o2, 'Beta Express');
  insert into public.memberships (organization_id, user_id, role) values (o1, uA, 'owner'), (o1, uB, 'staff'), (o2, uC, 'owner');
  insert into public.surcharge_settings (organization_id, fuel_share_bp, base_diesel_cents) values (o1, 2000, 150000), (o2, 2500, 140000);
  insert into public.zones (id, organization_id, name) values (z1, o1, 'Brussels'), (z2, o2, 'Ghent');
  insert into public.vehicle_types (id, organization_id, name) values (v1, o1, 'Van'), (v2, o2, 'Van');
  insert into public.rates (organization_id, zone_id, vehicle_type_id, base_rate_cents) values (o1, z1, v1, 12000), (o2, z2, v2, 11000);
  insert into public.fuel_prices (monday, price_cents) values ('2026-09-28', 165000);

  execute 'set local role service_role';
  insert into public.quotes
    (organization_id, source, zone_name, vehicle_type_name, service_date, rate_cents, base_diesel_cents,
     reference_monday, current_diesel_cents, fuel_share_bp, lag_days, threshold_bp, floor_at_zero,
     change_bp, surcharge_bp, reason, surcharge_cents, total_cents, engine_version)
  values
    (o1, 'staff', 'Brussels', 'Van', '2026-10-09', 33333, 124460, '2026-09-28', 153470, 2110, 7, 0, false, 2331, 492, 'APPLIED', 1640, 34973, 'live-check'),
    (o2, 'staff', 'Ghent', 'Van', '2026-10-09', 11000, 140000, '2026-09-28', 165000, 2500, 7, 500, true, 1786, 446, 'APPLIED', 491, 11491, 'live-check');
  execute 'reset role';
  res := array_append(res, 'PASS the two Febetra-style quotes are accepted by the live database (+23.31 %, 4.92 %, EUR 16.40, total EUR 349.73)');

  ---------------------------------------------------------------- structure and privileges
  select (select count(*) from pg_tables where schemaname = 'public' and tablename = any (tbls)) = 9
     and not exists (select 1 from pg_tables where schemaname = 'public' and tablename <> all (tbls))
    into ok;
  res := res || (case when ok then 'PASS ' else 'FAIL ' end || 'exactly the 9 expected tables exist in public');

  select not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity) into ok;
  res := res || (case when ok then 'PASS ' else 'FAIL ' end || 'row level security is on for every table in public');

  select bool_and(not has_table_privilege('anon', 'public.' || t, 'select,insert,update,delete,truncate,references,trigger')
                  and not has_any_column_privilege('anon', 'public.' || t, 'select,insert,update,references'))
    from unnest(tbls) as t into ok;
  res := res || (case when ok then 'PASS ' else 'FAIL ' end || 'anon (not signed in) holds no privilege on any of the 9 tables');

  with expected(tbl, priv) as (values
      ('organizations','SELECT'), ('memberships','SELECT'),
      ('fuel_prices','SELECT'), ('fuel_prices','INSERT'), ('fuel_prices','UPDATE'),
      ('surcharge_settings','SELECT'), ('surcharge_settings','INSERT'), ('surcharge_settings','UPDATE'),
      ('zones','SELECT'), ('zones','INSERT'), ('zones','UPDATE'), ('zones','DELETE'),
      ('vehicle_types','SELECT'), ('vehicle_types','INSERT'), ('vehicle_types','UPDATE'), ('vehicle_types','DELETE'),
      ('rates','SELECT'), ('rates','INSERT'), ('rates','UPDATE'), ('rates','DELETE'),
      ('quotes','SELECT')),
    actual as (
      select c.relname::text as tbl, p.priv
      from pg_class c
      cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) as p(priv)
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
        and has_table_privilege('authenticated', c.oid, p.priv))
  select not exists (select * from expected except select * from actual)
     and not exists (select * from actual except select * from expected)
    into ok;
  res := res || (case when ok then 'PASS ' else 'FAIL ' end || 'signed-in users hold exactly the intended table privileges and no others');

  select has_column_privilege('authenticated', 'public.organizations', 'name', 'UPDATE')
     and not has_column_privilege('authenticated', 'public.organizations', 'id', 'UPDATE')
    into ok;
  res := res || (case when ok then 'PASS ' else 'FAIL ' end || 'signed-in users may change only the name column of organizations');

  ---------------------------------------------------------------- anon (not signed in)
  execute 'set local role anon';
  perform set_config('request.jwt.claims', '', true);
  foreach tbl in array tbls loop
    begin
      execute format('select count(*) from public.%I', tbl) into n;
      all_refused := false;
    exception when insufficient_privilege then
      null;
    end;
  end loop;
  begin
    perform private.is_member(o1);
    an_helper := 'ok';
  exception when others then an_helper := sqlstate;
  end;
  execute 'reset role';
  res := res || (case when all_refused then 'PASS ' else 'FAIL ' end || 'anon is refused when reading each of the 9 tables');
  res := res || (case when an_helper = '42501' then 'PASS ' else 'FAIL ' end || 'anon cannot call the private helper functions');

  ---------------------------------------------------------------- A: owner of Alpha Transport
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', uA, 'role', 'authenticated')::text, true);
  select count(*) into a_org from public.organizations;
  select count(*) into a_zone from public.zones;
  select count(*) into a_rate from public.rates;
  select count(*) into a_set from public.surcharge_settings;
  select count(*) into a_quote from public.quotes;
  select count(*) into a_org2_zone from public.zones where organization_id = o2;
  begin insert into public.zones (organization_id, name) values (o2, 'Hack'); a_ins_other := 'ok';
  exception when others then a_ins_other := sqlstate; end;
  update public.surcharge_settings set fuel_share_bp = 1 where organization_id = o2;
  get diagnostics a_org2_set = row_count;
  update public.surcharge_settings set fuel_share_bp = 2500 where organization_id = o1;
  get diagnostics a_own_set = row_count;
  begin insert into public.quotes (organization_id, zone_name, vehicle_type_name, service_date, rate_cents, base_diesel_cents,
          reference_monday, current_diesel_cents, fuel_share_bp, lag_days, threshold_bp, floor_at_zero, change_bp, surcharge_bp,
          reason, surcharge_cents, total_cents, engine_version)
        values (o1, 'Brussels', 'Van', '2026-10-09', 33333, 124460, '2026-09-28', 153470, 2110, 7, 0, false, 2331, 492, 'APPLIED', 1640, 34973, 'x');
        a_ins_quote := 'ok';
  exception when others then a_ins_quote := sqlstate; end;
  begin perform 1 from public.platform_admins; a_admins := 'ok';
  exception when others then a_admins := sqlstate; end;
  begin insert into public.rates (organization_id, zone_id, vehicle_type_id, base_rate_cents) values (o1, z2, v1, 100); a_cross := 'ok';
  exception when others then a_cross := sqlstate; end;
  execute 'reset role';
  res := res || (case when a_org = 1 and a_zone = 1 and a_rate = 1 and a_set = 1 and a_quote = 1 then 'PASS ' else 'FAIL ' end || 'A (owner) sees exactly their own carrier, zone, rate, settings and quote');
  res := res || (case when a_org2_zone = 0 then 'PASS ' else 'FAIL ' end || 'A sees nothing of the other carrier');
  res := res || (case when a_ins_other = '42501' then 'PASS ' else 'FAIL ' end || 'A cannot create a zone at another carrier');
  res := res || (case when a_org2_set = 0 then 'PASS ' else 'FAIL ' end || 'A cannot change another carrier''s settings (0 rows touched)');
  res := res || (case when a_own_set = 1 then 'PASS ' else 'FAIL ' end || 'A can change their own settings');
  res := res || (case when a_ins_quote = '42501' then 'PASS ' else 'FAIL ' end || 'A cannot insert a quote from the browser');
  res := res || (case when a_admins = '42501' then 'PASS ' else 'FAIL ' end || 'A cannot read platform_admins');
  res := res || (case when a_cross = '23503' then 'PASS ' else 'FAIL ' end || 'A cannot build a rate from another carrier''s zone (foreign key)');

  ---------------------------------------------------------------- B: staff at Alpha Transport
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', uB, 'role', 'authenticated')::text, true);
  select count(*) into b_zone from public.zones;
  select count(*) into b_quote from public.quotes;
  begin insert into public.zones (organization_id, name) values (o1, 'Liege'); b_ins := 'ok';
  exception when others then b_ins := sqlstate; end;
  update public.rates set base_rate_cents = 1 where organization_id = o1;
  get diagnostics b_rate_upd = row_count;
  execute 'reset role';
  res := res || (case when b_zone = 1 and b_quote = 1 then 'PASS ' else 'FAIL ' end || 'B (staff) can read zones and quotes of their carrier');
  res := res || (case when b_ins = '42501' then 'PASS ' else 'FAIL ' end || 'B (staff) cannot create zones');
  res := res || (case when b_rate_upd = 0 then 'PASS ' else 'FAIL ' end || 'B (staff) cannot change rates (0 rows touched)');

  ---------------------------------------------------------------- C: owner of Beta Express
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', uC, 'role', 'authenticated')::text, true);
  select count(*) into c_org from public.organizations;
  select count(*) into c_zone from public.zones;
  select count(*) into c_quote from public.quotes;
  select count(*) into c_org1_zone from public.zones where organization_id = o1;
  execute 'reset role';
  res := res || (case when c_org = 1 and c_zone = 1 and c_quote = 1 and c_org1_zone = 0 then 'PASS ' else 'FAIL ' end || 'C sees only Beta Express and nothing of Alpha Transport');

  ---------------------------------------------------------------- D: signed in, no carrier
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', uD, 'role', 'authenticated')::text, true);
  select count(*) into d_org from public.organizations;
  select count(*) into d_zone from public.zones;
  select count(*) into d_quote from public.quotes;
  select count(*) into d_fuel from public.fuel_prices;
  execute 'reset role';
  res := res || (case when d_org = 0 and d_zone = 0 and d_quote = 0 then 'PASS ' else 'FAIL ' end || 'D (signed in, no carrier) sees no carrier data');
  res := res || (case when d_fuel >= 1 then 'PASS ' else 'FAIL ' end || 'D can read the shared diesel prices');

  ---------------------------------------------------------------- P: platform admin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', uP, 'role', 'authenticated')::text, true);
  select count(*) into p_org from public.organizations;
  begin insert into public.fuel_prices (monday, price_cents) values ('2026-10-05', 190000); p_ins := 'ok';
  exception when others then p_ins := sqlstate; end;
  begin insert into public.fuel_prices (monday, price_cents) values ('2026-10-06', 190000); p_bad := 'ok';
  exception when others then p_bad := sqlstate; end;
  begin delete from public.fuel_prices; p_del := 'ok';
  exception when others then p_del := sqlstate; end;
  begin perform 1 from public.platform_admins; p_admins := 'ok';
  exception when others then p_admins := sqlstate; end;
  execute 'reset role';
  res := res || (case when p_org = 0 then 'PASS ' else 'FAIL ' end || 'P (platform admin) has no automatic view into any carrier''s data');
  res := res || (case when p_ins = 'ok' and (select entered_by from public.fuel_prices where monday = '2026-10-05') = uP then 'PASS ' else 'FAIL ' end || 'P can publish a diesel price and it records who entered it');
  res := res || (case when p_bad = '23514' then 'PASS ' else 'FAIL ' end || 'P cannot publish a price dated a Tuesday');
  res := res || (case when p_del = '42501' then 'PASS ' else 'FAIL ' end || 'P cannot delete diesel prices');
  res := res || (case when p_admins = '42501' then 'PASS ' else 'FAIL ' end || 'P cannot read platform_admins through the API');

  ---------------------------------------------------------------- the server (service role)
  execute 'set local role service_role';
  select count(*) into s_quotes from public.quotes;
  begin update public.quotes set customer_reference = 'x'; s_upd := 'ok'; exception when others then s_upd := sqlstate; end;
  begin insert into public.quotes (organization_id, zone_name, vehicle_type_name, service_date, rate_cents, base_diesel_cents,
          reference_monday, current_diesel_cents, fuel_share_bp, lag_days, threshold_bp, floor_at_zero, change_bp, surcharge_bp,
          reason, surcharge_cents, total_cents, engine_version)
        values (o1, 'Brussels', 'Van', '2026-10-09', 33333, 124460, '2026-09-28', 153470, 2110, 7, 0, false, 2331, 492, 'APPLIED', 1640, 34974, 'x');
        s_bad := 'ok';
  exception when others then s_bad := sqlstate; end;
  execute 'reset role';
  res := res || (case when s_quotes = 2 then 'PASS ' else 'FAIL ' end || 'the server (service role) can read every carrier''s quotes');
  res := res || (case when s_upd = '55000' then 'PASS ' else 'FAIL ' end || 'a stored quote cannot be altered, even by the server');
  res := res || (case when s_bad = '23514' then 'PASS ' else 'FAIL ' end || 'a quote whose total is one cent off is refused by the live database');

  ---------------------------------------------------------------- report, then roll everything back
  raise exception E'LIVE_CHECK_RESULTS\n%\nTOTAL %   PASSED %   FAILED %',
    array_to_string(res, E'\n'),
    cardinality(res),
    (select count(*) from unnest(res) x where x like 'PASS%'),
    (select count(*) from unnest(res) x where x like 'FAIL%');
end $$;
