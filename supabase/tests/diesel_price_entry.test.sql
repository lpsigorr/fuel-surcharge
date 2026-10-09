-- diesel_price_entry.test.sql
-- LOCAL TESTING ONLY. Run by run-entry-local.sh after the stub, the harness and both migrations.
-- Checks the Step 4 rules: who may publish a diesel price, which inputs are refused, the 5 % jump rule,
-- overwrite protection, the audit trail and the privileges.
--
-- Cast of characters:
--   EP   platform admin        EP2  a second platform admin       EU  signed in, not an admin
-- Every expected number below was worked out by hand, with the arithmetic in a comment.

delete from t.results;

create table t.kv (k text primary key, v text);

-- ---------------------------------------------------------------------------
-- Test helpers
-- ---------------------------------------------------------------------------
-- Run one statement as the current role. Return {ok:true,result:...} or {ok:false,sqlstate,message,detail,hint}.
create function t.call(q text) returns jsonb
language plpgsql as $$
declare r jsonb; st text; msg text; det text; hnt text;
begin
  execute q into r;
  return jsonb_build_object('ok', true, 'result', r);
exception when others then
  get stacked diagnostics st = returned_sqlstate, msg = message_text, det = pg_exception_detail, hnt = pg_exception_hint;
  return jsonb_build_object('ok', false, 'sqlstate', st, 'message', msg, 'detail', det, 'hint', hnt);
end $$;

-- The same, but everything the statement changed is undone afterwards.
create function t.call_rb(q text) returns jsonb
language plpgsql as $$
declare r jsonb;
begin
  begin
    r := t.call(q);
    raise exception 'rollback-marker' using errcode = 'P0001';
  exception when others then
    if sqlerrm = 'rollback-marker' then return r; end if;
    raise;
  end;
end $$;

create function t.sql_pub(m text, price text, rep boolean, acc boolean) returns text
language sql immutable as $$
  select format('select public.publish_diesel_price(%L::date, %L::numeric, %L::boolean, %L::boolean)', m, price, rep, acc)
$$;
create function t.pub(m text, price text, rep boolean default false, acc boolean default false) returns jsonb
language sql as $$ select t.call(t.sql_pub(m, price, rep, acc)) $$;
create function t.pub_rb(m text, price text, rep boolean default false, acc boolean default false) returns jsonb
language sql as $$ select t.call_rb(t.sql_pub(m, price, rep, acc)) $$;

-- Signed in with a valid token role but without a user id.
create function t.as_nobody() returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $$;

-- Start from an empty price list and an empty audit trail (run as database owner).
create function t.reset_prices() returns void
language plpgsql as $$
begin
  delete from public.fuel_prices;
  delete from private.fuel_price_changes;
end $$;

create function t.refused(label text, r jsonb, code text, msg text) returns void
language plpgsql as $$
begin
  perform t.check(label, (r->>'ok')::boolean is false and r->>'sqlstate' = code and r->>'message' = msg);
end $$;

create function t.accepted(label text, r jsonb, status text, cents integer) returns void
language plpgsql as $$
begin
  perform t.check(label, (r->>'ok')::boolean is true and r->'result'->>'status' = status
                         and (r->'result'->>'price_cents')::integer = cents);
end $$;

-- ---------------------------------------------------------------------------
-- Seed
-- ---------------------------------------------------------------------------
insert into t.ids (label, id) select l, gen_random_uuid() from unnest(array['EP', 'EP2', 'EU']) as l;
insert into auth.users (id) select id from t.ids where label in ('EP', 'EP2', 'EU');
insert into public.platform_admins (user_id) values (t.id('EP')), (t.id('EP2'));

do $$ begin perform t.reset_prices(); end $$;

-- ---------------------------------------------------------------------------
-- 1. Who may publish
-- ---------------------------------------------------------------------------
do $$
declare r_user jsonb; r_nobody jsonb; r_anon jsonb; n bigint; n_audit bigint;
begin
  perform t.as_user(t.id('EU'));    r_user   := t.pub('2026-09-21', '1431.50');
  perform t.as_nobody();            r_nobody := t.pub('2026-09-21', '1431.50');
  perform t.as_anon();              r_anon   := t.pub('2026-09-21', '1431.50');
  perform t.back();
  n := (select count(*) from public.fuel_prices);
  n_audit := (select count(*) from private.fuel_price_changes);

  perform t.refused('a signed-in user who is not a platform admin is refused: NOT_ALLOWED, HTTP 403', r_user, 'PT403', 'NOT_ALLOWED');
  perform t.refused('a token without a user id is refused: NOT_ALLOWED', r_nobody, 'PT403', 'NOT_ALLOWED');
  perform t.check('anon (not signed in) cannot even call the function (permission denied for function)',
    (r_anon->>'ok')::boolean is false and r_anon->>'sqlstate' = '42501');
  perform t.check('the refused calls wrote nothing: 0 prices and 0 audit lines', n = 0 and n_audit = 0);
end $$;

-- ---------------------------------------------------------------------------
-- 2. Which inputs are refused (every call here is undone afterwards)
-- ---------------------------------------------------------------------------
do $$
declare res jsonb := '{}'; next_monday date; this_monday date; n bigint; n_audit bigint;
begin
  next_monday := (date_trunc('week', now() at time zone 'Europe/Brussels') + interval '7 days')::date;  -- the Monday after today
  this_monday := (date_trunc('week', now() at time zone 'Europe/Brussels'))::date;                      -- this week's Monday, today or earlier
  perform t.as_user(t.id('EP'));
  res := res || jsonb_build_object(
    'tue',      t.pub_rb('2026-09-29', '1534.70'),      -- 29 Sep 2026 is a Tuesday
    'sun',      t.pub_rb('2026-10-04', '1534.70'),      -- 4 Oct 2026 is a Sunday
    'nomon',    t.pub_rb(null, '1534.70'),
    'future',   t.pub_rb(next_monday::text, '1534.70'),
    'thisweek', t.pub_rb(this_monday::text, '1534.70'),
    'zero',     t.pub_rb('2026-09-28', '0'),
    'neg',      t.pub_rb('2026-09-28', '-1534.70'),
    'nullp',    t.pub_rb('2026-09-28', null),
    'three',    t.pub_rb('2026-09-28', '1534.705'),     -- third decimal: never rounded silently
    'one',      t.pub_rb('2026-09-28', '1534.7'),
    'trail',    t.pub_rb('2026-09-28', '1534.700'),     -- same value as 1534.70
    'two',      t.pub_rb('2026-09-28', '1534.70'),
    'below',    t.pub_rb('2026-09-28', '499.99'),
    'min',      t.pub_rb('2026-09-28', '500.00'),
    'max',      t.pub_rb('2026-09-28', '5000.00'),
    'above',    t.pub_rb('2026-09-28', '5000.01'),
    'perlitre', t.pub_rb('2026-09-28', '153.47'),       -- slipped decimal: 1534.70 typed as 153.47
    'times10',  t.pub_rb('2026-09-28', '15347.00'),
    'nan',      t.pub_rb('2026-09-28', 'NaN'),
    'inf',      t.pub_rb('2026-09-28', 'Infinity'),
    'text',     t.pub_rb('2026-09-28', 'abc'),
    'bothbad',  t.pub_rb('2026-09-29', '0'));           -- two mistakes: the Monday is reported first
  perform t.back();
  n := (select count(*) from public.fuel_prices);
  n_audit := (select count(*) from private.fuel_price_changes);

  perform t.refused('a Tuesday is refused: INVALID_MONDAY, HTTP 422', res->'tue', 'PT422', 'INVALID_MONDAY');
  perform t.refused('a Sunday is refused: INVALID_MONDAY', res->'sun', 'PT422', 'INVALID_MONDAY');
  perform t.refused('an empty Monday is refused: INVALID_MONDAY', res->'nomon', 'PT422', 'INVALID_MONDAY');
  perform t.check('the INVALID_MONDAY sentence names the date and its hint says what to use',
    res->'tue'->>'detail' = '2026-09-29 is not a Monday.' and res->'tue'->>'hint' like 'Use the Monday%');
  perform t.refused('the Monday after today is refused: MONDAY_IN_FUTURE', res->'future', 'PT422', 'MONDAY_IN_FUTURE');
  perform t.accepted('this week''s Monday (today or earlier) is accepted', res->'thisweek', 'created', 153470);
  perform t.refused('price 0 is refused: INVALID_PRICE', res->'zero', 'PT422', 'INVALID_PRICE');
  perform t.refused('a negative price is refused: INVALID_PRICE', res->'neg', 'PT422', 'INVALID_PRICE');
  perform t.refused('an empty price is refused: INVALID_PRICE', res->'nullp', 'PT422', 'INVALID_PRICE');
  perform t.refused('1534.705 (3 decimals) is refused, not rounded: INVALID_PRICE', res->'three', 'PT422', 'INVALID_PRICE');
  perform t.accepted('1534.7 is accepted and stored as 153470 hundredths', res->'one', 'created', 153470);
  perform t.accepted('1534.700 is accepted and stored as 153470 hundredths', res->'trail', 'created', 153470);
  perform t.check('the reply shows the price back as 1534.70', res->'two'->'result'->>'eur_per_1000l' = '1534.70');
  perform t.refused('499.99 is below the range: PRICE_OUT_OF_RANGE', res->'below', 'PT422', 'PRICE_OUT_OF_RANGE');
  perform t.accepted('500.00 is the lowest accepted price', res->'min', 'created', 50000);
  perform t.accepted('5000.00 is the highest accepted price', res->'max', 'created', 500000);
  perform t.refused('5000.01 is above the range: PRICE_OUT_OF_RANGE', res->'above', 'PT422', 'PRICE_OUT_OF_RANGE');
  perform t.refused('153.47 (a per-litre style slip) is out of range', res->'perlitre', 'PT422', 'PRICE_OUT_OF_RANGE');
  perform t.refused('15347.00 (a x10 slip) is out of range', res->'times10', 'PT422', 'PRICE_OUT_OF_RANGE');
  perform t.refused('NaN is out of range', res->'nan', 'PT422', 'PRICE_OUT_OF_RANGE');
  perform t.refused('Infinity is out of range', res->'inf', 'PT422', 'PRICE_OUT_OF_RANGE');
  perform t.check('text that is not a number is refused before the function runs (22P02)',
    (res->'text'->>'ok')::boolean is false and res->'text'->>'sqlstate' = '22P02');
  perform t.refused('with two mistakes, the Monday is reported first', res->'bothbad', 'PT422', 'INVALID_MONDAY');
  perform t.check('all those calls were undone: 0 prices and 0 audit lines', n = 0 and n_audit = 0);
end $$;

-- ---------------------------------------------------------------------------
-- 3. The normal life of the price list (steps a to c, one transaction)
-- ---------------------------------------------------------------------------
-- a. 21 Sep 2026 is the first price ever: 1431.50, nothing to compare with.
-- b. 28 Sep 2026 at 1534.70 is +7.21 % on 1431.50: (153470 - 143150) / 143150 = 10320 / 143150 = 0.072092 -> 721 bp.
--    That is more than 5 %, so it needs accept_big_move.
-- c. 5 Oct 2026 at 1546.20 vs 1534.70: 1150 / 153470 = 0.0074933 -> 75 bp, under 5 %, accepted without a flag.
do $$
declare res jsonb := '{}'; stored int; n bigint; audit_rows jsonb;
begin
  perform t.as_user(t.id('EP'));
  res := res || jsonb_build_object('a',  t.pub('2026-09-21', '1431.50'));
  res := res || jsonb_build_object('b1', t.pub('2026-09-28', '1534.70'));
  res := res || jsonb_build_object('b2', t.pub('2026-09-28', '1534.70', false, true));
  res := res || jsonb_build_object('c',  t.pub('2026-10-05', '1546.20'));
  perform t.back();
  n := (select count(*) from public.fuel_prices);
  insert into t.kv values ('entered_at_1005', (select entered_at::text from public.fuel_prices where monday = '2026-10-05'));
  audit_rows := (select coalesce(jsonb_agg(jsonb_build_array(op, monday, old_price_cents, new_price_cents, changed_by = t.id('EP')) order by id), '[]')
                 from private.fuel_price_changes);

  perform t.accepted('a: the first price is created, stored as 143150', res->'a', 'created', 143150);
  perform t.check('a: with nothing stored yet there is nothing to compare with', res->'a'->'result'->'compared_with' = 'null'::jsonb);
  perform t.check('a: the price list remembers who entered it',
    (select entered_by = t.id('EP') from public.fuel_prices where monday = '2026-09-21'));
  perform t.refused('b: +7.21 % on the previous week is refused without a confirmation: BIG_MOVE, HTTP 409', res->'b1', 'PT409', 'BIG_MOVE');
  perform t.check('b: the BIG_MOVE sentence gives the new price, the percentage, the old price and its Monday',
    res->'b1'->>'detail' = '1534.70 is +7.21 % compared with 1431.50 on 2026-09-21. The limit is 5 %.');
  perform t.check('b: the BIG_MOVE hint names the flag to send', res->'b1'->>'hint' like '%accept_big_move = true%');
  perform t.accepted('b: with accept_big_move the same price is created', res->'b2', 'created', 153470);
  perform t.check('b: the reply says what it was compared with: 21 Sep, 143150, +721 bp, and that a big move was accepted',
    res->'b2'->'result'->'compared_with' = '{"monday":"2026-09-21","price_cents":143150,"change_bp":721}'::jsonb
    and (res->'b2'->'result'->>'big_move_accepted')::boolean is true);
  perform t.accepted('c: +0.75 % needs no confirmation', res->'c', 'created', 154620);
  perform t.check('c: compared with 28 Sep at +75 bp, no big move',
    res->'c'->'result'->'compared_with' = '{"monday":"2026-09-28","price_cents":153470,"change_bp":75}'::jsonb
    and (res->'c'->'result'->>'big_move_accepted')::boolean is false);
  perform t.check('a to c: exactly 3 prices stored', n = 3);
  perform t.check('a to c: the audit trail has exactly the 3 inserts, in order, by the admin who made them',
    audit_rows = '[["insert","2026-09-21",null,143150,true],["insert","2026-09-28",null,153470,true],["insert","2026-10-05",null,154620,true]]'::jsonb);
end $$;

-- d and e, in a later transaction so that "unchanged" can be told apart from "rewritten with the same time".
do $$
declare res jsonb := '{}'; n_audit bigint; same_time boolean; stored int;
begin
  perform t.as_user(t.id('EP'));
  res := res || jsonb_build_object('d', t.pub('2026-10-05', '1546.20'));   -- same price again
  res := res || jsonb_build_object('e', t.pub('2026-10-05', '1549.30'));   -- a different price, no replace
  perform t.back();
  n_audit := (select count(*) from private.fuel_price_changes);
  same_time := (select entered_at::text = (select v from t.kv where k = 'entered_at_1005') from public.fuel_prices where monday = '2026-10-05');
  stored := (select price_cents from public.fuel_prices where monday = '2026-10-05');

  perform t.accepted('d: sending the same price again is harmless: status unchanged', res->'d', 'unchanged', 154620);
  perform t.check('d: unchanged writes nothing: no new audit line and the entry time is untouched', n_audit = 3 and same_time);
  perform t.refused('e: a different price for a Monday that already has one is refused: PRICE_EXISTS, HTTP 409', res->'e', 'PT409', 'PRICE_EXISTS');
  perform t.check('e: the PRICE_EXISTS sentence shows the stored price, and the stored price is untouched',
    res->'e'->>'detail' = '2026-10-05 already has the price 1546.20.' and stored = 154620);
end $$;

-- f. A second admin corrects 5 Oct to 1549.30 on purpose. Closest other Monday is 28 Sep (7 days away).
--    (154930 - 153470) / 153470 = 1460 / 153470 = 0.0095134 -> 95 bp.
do $$
declare r jsonb; row_after record; changed_time boolean; last_audit record;
begin
  perform t.as_user(t.id('EP2'));
  r := t.pub('2026-10-05', '1549.30', true);
  perform t.back();
  select price_cents, entered_by into row_after from public.fuel_prices where monday = '2026-10-05';
  changed_time := (select entered_at::text <> (select v from t.kv where k = 'entered_at_1005') from public.fuel_prices where monday = '2026-10-05');
  select op, old_price_cents, new_price_cents, changed_by into last_audit from private.fuel_price_changes order by id desc limit 1;

  perform t.accepted('f: replace = true corrects the price: status replaced, stored as 154930', r, 'replaced', 154930);
  perform t.check('f: the correction is compared with 28 Sep (never with itself): +95 bp',
    r->'result'->'compared_with' = '{"monday":"2026-09-28","price_cents":153470,"change_bp":95}'::jsonb);
  perform t.check('f: the row now names the admin who corrected it, with a new entry time',
    row_after.price_cents = 154930 and row_after.entered_by = t.id('EP2') and changed_time);
  perform t.check('f: the audit trail records the correction: update, 154620 to 154930, by the second admin',
    last_audit.op = 'update' and last_audit.old_price_cents = 154620 and last_audit.new_price_cents = 154930 and last_audit.changed_by = t.id('EP2'));
end $$;

-- g. Replacing 5 Oct by 1700.00 is +10.77 % on 28 Sep: (170000 - 153470) / 153470 = 16530 / 153470 = 0.107714 -> 1077 bp.
do $$
declare r1 jsonb; r2 jsonb; stored_after_refusal int; n_audit_after_refusal bigint; stored_final int;
begin
  perform t.as_user(t.id('EP'));
  r1 := t.pub('2026-10-05', '1700.00', true);
  perform t.back();
  stored_after_refusal := (select price_cents from public.fuel_prices where monday = '2026-10-05');
  n_audit_after_refusal := (select count(*) from private.fuel_price_changes);
  perform t.as_user(t.id('EP'));
  r2 := t.pub('2026-10-05', '1700.00', true, true);
  perform t.back();
  stored_final := (select price_cents from public.fuel_prices where monday = '2026-10-05');

  perform t.refused('g: a replacement is checked for big moves too: BIG_MOVE', r1, 'PT409', 'BIG_MOVE');
  perform t.check('g: the refused replacement left the price and the audit trail alone', stored_after_refusal = 154930 and n_audit_after_refusal = 4);
  perform t.check('g: replace and accept_big_move together: replaced, +1077 bp, big move accepted',
    r2->'result'->>'status' = 'replaced' and (r2->'result'->'compared_with'->>'change_bp')::int = 1077
    and (r2->'result'->>'big_move_accepted')::boolean is true and stored_final = 170000);
end $$;

-- ---------------------------------------------------------------------------
-- 4. The 5 % line, exactly (every call undone)
-- ---------------------------------------------------------------------------
-- Base: 6 Jan 2025 at 1400.00 = 140000. "More than 5 %" means |difference| x 20 > 140000, i.e. a difference above 7000.
--   1470.00: +7000, 7000 x 20 = 140000, not more than 140000 -> allowed, +500 bp
--   1470.01: +7001, 140020 > 140000 -> refused
--   1330.00: -7000 -> allowed, -500 bp.   1329.99: -7001 -> refused
do $$
declare res jsonb := '{}';
begin
  perform t.reset_prices();
  insert into public.fuel_prices (monday, price_cents) values ('2025-01-06', 140000);
  perform t.as_user(t.id('EP'));
  res := res || jsonb_build_object(
    'up_edge',   t.pub_rb('2025-01-13', '1470.00'),
    'up_over',   t.pub_rb('2025-01-13', '1470.01'),
    'down_edge', t.pub_rb('2025-01-13', '1330.00'),
    'down_over', t.pub_rb('2025-01-13', '1329.99'),
    'same',      t.pub_rb('2025-01-13', '1400.00'));
  perform t.back();

  perform t.check('exactly +5.00 % (1470.00 on 1400.00) is allowed without a flag, reported as +500 bp',
    (res->'up_edge'->>'ok')::boolean and (res->'up_edge'->'result'->'compared_with'->>'change_bp')::int = 500
    and (res->'up_edge'->'result'->>'big_move_accepted')::boolean is false);
  perform t.refused('+5.001 % (1470.01 on 1400.00) is refused', res->'up_over', 'PT409', 'BIG_MOVE');
  perform t.check('exactly -5.00 % (1330.00 on 1400.00) is allowed, reported as -500 bp',
    (res->'down_edge'->>'ok')::boolean and (res->'down_edge'->'result'->'compared_with'->>'change_bp')::int = -500);
  perform t.refused('-5.001 % (1329.99 on 1400.00) is refused', res->'down_over', 'PT409', 'BIG_MOVE');
  perform t.check('a price equal to its neighbour is a change of 0 bp',
    (res->'same'->'result'->'compared_with'->>'change_bp')::int = 0);
  perform t.reset_prices();
end $$;

-- ---------------------------------------------------------------------------
-- 5. Which stored Monday a new price is compared with
-- ---------------------------------------------------------------------------
-- The closest one in time, on a tie the earlier one, and a later one when nothing earlier exists.
do $$
declare res jsonb := '{}';
begin
  -- Tie: 4 Mar 2024 = 1400.00 and 18 Mar 2024 = 1460.00; the new Monday 11 Mar is 7 days from both.
  perform t.reset_prices();
  insert into public.fuel_prices (monday, price_cents) values ('2024-03-04', 140000), ('2024-03-18', 146000);
  perform t.as_user(t.id('EP'));
  res := res || jsonb_build_object(
    'tie_ok',   t.pub_rb('2024-03-11', '1470.00'),   -- vs 1400.00: +5.00 % allowed; vs 1460.00 it would be +0.68 %
    'tie_over', t.pub_rb('2024-03-11', '1475.00'));  -- vs 1400.00: +5.36 % refused; vs 1460.00 it would be +1.03 %
  perform t.back();

  -- Closest wins: 4 Mar = 1400.00 and 25 Mar = 1500.00; the new Monday 18 Mar is 14 days from the first, 7 from the second.
  perform t.reset_prices();
  insert into public.fuel_prices (monday, price_cents) values ('2024-03-04', 140000), ('2024-03-25', 150000);
  perform t.as_user(t.id('EP'));
  res := res || jsonb_build_object('closest', t.pub_rb('2024-03-18', '1520.00'));  -- vs 1500.00: +1.33 % (133 bp); vs 1400.00 it would be +8.57 %
  perform t.back();

  -- Only a later Monday exists (back-filling): 5 Oct 2026 = 1500.00, the new Monday is 28 Sep.
  perform t.reset_prices();
  insert into public.fuel_prices (monday, price_cents) values ('2026-10-05', 150000);
  perform t.as_user(t.id('EP'));
  res := res || jsonb_build_object('later', t.pub_rb('2026-09-28', '1520.00'));    -- (152000 - 150000) / 150000 = 1.33 % -> 133 bp
  perform t.back();
  perform t.reset_prices();

  perform t.check('on a tie the earlier Monday is used (4 Mar, +500 bp)',
    res->'tie_ok'->'result'->'compared_with' = '{"monday":"2024-03-04","price_cents":140000,"change_bp":500}'::jsonb);
  perform t.refused('on a tie the earlier Monday decides: 1475.00 is +5.36 % on 4 Mar, so BIG_MOVE', res->'tie_over', 'PT409', 'BIG_MOVE');
  perform t.check('the closest Monday in time is used, not simply the earlier one (25 Mar, +133 bp)',
    res->'closest'->'result'->'compared_with' = '{"monday":"2024-03-25","price_cents":150000,"change_bp":133}'::jsonb);
  perform t.check('when only a later Monday exists it is used (5 Oct, +133 bp)',
    res->'later'->'result'->'compared_with' = '{"monday":"2026-10-05","price_cents":150000,"change_bp":133}'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- 6. The audit trail sees every kind of change, whoever makes it
-- ---------------------------------------------------------------------------
do $$
declare a jsonb; n_p_select bigint; n_u_select bigint; n_anon_select bigint; r_ins text; r_fn text; direct_by_p boolean;
begin
  perform t.reset_prices();
  -- as database owner (like the dashboard): no signed-in user, so changed_by stays empty
  insert into public.fuel_prices (monday, price_cents) values ('2026-01-05', 140000);
  update public.fuel_prices set price_cents = 141000 where monday = '2026-01-05';
  update public.fuel_prices set monday = '2026-01-12' where monday = '2026-01-05';
  delete from public.fuel_prices where monday = '2026-01-12';
  a := (select jsonb_agg(jsonb_build_array(op, monday, old_price_cents, new_price_cents, changed_by is null) order by id)
        from private.fuel_price_changes);

  perform t.check('audit: an insert, an update, a Monday edit (= remove + add) and a delete are each recorded with old and new values',
    a = '[["insert","2026-01-05",null,140000,true],
          ["update","2026-01-05",140000,141000,true],
          ["delete","2026-01-05",141000,null,true],
          ["insert","2026-01-12",null,141000,true],
          ["delete","2026-01-12",141000,null,true]]'::jsonb);

  -- an admin writing straight to the table (RLS allows it) is recorded too, with their id
  perform t.as_user(t.id('EP'));
  insert into public.fuel_prices (monday, price_cents) values ('2026-01-19', 140000);
  perform t.back();
  direct_by_p := (select changed_by = t.id('EP') and op = 'insert' and monday = '2026-01-19'
                  from private.fuel_price_changes order by id desc limit 1);
  perform t.check('audit: a direct insert by an admin through the table (skipping the checks) is still recorded, with their id', direct_by_p);

  -- nobody on the API side can read or touch the audit trail
  perform t.as_user(t.id('EP'));   n_p_select := t.count('select * from private.fuel_price_changes');
  r_ins := t.try('insert into private.fuel_price_changes (op, monday, new_price_cents) values (''insert'', ''2026-01-26'', 1)');
  r_fn := t.try('select private.log_fuel_price_change()');
  perform t.as_user(t.id('EU'));   n_u_select := t.count('select * from private.fuel_price_changes');
  perform t.as_anon();             n_anon_select := t.count('select * from private.fuel_price_changes');
  perform t.back();
  perform t.check('audit: even a platform admin cannot read the audit trail through the API (no privilege)', n_p_select = -1);
  perform t.check('audit: signed-in users and anon cannot read it either', n_u_select = -1 and n_anon_select = -1);
  perform t.check('audit: the API roles cannot write to it', r_ins = '42501');
  perform t.check('audit: the API roles cannot call the trigger function by hand', r_fn = '42501');
  perform t.reset_prices();
end $$;

-- ---------------------------------------------------------------------------
-- 7. Privileges and structure
-- ---------------------------------------------------------------------------
do $$
declare fn oid; trig int; tz_ok boolean; fp_priv boolean;
begin
  select p.oid into fn from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'publish_diesel_price';
  perform t.check('there is exactly one publish_diesel_price in public (no overloads)',
    (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'publish_diesel_price') = 1);
  perform t.check('publish_diesel_price runs as the caller (security invoker), so row level security still applies',
    (select not p.prosecdef from pg_proc p where p.oid = fn));
  perform t.check('publish_diesel_price has a fixed, empty search_path',
    (select coalesce(p.proconfig, '{}') @> array['search_path=""'] from pg_proc p where p.oid = fn));
  perform t.check('only signed-in users may execute publish_diesel_price: not anon, not service_role, not PUBLIC',
    has_function_privilege('authenticated', fn, 'execute')
    and not has_function_privilege('anon', fn, 'execute')
    and not has_function_privilege('service_role', fn, 'execute')
    and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = fn and a.grantee = 0));
  perform t.check('the audit trigger function is executable by none of the API roles',
    not has_function_privilege('anon', 'private.log_fuel_price_change()', 'execute')
    and not has_function_privilege('authenticated', 'private.log_fuel_price_change()', 'execute')
    and not has_function_privilege('service_role', 'private.log_fuel_price_change()', 'execute'));
  perform t.check('the audit table has row level security on, no policies, and no privilege for any API role',
    (select relrowsecurity from pg_class where oid = 'private.fuel_price_changes'::regclass)
    and not exists (select 1 from pg_policies where schemaname = 'private' and tablename = 'fuel_price_changes')
    and not has_table_privilege('anon', 'private.fuel_price_changes', 'select,insert,update,delete,truncate')
    and not has_table_privilege('authenticated', 'private.fuel_price_changes', 'select,insert,update,delete,truncate')
    and not has_table_privilege('service_role', 'private.fuel_price_changes', 'select,insert,update,delete,truncate'));
  select count(*) into trig from pg_trigger where tgrelid = 'public.fuel_prices'::regclass and not tgisinternal and tgname = 'fuel_prices_audit' and tgenabled = 'O'
    and (tgtype & 1) = 1      -- per row
    and (tgtype & 2) = 0      -- after (the BEFORE bit is off)
    and (tgtype & 4) = 4 and (tgtype & 8) = 8 and (tgtype & 16) = 16;   -- insert, delete, update
  perform t.check('fuel_prices has exactly the audit trigger: per row, after insert, update and delete, enabled', trig = 1
    and (select count(*) from pg_trigger where tgrelid = 'public.fuel_prices'::regclass and not tgisinternal) = 1);
  perform t.check('the Step 2 rules on fuel_prices are unchanged: signed-in users can read, insert and update but not delete or truncate; anon has nothing',
    has_table_privilege('authenticated', 'public.fuel_prices', 'select,insert,update')
    and not has_table_privilege('authenticated', 'public.fuel_prices', 'delete')
    and not has_table_privilege('authenticated', 'public.fuel_prices', 'truncate')
    and not has_table_privilege('anon', 'public.fuel_prices', 'select,insert,update,delete,truncate'));
  perform t.check('the clock helper uses the Brussels date',
    (select pg_get_functiondef(p.oid) like '%Europe/Brussels%' from pg_proc p where p.proname = 'brussels_today' and p.pronamespace = 'private'::regnamespace));
  perform t.check('the clock helper is not reachable by anon',
    not has_function_privilege('anon', 'private.brussels_today()', 'execute'));
end $$;

-- ---------------------------------------------------------------------------
-- 8. Two people entering the same Monday at the same moment
-- ---------------------------------------------------------------------------
-- A trigger (created only for this test) sneaks in a competing insert just before ours, which is what a
-- second admin pressing the button at the same instant would look like.
create function t.race_insert() returns trigger
language plpgsql as $$
begin
  if new.monday = date '2026-02-02' and coalesce(current_setting('t.race_done', true), '') <> '1' then
    perform set_config('t.race_done', '1', true);
    insert into public.fuel_prices (monday, price_cents) values (new.monday, 140000);
  end if;
  return new;
end $$;

do $$
declare r jsonb; code text;
begin
  perform t.reset_prices();
  create trigger t_race before insert on public.fuel_prices for each row execute function t.race_insert();
  perform t.as_user(t.id('EP'));
  r := t.pub('2026-02-02', '1410.00');
  perform t.back();
  drop trigger t_race on public.fuel_prices;
  perform t.refused('a competing insert for the same Monday gives PRICE_EXISTS (409), not a raw database error', r, 'PT409', 'PRICE_EXISTS');
  perform t.reset_prices();
end $$;

-- ---------------------------------------------------------------------------
-- 9. The clock: "has not happened yet" is decided by the Brussels date
-- ---------------------------------------------------------------------------
-- The clock helper is replaced for this test only, then put back exactly as the migration defines it.
do $$
declare res jsonb := '{}';
begin
  perform t.reset_prices();
  create or replace function private.brussels_today() returns date language sql stable set search_path = '' as $f$ select date '2026-10-05' $f$;
  perform t.as_user(t.id('EP'));
  res := res || jsonb_build_object(
    'mon_today',  t.pub_rb('2026-10-05', '1500.00'),    -- today is Monday 5 Oct 2026: the price of today's Monday is allowed
    'mon_next',   t.pub_rb('2026-10-12', '1500.00'),    -- next Monday: not yet
    'mon_prev',   t.pub_rb('2026-09-28', '1500.00'));
  perform t.back();

  create or replace function private.brussels_today() returns date language sql stable set search_path = '' as $f$ select date '2026-10-04' $f$;
  perform t.as_user(t.id('EP'));
  res := res || jsonb_build_object('sunday_before', t.pub_rb('2026-10-05', '1500.00'));   -- today is Sunday 4 Oct: Monday 5 Oct is tomorrow
  perform t.back();

  create or replace function private.brussels_today() returns date language sql stable set search_path = '' as $f$ select (now() at time zone 'Europe/Brussels')::date $f$;

  perform t.accepted('clock: on Monday 5 Oct, the price for 5 Oct is accepted', res->'mon_today', 'created', 150000);
  perform t.refused('clock: on Monday 5 Oct, the price for 12 Oct is refused: MONDAY_IN_FUTURE', res->'mon_next', 'PT422', 'MONDAY_IN_FUTURE');
  perform t.accepted('clock: on Monday 5 Oct, the price for 28 Sep is accepted', res->'mon_prev', 'created', 150000);
  perform t.refused('clock: on Sunday 4 Oct, the price for Monday 5 Oct is refused', res->'sunday_before', 'PT422', 'MONDAY_IN_FUTURE');
  perform t.check('clock: the MONDAY_IN_FUTURE sentence names both dates',
    res->'mon_next'->>'detail' = '2026-10-12 has not happened yet (today is 2026-10-05 in Brussels), so no real price exists for it.');
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
