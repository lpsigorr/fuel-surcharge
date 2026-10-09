-- schema_and_security.test.sql
-- LOCAL TESTING ONLY. Run by run-local.sh after the stub, the harness and the migration.
-- Checks the data rules (constraints) and the security rules (who can see and change what).
--
-- Cast of characters:
--   A  owner of Alpha Transport (org1)        B  staff at Alpha Transport (org1)
--   C  owner of Beta Express (org2)           D  signed in, belongs to no carrier
--   P  Manifest platform admin, belongs to no carrier
--   org3 Gamma Freight, no members, no data

-- ---------------------------------------------------------------------------
-- Seed (as database owner)
-- ---------------------------------------------------------------------------
insert into t.ids (label, id)
select l, gen_random_uuid()
from unnest(array['A','B','C','D','P','org1','org2','org3','z_bru','z_ant','z_gent','z_tmp','v_van','v_truck','v_van2']) as l;

insert into auth.users (id) select id from t.ids where label in ('A','B','C','D','P');
insert into public.platform_admins (user_id) values (t.id('P'));

insert into public.organizations (id, name) values
  (t.id('org1'), 'Alpha Transport'), (t.id('org2'), 'Beta Express'), (t.id('org3'), 'Gamma Freight');
insert into public.memberships (organization_id, user_id, role) values
  (t.id('org1'), t.id('A'), 'owner'), (t.id('org1'), t.id('B'), 'staff'), (t.id('org2'), t.id('C'), 'owner');

insert into public.surcharge_settings (organization_id, fuel_share_bp, lag_days, threshold_bp, floor_at_zero, base_diesel_cents) values
  (t.id('org1'), 2000, 7, 0, false, 150000),
  (t.id('org2'), 2500, 7, 500, true, 140000);

insert into public.zones (id, organization_id, name) values
  (t.id('z_bru'), t.id('org1'), 'Brussels'), (t.id('z_ant'), t.id('org1'), 'Antwerp'), (t.id('z_gent'), t.id('org2'), 'Ghent');
insert into public.vehicle_types (id, organization_id, name) values
  (t.id('v_van'), t.id('org1'), 'Van'), (t.id('v_truck'), t.id('org1'), 'Truck'), (t.id('v_van2'), t.id('org2'), 'Van');
insert into public.rates (organization_id, zone_id, vehicle_type_id, base_rate_cents) values
  (t.id('org1'), t.id('z_bru'), t.id('v_van'), 12000),  (t.id('org1'), t.id('z_bru'), t.id('v_truck'), 25000),
  (t.id('org1'), t.id('z_ant'), t.id('v_van'), 15000),  (t.id('org1'), t.id('z_ant'), t.id('v_truck'), 30000),
  (t.id('org2'), t.id('z_gent'), t.id('v_van2'), 11000);

insert into public.fuel_prices (monday, price_cents) values
  ('2026-09-21', 148000), ('2026-09-28', 165000), ('2026-10-05', 190000);

-- Two real quotes, stored the way the server would store them (service role bypasses RLS).
-- org1: Febetra 2022 price levels. org2: floor-at-zero carrier with a 5 % threshold, diesel up 17.86 %.
insert into public.quotes
  (organization_id, source, zone_name, vehicle_type_name, service_date, rate_cents, base_diesel_cents,
   reference_monday, current_diesel_cents, fuel_share_bp, lag_days, threshold_bp, floor_at_zero,
   change_bp, surcharge_bp, reason, surcharge_cents, total_cents, engine_version)
values
  (t.id('org1'), 'staff', 'Brussels', 'Van', '2026-10-09', 33333, 124460, '2026-09-28', 153470, 2110, 7, 0, false,
   2331, 492, 'APPLIED', 1640, 34973, 'test'),
  (t.id('org2'), 'staff', 'Ghent', 'Van', '2026-10-09', 11000, 140000, '2026-09-28', 165000, 2500, 7, 500, true,
   1786, 446, 'APPLIED', 491, 11491, 'test');

-- ---------------------------------------------------------------------------
-- 1. Structure and privileges
-- ---------------------------------------------------------------------------
do $$
declare
  tbl text;
  tbls text[] := array['organizations','memberships','platform_admins','fuel_prices','surcharge_settings','zones','vehicle_types','rates','quotes'];
begin
  perform t.check('the 9 expected tables exist',
    (select count(*) from pg_tables where schemaname = 'public' and tablename = any (tbls)) = 9);
  perform t.check('no other table exists in public',
    not exists (select 1 from pg_tables where schemaname = 'public' and tablename <> all (tbls)));
  perform t.check('row level security is switched on for every table in public',
    not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity));

  foreach tbl in array tbls loop
    perform t.check('anon has no privilege at all on ' || tbl,
      not has_table_privilege('anon', 'public.' || tbl, 'select,insert,update,delete,truncate,references,trigger')
      and not has_any_column_privilege('anon', 'public.' || tbl, 'select,insert,update,references'));
  end loop;

  perform t.check('signed-in users hold exactly the intended table privileges and no others', (
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
       and not exists (select * from actual except select * from expected)));

  perform t.check('signed-in users may change only the name column of organizations',
    has_column_privilege('authenticated', 'public.organizations', 'name', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.organizations', 'id', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.organizations', 'created_at', 'UPDATE'));
  perform t.check('platform_admins has no policy and no grant (invisible through the API)',
    not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'platform_admins'));
  perform t.check('quotes has a select policy and nothing else',
    (select array_agg(cmd order by cmd) from pg_policies where schemaname = 'public' and tablename = 'quotes') = array['SELECT']);
  perform t.check('fuel_prices has no delete policy',
    not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'fuel_prices' and cmd in ('DELETE', 'ALL')));
end $$;

-- ---------------------------------------------------------------------------
-- 2. Data rules (constraints)
-- ---------------------------------------------------------------------------
do $$
declare old_ts timestamptz;
begin
  perform t.check('fuel price dated a Tuesday is rejected',
    t.try($q$insert into public.fuel_prices (monday, price_cents) values ('2026-09-29', 150000)$q$) = '23514');
  perform t.check('fuel price of 0 is rejected',
    t.try($q$insert into public.fuel_prices (monday, price_cents) values ('2026-10-12', 0)$q$) = '23514');
  perform t.check('a second price for the same Monday is rejected',
    t.try($q$insert into public.fuel_prices (monday, price_cents) values ('2026-09-28', 170000)$q$) = '23505');
  perform t.check('a valid Monday price is accepted',
    t.try_rb($q$insert into public.fuel_prices (monday, price_cents) values ('2026-10-12', 191000)$q$) = 'ok');

  perform t.check('fuel share above 100 % is rejected',
    t.try(format('insert into public.surcharge_settings (organization_id, fuel_share_bp, base_diesel_cents) values (%L, 10001, 150000)', t.id('org3'))) = '23514');
  perform t.check('negative fuel share is rejected',
    t.try(format('insert into public.surcharge_settings (organization_id, fuel_share_bp, base_diesel_cents) values (%L, -1, 150000)', t.id('org3'))) = '23514');
  perform t.check('base diesel price of 0 is rejected',
    t.try(format('insert into public.surcharge_settings (organization_id, fuel_share_bp, base_diesel_cents) values (%L, 2000, 0)', t.id('org3'))) = '23514');
  perform t.check('negative lag is rejected',
    t.try(format('insert into public.surcharge_settings (organization_id, fuel_share_bp, base_diesel_cents, lag_days) values (%L, 2000, 150000, -1)', t.id('org3'))) = '23514');
  perform t.check('valid settings are accepted, with lag 7, threshold 0 and credits allowed by default',
    t.try_rb(format('insert into public.surcharge_settings (organization_id, fuel_share_bp, base_diesel_cents) values (%L, 2000, 150000)', t.id('org3'))) = 'ok');

  perform t.check('a blank zone name is rejected',
    t.try(format('insert into public.zones (organization_id, name) values (%L, %L)', t.id('org1'), '   ')) = '23514');
  perform t.check('the same zone name in another case is rejected within one carrier',
    t.try(format('insert into public.zones (organization_id, name) values (%L, %L)', t.id('org1'), ' brussels ')) = '23505');
  perform t.check('the same zone name is allowed at a different carrier',
    t.try_rb(format('insert into public.zones (organization_id, name) values (%L, %L)', t.id('org2'), 'Brussels')) = 'ok');
  perform t.check('the same vehicle type name in another case is rejected within one carrier',
    t.try(format('insert into public.vehicle_types (organization_id, name) values (%L, %L)', t.id('org1'), 'VAN')) = '23505');

  perform t.check('a negative base rate is rejected',
    t.try(format('update public.rates set base_rate_cents = -1 where zone_id = %L', t.id('z_bru'))) = '23514');
  perform t.check('a rate cannot point at another carrier''s zone',
    t.try(format('insert into public.rates (organization_id, zone_id, vehicle_type_id, base_rate_cents) values (%L, %L, %L, 100)', t.id('org1'), t.id('z_gent'), t.id('v_van'))) = '23503');
  perform t.check('a rate cannot point at another carrier''s vehicle type',
    t.try(format('insert into public.rates (organization_id, zone_id, vehicle_type_id, base_rate_cents) values (%L, %L, %L, 100)', t.id('org1'), t.id('z_bru'), t.id('v_van2'))) = '23503');
  insert into public.zones (id, organization_id, name) values (t.id('z_tmp'), t.id('org1'), 'Temporary zone');
  insert into public.rates (organization_id, zone_id, vehicle_type_id, base_rate_cents)
    values (t.id('org1'), t.id('z_tmp'), t.id('v_van'), 100), (t.id('org1'), t.id('z_tmp'), t.id('v_truck'), 200);
  perform t.check('the temporary zone starts with 2 rates',
    (select count(*) from public.rates where zone_id = t.id('z_tmp')) = 2);
  delete from public.zones where id = t.id('z_tmp');
  perform t.check('deleting a zone removes its rates',
    (select count(*) from public.rates where zone_id = t.id('z_tmp')) = 0);

  perform t.check('a membership role other than owner or staff is rejected',
    t.try(format('insert into public.memberships (organization_id, user_id, role) values (%L, %L, %L)', t.id('org1'), t.id('D'), 'admin')) = '23514');
  perform t.check('the same user cannot join the same carrier twice',
    t.try(format('insert into public.memberships (organization_id, user_id, role) values (%L, %L, %L)', t.id('org1'), t.id('A'), 'staff')) = '23505');

  select updated_at into old_ts from public.surcharge_settings where organization_id = t.id('org1');
  perform pg_sleep(0.02);
  update public.surcharge_settings set fuel_share_bp = 2000 where organization_id = t.id('org1');
  perform t.check('updating settings refreshes updated_at',
    (select updated_at from public.surcharge_settings where organization_id = t.id('org1')) > old_ts);
end $$;

-- ---------------------------------------------------------------------------
-- 3. Quotes: the database re-checks the maths
-- ---------------------------------------------------------------------------
do $$
begin
  perform t.check('the two seeded quotes were accepted', (select count(*) from public.quotes) = 2);
  perform t.check('Febetra-level quote (+23.31 %, 4.92 %, EUR 16.40, total EUR 349.73) is accepted',
    t.try_quote() = 'ok');
  perform t.check('a credit when diesel falls is accepted (-0.27 %, EUR -0.90)',
    t.try_quote('{"service_date":"2026-09-30","reference_monday":"2026-09-21","base_diesel_cents":150000,"current_diesel_cents":148000,"fuel_share_bp":2000,"change_bp":-133,"surcharge_bp":-27,"surcharge_cents":-90,"total_cents":33243}') = 'ok');
  perform t.check('the same fall with credits switched off is accepted only as a zero surcharge',
    t.try_quote('{"service_date":"2026-09-30","reference_monday":"2026-09-21","base_diesel_cents":150000,"current_diesel_cents":148000,"fuel_share_bp":2000,"floor_at_zero":true,"change_bp":-133,"surcharge_bp":0,"reason":"FLOORED_AT_ZERO","surcharge_cents":0,"total_cents":33333}') = 'ok');
  perform t.check('credits switched off but a credit stored is rejected',
    t.try_quote('{"service_date":"2026-09-30","reference_monday":"2026-09-21","base_diesel_cents":150000,"current_diesel_cents":148000,"fuel_share_bp":2000,"floor_at_zero":true,"change_bp":-133,"surcharge_bp":-27,"surcharge_cents":-90,"total_cents":33243}') = '23514');
  perform t.check('below-threshold quote is accepted only as a zero surcharge',
    t.try_quote('{"threshold_bp":3000,"surcharge_bp":0,"reason":"BELOW_THRESHOLD","surcharge_cents":0,"total_cents":33333}') = 'ok');
  perform t.check('a surcharge stored although the change is below the threshold is rejected',
    t.try_quote('{"threshold_bp":3000}') = '23514');
  perform t.check('exactly at the threshold (+5.00 % vs 5.00 %) the surcharge applies to the whole change',
    t.try_quote('{"base_diesel_cents":150000,"current_diesel_cents":157500,"fuel_share_bp":2000,"threshold_bp":500,"change_bp":500,"surcharge_bp":100,"surcharge_cents":333,"total_cents":33666}') = 'ok');
  perform t.check('just under the threshold (+4.9993 %, shown as 5.00 %) only a zero surcharge is accepted',
    t.try_quote('{"base_diesel_cents":150000,"current_diesel_cents":157499,"fuel_share_bp":2000,"threshold_bp":500,"change_bp":500,"surcharge_bp":0,"reason":"BELOW_THRESHOLD","surcharge_cents":0,"total_cents":33333}') = 'ok');
  perform t.check('just under the threshold, a stored surcharge is rejected',
    t.try_quote('{"base_diesel_cents":150000,"current_diesel_cents":157499,"fuel_share_bp":2000,"threshold_bp":500,"change_bp":500,"surcharge_bp":100,"surcharge_cents":333,"total_cents":33666}') = '23514');
  perform t.check('tie rounds away from zero upward (+0.5 bp -> 1 bp)',
    t.try_quote('{"rate_cents":20000,"base_diesel_cents":200000,"current_diesel_cents":200040,"fuel_share_bp":2500,"change_bp":2,"surcharge_bp":1,"surcharge_cents":2,"total_cents":20002}') = 'ok');
  perform t.check('tie rounds away from zero downward (-0.5 bp -> -1 bp)',
    t.try_quote('{"rate_cents":20000,"base_diesel_cents":200000,"current_diesel_cents":199960,"fuel_share_bp":2500,"change_bp":-2,"surcharge_bp":-1,"surcharge_cents":-2,"total_cents":19998}') = 'ok');
  perform t.check('a tie rounded the wrong way is rejected',
    t.try_quote('{"rate_cents":20000,"base_diesel_cents":200000,"current_diesel_cents":200040,"fuel_share_bp":2500,"change_bp":2,"surcharge_bp":0,"surcharge_cents":0,"total_cents":20000}') = '23514');

  perform t.check('a total that is off by one cent is rejected',
    t.try_quote('{"total_cents":34974}') = '23514');
  perform t.check('a wrong surcharge amount with a matching total is rejected',
    t.try_quote('{"surcharge_cents":1641,"total_cents":34974}') = '23514');
  perform t.check('a wrong surcharge percentage with matching amounts is rejected',
    t.try_quote('{"surcharge_bp":493,"surcharge_cents":1643,"total_cents":34976}') = '23514');
  perform t.check('a wrong diesel change percentage is rejected',
    t.try_quote('{"change_bp":2330}') = '23514');
  perform t.check('a wrong reason is rejected',
    t.try_quote('{"reason":"BELOW_THRESHOLD"}') = '23514');
  perform t.check('a reference Monday that does not follow from service date and lag is rejected',
    t.try_quote('{"reference_monday":"2026-09-21"}') = '23514');
  perform t.check('a lag that moves the reference to the previous Monday is rejected',
    t.try_quote('{"lag_days":12}') = '23514');
  perform t.check('a negative total is rejected',
    t.try_quote('{"total_cents":-1}') = '23514');
  perform t.check('a fuel share above 100 % is rejected',
    t.try_quote('{"fuel_share_bp":10001}') = '23514');
  perform t.check('a quote for a carrier that does not exist is rejected',
    t.try_quote(jsonb_build_object('organization_id', gen_random_uuid())) = '23503');
  perform t.check('an unknown quote source is rejected',
    t.try_quote('{"source":"fax"}') = '23514');

  perform t.check('a quote cannot be changed, even by the database owner',
    t.try(format('update public.quotes set customer_reference = ''x'' where organization_id = %L', t.id('org1'))) = '55000');

  perform t.check('reference_monday() agrees with the 11 cases in surcharge.test.mjs', (
    with c(service_date, lag, expected) as (values
      ('2026-10-09'::date, 7, '2026-09-28'::date), ('2026-10-11', 7, '2026-09-28'), ('2026-10-12', 7, '2026-10-05'),
      ('2026-10-05', 0, '2026-10-05'), ('2026-10-11', 0, '2026-10-05'), ('2026-10-04', 0, '2026-09-28'),
      ('2026-01-05', 7, '2025-12-29'), ('2026-01-01', 7, '2025-12-22'),
      ('2024-03-04', 7, '2024-02-26'), ('2024-03-03', 7, '2024-02-19'), ('2024-02-29', 0, '2024-02-26'))
    select bool_and(private.reference_monday(service_date, lag) = expected) from c));
end $$;

-- ---------------------------------------------------------------------------
-- 4. Security: A, owner of Alpha Transport (org1)
-- ---------------------------------------------------------------------------
do $$
declare
  n_org bigint; n_mem bigint; n_zone bigint; n_veh bigint; n_rate bigint; n_set bigint; n_quote bigint; n_fuel bigint;
  n_org2_zone bigint; n_org2_quote bigint; n_admins bigint;
  r_zone_other text; r_zone_own text; r_set_other bigint; r_set_own bigint; r_name_own bigint; r_name_other bigint;
  r_id_change bigint; r_org_delete bigint; r_join text; r_role bigint; r_fuel_ins text; r_fuel_del bigint;
  r_rate_cross text; r_rate_edit bigint; r_quote_ins text; r_quote_upd bigint; r_quote_del bigint; r_helper text;
begin
  perform t.as_user(t.id('A'));
  n_org   := t.count('select * from public.organizations');
  n_mem   := t.count('select * from public.memberships');
  n_zone  := t.count('select * from public.zones');
  n_veh   := t.count('select * from public.vehicle_types');
  n_rate  := t.count('select * from public.rates');
  n_set   := t.count('select * from public.surcharge_settings');
  n_quote := t.count('select * from public.quotes');
  n_fuel  := t.count('select * from public.fuel_prices');
  n_admins := t.count('select * from public.platform_admins');
  n_org2_zone  := t.count(format('select * from public.zones where organization_id = %L', t.id('org2')));
  n_org2_quote := t.count(format('select * from public.quotes where organization_id = %L', t.id('org2')));
  r_zone_other := t.try(format('insert into public.zones (organization_id, name) values (%L, %L)', t.id('org2'), 'Hack'));
  r_zone_own   := t.try_rb(format('insert into public.zones (organization_id, name) values (%L, %L)', t.id('org1'), 'Liege'));
  r_set_other  := t.affected(format('update public.surcharge_settings set fuel_share_bp = 1 where organization_id = %L', t.id('org2')));
  r_set_own    := t.affected_rb(format('update public.surcharge_settings set fuel_share_bp = 2500 where organization_id = %L', t.id('org1')));
  r_name_own   := t.affected_rb(format('update public.organizations set name = ''Alpha Transport NV'' where id = %L', t.id('org1')));
  r_name_other := t.affected(format('update public.organizations set name = ''Hacked'' where id = %L', t.id('org2')));
  r_id_change  := t.affected(format('update public.organizations set id = gen_random_uuid() where id = %L', t.id('org1')));
  r_org_delete := t.affected(format('delete from public.organizations where id = %L', t.id('org1')));
  r_join       := t.try(format('insert into public.memberships (organization_id, user_id, role) values (%L, %L, %L)', t.id('org2'), t.id('A'), 'owner'));
  r_role       := t.affected(format('update public.memberships set role = ''staff'' where user_id = %L', t.id('A')));
  r_fuel_ins   := t.try('insert into public.fuel_prices (monday, price_cents) values (''2026-10-19'', 1)');
  r_fuel_del   := t.affected('delete from public.fuel_prices');
  r_rate_cross := t.try(format('insert into public.rates (organization_id, zone_id, vehicle_type_id, base_rate_cents) values (%L, %L, %L, 100)', t.id('org1'), t.id('z_gent'), t.id('v_van')));
  r_rate_edit  := t.affected_rb(format('update public.rates set base_rate_cents = 13000 where zone_id = %L and vehicle_type_id = %L', t.id('z_bru'), t.id('v_van')));
  r_quote_ins  := t.try_quote();
  r_quote_upd  := t.affected('update public.quotes set customer_reference = ''x''');
  r_quote_del  := t.affected('delete from public.quotes');
  r_helper     := t.try(format('select private.is_member(%L)', t.id('org1')));
  perform t.back();

  perform t.check('A sees exactly one carrier: their own', n_org = 1);
  perform t.check('A sees the two members of their carrier', n_mem = 2);
  perform t.check('A sees their 2 zones, 2 vehicle types, 4 rates, 1 settings row and 1 quote',
    n_zone = 2 and n_veh = 2 and n_rate = 4 and n_set = 1 and n_quote = 1);
  perform t.check('A can read the shared diesel prices', n_fuel >= 3);
  perform t.check('A cannot read platform_admins at all', n_admins = -1);
  perform t.check('A sees none of the other carrier''s zones or quotes', n_org2_zone = 0 and n_org2_quote = 0);
  perform t.check('A cannot create a zone at another carrier (row level security)', r_zone_other = '42501');
  perform t.check('A can create a zone at their own carrier', r_zone_own = 'ok');
  perform t.check('A cannot change another carrier''s settings (0 rows touched)', r_set_other = 0);
  perform t.check('A can change their own settings', r_set_own = 1);
  perform t.check('A can rename their own carrier', r_name_own = 1);
  perform t.check('A cannot rename another carrier (0 rows touched)', r_name_other = 0);
  perform t.check('A cannot change a carrier id (no privilege)', r_id_change = -1);
  perform t.check('A cannot delete a carrier (no privilege)', r_org_delete = -1);
  perform t.check('A cannot add themselves to another carrier (no privilege)', r_join = '42501');
  perform t.check('A cannot change roles through the API (no privilege)', r_role = -1);
  perform t.check('A cannot publish diesel prices (not a platform admin)', r_fuel_ins = '42501');
  perform t.check('A cannot delete diesel prices (no privilege)', r_fuel_del = -1);
  perform t.check('A cannot build a rate from another carrier''s zone (foreign key)', r_rate_cross = '23503');
  perform t.check('A can edit their own rates', r_rate_edit = 1);
  perform t.check('A cannot insert a quote from the browser (no privilege)', r_quote_ins = '42501');
  perform t.check('A cannot update a quote (no privilege)', r_quote_upd = -1);
  perform t.check('A cannot delete a quote (no privilege)', r_quote_del = -1);
  perform t.check('A can still evaluate the helper function used by policies', r_helper = 'ok');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Security: B (staff), C (other carrier), D (no carrier), P (platform admin)
-- ---------------------------------------------------------------------------
do $$
declare
  b_zone bigint; b_quote bigint; b_set bigint; b_ins text; b_rate_upd bigint; b_set_upd bigint; b_zone_del bigint; b_name bigint;
  c_org bigint; c_zone bigint; c_quote bigint; c_org1_set bigint; c_org1_zone bigint;
  d_org bigint; d_mem bigint; d_zone bigint; d_rate bigint; d_set bigint; d_quote bigint; d_fuel bigint;
  p_org bigint; p_zone bigint; p_quote bigint; p_admins bigint; p_ins text; p_upd bigint; p_del bigint; p_bad text;
begin
  perform t.as_user(t.id('B'));
  b_zone := t.count('select * from public.zones');
  b_quote := t.count('select * from public.quotes');
  b_set := t.count('select * from public.surcharge_settings');
  b_ins := t.try(format('insert into public.zones (organization_id, name) values (%L, %L)', t.id('org1'), 'Liege'));
  b_rate_upd := t.affected(format('update public.rates set base_rate_cents = 1 where organization_id = %L', t.id('org1')));
  b_set_upd := t.affected(format('update public.surcharge_settings set fuel_share_bp = 1 where organization_id = %L', t.id('org1')));
  b_zone_del := t.affected(format('delete from public.zones where organization_id = %L', t.id('org1')));
  b_name := t.affected(format('update public.organizations set name = ''x'' where id = %L', t.id('org1')));
  perform t.back();
  perform t.check('B (staff) can read zones, settings and quotes of their carrier', b_zone = 2 and b_set = 1 and b_quote = 1);
  perform t.check('B (staff) cannot create zones', b_ins = '42501');
  perform t.check('B (staff) cannot change rates (0 rows touched)', b_rate_upd = 0);
  perform t.check('B (staff) cannot change settings (0 rows touched)', b_set_upd = 0);
  perform t.check('B (staff) cannot delete zones (0 rows touched)', b_zone_del = 0);
  perform t.check('B (staff) cannot rename the carrier (0 rows touched)', b_name = 0);

  perform t.as_user(t.id('C'));
  c_org := t.count('select * from public.organizations');
  c_zone := t.count('select * from public.zones');
  c_quote := t.count('select * from public.quotes');
  c_org1_zone := t.count(format('select * from public.zones where organization_id = %L', t.id('org1')));
  c_org1_set := t.affected(format('update public.surcharge_settings set fuel_share_bp = 1 where organization_id = %L', t.id('org1')));
  perform t.back();
  perform t.check('C sees only their own carrier, zone and quote', c_org = 1 and c_zone = 1 and c_quote = 1);
  perform t.check('C sees nothing of Alpha Transport', c_org1_zone = 0);
  perform t.check('C cannot change Alpha Transport''s settings (0 rows touched)', c_org1_set = 0);

  perform t.as_user(t.id('D'));
  d_org := t.count('select * from public.organizations');
  d_mem := t.count('select * from public.memberships');
  d_zone := t.count('select * from public.zones');
  d_rate := t.count('select * from public.rates');
  d_set := t.count('select * from public.surcharge_settings');
  d_quote := t.count('select * from public.quotes');
  d_fuel := t.count('select * from public.fuel_prices');
  perform t.back();
  perform t.check('D (signed in, no carrier) sees no carrier data at all',
    d_org = 0 and d_mem = 0 and d_zone = 0 and d_rate = 0 and d_set = 0 and d_quote = 0);
  perform t.check('D can read the shared diesel prices', d_fuel >= 3);

  perform t.as_user(t.id('P'));
  p_org := t.count('select * from public.organizations');
  p_zone := t.count('select * from public.zones');
  p_quote := t.count('select * from public.quotes');
  p_admins := t.count('select * from public.platform_admins');
  p_ins := t.try('insert into public.fuel_prices (monday, price_cents) values (''2026-10-19'', 192000)');
  p_upd := t.affected_rb('update public.fuel_prices set price_cents = 149000 where monday = ''2026-09-21''');
  p_del := t.affected('delete from public.fuel_prices');
  p_bad := t.try('insert into public.fuel_prices (monday, price_cents) values (''2026-10-20'', 192000)');
  perform t.back();
  perform t.check('P (platform admin) has no automatic view into any carrier''s data', p_org = 0 and p_zone = 0 and p_quote = 0);
  perform t.check('P cannot read platform_admins through the API', p_admins = -1);
  perform t.check('P can publish a diesel price', p_ins = 'ok');
  perform t.check('the price P published records who entered it',
    (select entered_by from public.fuel_prices where monday = '2026-10-19') = t.id('P'));
  perform t.check('P can correct an existing diesel price', p_upd = 1);
  perform t.check('P cannot delete diesel prices (no privilege)', p_del = -1);
  perform t.check('P still cannot publish a price dated a Tuesday', p_bad = '23514');
end $$;

-- ---------------------------------------------------------------------------
-- 6. Security: not signed in (anon) and the server (service role)
-- ---------------------------------------------------------------------------
do $$
declare
  tbl text;
  tbls text[] := array['organizations','memberships','platform_admins','fuel_prices','surcharge_settings','zones','vehicle_types','rates','quotes'];
  res jsonb := '{}'::jsonb; anon_ins text; anon_helper text; anon_fuel_ins text;
  s_org bigint; s_quote bigint; s_admins bigint; s_ins text; s_upd text; s_zone_ins text;
begin
  perform t.as_anon();
  foreach tbl in array tbls loop
    res := res || jsonb_build_object(tbl, t.count('select * from public.' || tbl));
  end loop;
  anon_ins := t.try(format('insert into public.zones (organization_id, name) values (%L, %L)', t.id('org1'), 'Hack'));
  anon_fuel_ins := t.try('insert into public.fuel_prices (monday, price_cents) values (''2026-10-26'', 1)');
  anon_helper := t.try(format('select private.is_member(%L)', t.id('org1')));
  perform t.back();
  foreach tbl in array tbls loop
    perform t.check('anon is refused when reading ' || tbl, (res ->> tbl)::bigint = -1);
  end loop;
  perform t.check('anon cannot create a zone', anon_ins = '42501');
  perform t.check('anon cannot publish a diesel price', anon_fuel_ins = '42501');
  perform t.check('anon cannot call the private helper functions', anon_helper = '42501');

  perform t.as_service();
  s_org := t.count('select * from public.organizations');
  s_quote := t.count('select * from public.quotes');
  s_admins := t.count('select * from public.platform_admins');
  s_ins := t.try_quote();
  s_upd := t.try('update public.quotes set customer_reference = ''x''');
  s_zone_ins := t.try_rb(format('insert into public.zones (organization_id, name) values (%L, %L)', t.id('org3'), 'Test zone'));
  perform t.back();
  perform t.check('the server (service role) can read every carrier and every quote', s_org = 3 and s_quote = 2);
  perform t.check('the server can read platform_admins', s_admins = 1);
  perform t.check('the server can store a valid quote', s_ins = 'ok');
  perform t.check('the server cannot alter a stored quote either', s_upd = '55000');
  perform t.check('the server can write carrier data', s_zone_ins = 'ok');
end $$;

-- ---------------------------------------------------------------------------
-- 7. Access follows membership immediately
-- ---------------------------------------------------------------------------
do $$
declare before_n bigint; after_n bigint; restored_n bigint;
begin
  perform t.as_user(t.id('B'));
  before_n := t.count('select * from public.zones');
  perform t.back();

  delete from public.memberships where organization_id = t.id('org1') and user_id = t.id('B');
  perform t.as_user(t.id('B'));
  after_n := t.count('select * from public.zones');
  perform t.back();

  insert into public.memberships (organization_id, user_id, role) values (t.id('org1'), t.id('B'), 'staff');
  perform t.as_user(t.id('B'));
  restored_n := t.count('select * from public.zones');
  perform t.back();

  perform t.check('removing a membership removes access at once, and restoring it brings access back',
    before_n = 2 and after_n = 0 and restored_n = 2);
end $$;

-- ---------------------------------------------------------------------------
-- Report
-- ---------------------------------------------------------------------------
select format('%s  %s', case when ok then 'PASS' else 'FAIL' end, name) as result from t.results order by id;
select format('TOTAL %s   PASSED %s   FAILED %s', count(*), count(*) filter (where ok), count(*) filter (where not ok)) as summary from t.results;
do $$
begin
  if exists (select 1 from t.results where not ok) then
    raise exception 'SOME TESTS FAILED';
  end if;
end $$;
