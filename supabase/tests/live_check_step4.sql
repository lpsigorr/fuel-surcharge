-- live_check_step4.sql
-- Safe-to-run check of the Step 4 diesel price entry on the REAL Supabase project (and on the local test database).
-- Like live_check.sql: everything happens inside one DO block that ends by raising an error, so ALL test data is
-- rolled back and nothing is left behind. The results are printed in that error message ("LIVE_CHECK_STEP4_RESULTS").
-- It never removes anything itself: its only writes are inserts and updates that are rolled back. Needs the Step 2 and Step 4 migrations applied. Run it as the `postgres`
-- role (SQL editor or MCP execute_sql).
--
-- ONLY RUN IT WHILE public.fuel_prices IS EMPTY OR DOES NOT HAVE THE MONDAYS 2026-09-21 AND 2026-09-28, and while
-- private.fuel_price_changes has no rows for them: it inserts those two Mondays and counts audit lines for them.

do $$
declare
  res text[] := '{}';
  uAdmin uuid := gen_random_uuid(); uPlain uuid := gen_random_uuid();
  r text; m text; n bigint; ok boolean;
  a_anon text; a_plain text; a_plain_write text; a_admin_audit text; a_admin_direct_delete text;
  c1 text; c2 text; c3 text; c4 text; c5 text; c6 text; c7 text; c8 text; c9 text; c10 text;
  rows_after text; audit_rows text;
begin
  ---------------------------------------------------------------- seed (as postgres)
  insert into auth.users (id) values (uAdmin), (uPlain);
  insert into public.platform_admins (user_id) values (uAdmin);

  ---------------------------------------------------------------- not signed in
  execute 'set local role anon';
  perform set_config('request.jwt.claims', '', true);
  begin perform public.publish_diesel_price('2026-09-21', 1431.50); a_anon := 'ok'; exception when others then a_anon := sqlstate; end;
  execute 'reset role';
  res := res || (case when a_anon = '42501' then 'PASS ' else 'FAIL (' || a_anon || ') ' end || 'a signed-out visitor cannot even call publish_diesel_price');

  ---------------------------------------------------------------- signed in, but not a platform admin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', uPlain, 'role', 'authenticated')::text, true);
  begin perform public.publish_diesel_price('2026-09-21', 1431.50); a_plain := 'ok'; exception when others then get stacked diagnostics m = message_text; a_plain := sqlstate || ' ' || m; end;
  begin insert into public.fuel_prices (monday, price_cents) values ('2026-09-21', 143150); a_plain_write := 'ok'; exception when others then a_plain_write := sqlstate; end;
  execute 'reset role';
  res := res || (case when a_plain = 'PT403 NOT_ALLOWED' then 'PASS ' else 'FAIL (' || a_plain || ') ' end || 'a signed-in non-admin is refused with 403 NOT_ALLOWED');
  res := res || (case when a_plain_write = '42501' then 'PASS ' else 'FAIL (' || a_plain_write || ') ' end || 'a signed-in non-admin cannot write to fuel_prices directly');

  ---------------------------------------------------------------- a platform admin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', uAdmin, 'role', 'authenticated')::text, true);

  begin c1 := public.publish_diesel_price('2026-09-21', 1431.50)::text; exception when others then get stacked diagnostics m = message_text; c1 := sqlstate || ' ' || m; end;
  begin c2 := public.publish_diesel_price('2026-09-29', 1500)::text; exception when others then get stacked diagnostics m = message_text; c2 := sqlstate || ' ' || m; end;
  begin c3 := public.publish_diesel_price('2030-01-07', 1500)::text; exception when others then get stacked diagnostics m = message_text; c3 := sqlstate || ' ' || m; end;
  begin c4 := public.publish_diesel_price('2026-09-28', 1534.705)::text; exception when others then get stacked diagnostics m = message_text; c4 := sqlstate || ' ' || m; end;
  begin c5 := public.publish_diesel_price('2026-09-28', 15347)::text; exception when others then get stacked diagnostics m = message_text; c5 := sqlstate || ' ' || m; end;
  begin c6 := public.publish_diesel_price('2026-09-28', 1534.70)::text; exception when others then get stacked diagnostics m = message_text, r = pg_exception_detail; c6 := sqlstate || ' ' || m || ' | ' || r; end;
  begin c7 := public.publish_diesel_price('2026-09-28', 1534.70, false, true)::text; exception when others then get stacked diagnostics m = message_text; c7 := sqlstate || ' ' || m; end;
  begin c8 := public.publish_diesel_price('2026-09-28', 1500)::text; exception when others then get stacked diagnostics m = message_text; c8 := sqlstate || ' ' || m; end;
  begin c9 := public.publish_diesel_price('2026-09-28', 1500, true)::text; exception when others then get stacked diagnostics m = message_text; c9 := sqlstate || ' ' || m; end;
  begin c10 := public.publish_diesel_price('2026-09-28', 1500)::text; exception when others then get stacked diagnostics m = message_text; c10 := sqlstate || ' ' || m; end;

  -- the admin must not be able to read the audit table through the API roles, and holds no right to remove a price
  begin perform 1 from private.fuel_price_changes limit 1; a_admin_audit := 'ok'; exception when others then a_admin_audit := sqlstate; end;
  a_admin_direct_delete := case when has_table_privilege('authenticated', 'public.fuel_prices', 'delete') then 'ok' else '42501' end;
  select string_agg(monday || ':' || price_cents, ',' order by monday) into rows_after from public.fuel_prices where monday in ('2026-09-21', '2026-09-28');
  execute 'reset role';

  res := res || (case when c1::jsonb ->> 'status' = 'created' and (c1::jsonb ->> 'price_cents')::int = 143150 and c1::jsonb -> 'compared_with' = 'null'::jsonb
                      then 'PASS ' else 'FAIL (' || c1 || ') ' end || 'an admin publishes the first price: created, 143150 cents, nothing to compare with');
  res := res || (case when c2 = 'PT422 INVALID_MONDAY' then 'PASS ' else 'FAIL (' || c2 || ') ' end || 'a Tuesday is refused: 422 INVALID_MONDAY');
  res := res || (case when c3 = 'PT422 MONDAY_IN_FUTURE' then 'PASS ' else 'FAIL (' || c3 || ') ' end || 'a Monday in the future is refused: 422 MONDAY_IN_FUTURE');
  res := res || (case when c4 = 'PT422 INVALID_PRICE' then 'PASS ' else 'FAIL (' || c4 || ') ' end || 'a price with 3 decimals is refused, not rounded: 422 INVALID_PRICE');
  res := res || (case when c5 = 'PT422 PRICE_OUT_OF_RANGE' then 'PASS ' else 'FAIL (' || c5 || ') ' end || 'a price of 15347 is refused: 422 PRICE_OUT_OF_RANGE');
  res := res || (case when c6 = 'PT409 BIG_MOVE | 1534.70 is +7.21 % compared with 1431.50 on 2026-09-21. The limit is 5 %.' then 'PASS ' else 'FAIL (' || c6 || ') ' end || 'a +7.21 % move is refused with the exact sentence: 409 BIG_MOVE');
  res := res || (case when c7::jsonb ->> 'status' = 'created' and (c7::jsonb ->> 'big_move_accepted')::boolean and (c7::jsonb -> 'compared_with' ->> 'change_bp')::int = 721
                      then 'PASS ' else 'FAIL (' || c7 || ') ' end || 'the same move with the confirmation is created and flagged (+721 bp)');
  res := res || (case when c8 = 'PT409 PRICE_EXISTS' then 'PASS ' else 'FAIL (' || c8 || ') ' end || 'a different price for a stored Monday is refused: 409 PRICE_EXISTS');
  res := res || (case when c9::jsonb ->> 'status' = 'replaced' and (c9::jsonb ->> 'price_cents')::int = 150000 then 'PASS ' else 'FAIL (' || c9 || ') ' end || 'with replace it is replaced (150000 cents)');
  res := res || (case when c10::jsonb ->> 'status' = 'unchanged' then 'PASS ' else 'FAIL (' || c10 || ') ' end || 'the same price again says unchanged');
  res := res || (case when rows_after = '2026-09-21:143150,2026-09-28:150000' then 'PASS ' else 'FAIL (' || coalesce(rows_after, '-') || ') ' end || 'exactly the two expected prices are stored');
  res := res || (case when a_admin_audit = '42501' then 'PASS ' else 'FAIL (' || a_admin_audit || ') ' end || 'even an admin cannot read the audit trail through the API');
  res := res || (case when a_admin_direct_delete = '42501' then 'PASS ' else 'FAIL (' || a_admin_direct_delete || ') ' end || 'no signed-in user holds the right to remove a price');

  ---------------------------------------------------------------- the audit trail (read as postgres)
  select string_agg(op || ' ' || monday || ' ' || coalesce(old_price_cents::text, '-') || '>' || coalesce(new_price_cents::text, '-')
                    || ' by ' || (case when changed_by = uAdmin then 'admin' else 'other' end), '; ' order by id)
    into audit_rows from private.fuel_price_changes where monday in ('2026-09-21', '2026-09-28');
  res := res || (case when audit_rows = 'insert 2026-09-21 ->143150 by admin; insert 2026-09-28 ->153470 by admin; update 2026-09-28 153470>150000 by admin'
                      then 'PASS ' else 'FAIL (' || coalesce(audit_rows, '-') || ') ' end || 'the audit trail has the 3 changes with the admin as author');

  ---------------------------------------------------------------- structure
  select has_function_privilege('anon', 'public.publish_diesel_price(date,numeric,boolean,boolean)', 'execute') into ok;
  res := res || (case when not ok then 'PASS ' else 'FAIL ' end || 'anon holds no execute right on the function');
  select has_function_privilege('authenticated', 'public.publish_diesel_price(date,numeric,boolean,boolean)', 'execute') into ok;
  res := res || (case when ok then 'PASS ' else 'FAIL ' end || 'signed-in users hold the execute right (the checks inside decide)');
  select has_function_privilege('service_role', 'public.publish_diesel_price(date,numeric,boolean,boolean)', 'execute') into ok;
  res := res || (case when not ok then 'PASS ' else 'FAIL ' end || 'service_role holds no execute right on the function');
  select not p.prosecdef into ok from pg_proc p where p.oid = 'public.publish_diesel_price(date,numeric,boolean,boolean)'::regprocedure;
  res := res || (case when ok then 'PASS ' else 'FAIL ' end || 'the function runs as its caller (security invoker)');
  select (select relrowsecurity from pg_class where oid = 'private.fuel_price_changes'::regclass)
         and not has_table_privilege('anon', 'private.fuel_price_changes', 'select,insert,update,delete')
         and not has_table_privilege('authenticated', 'private.fuel_price_changes', 'select,insert,update,delete')
         and not has_table_privilege('service_role', 'private.fuel_price_changes', 'select,insert,update,delete') into ok;
  res := res || (case when ok then 'PASS ' else 'FAIL ' end || 'the audit table has row level security on and no API role holds any right on it');
  select exists (select 1 from pg_trigger t where t.tgrelid = 'public.fuel_prices'::regclass and t.tgname = 'fuel_prices_audit' and not t.tgisinternal) into ok;
  res := res || (case when ok then 'PASS ' else 'FAIL ' end || 'the audit trigger is on fuel_prices');
  select private.brussels_today() = (now() at time zone 'Europe/Brussels')::date into ok;
  res := res || (case when ok then 'PASS ' else 'FAIL ' end || 'the clock helper returns today''s date in Brussels');

  ---------------------------------------------------------------- report, then roll everything back
  raise exception E'LIVE_CHECK_STEP4_RESULTS\n%\nTOTAL %   PASSED %   FAILED %',
    array_to_string(res, E'\n'),
    cardinality(res),
    (select count(*) from unnest(res) x where x like 'PASS%'),
    (select count(*) from unnest(res) x where x like 'FAIL%');
end $$;
