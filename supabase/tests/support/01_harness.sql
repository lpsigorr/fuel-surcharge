-- 01_harness.sql
-- LOCAL TESTING ONLY. A tiny test harness in plain SQL (no extensions needed).
-- Run as the database owner. Test code switches to a Supabase-style role with t.as_user(),
-- t.as_anon() or t.as_service(), runs queries through t.try() / t.count() / t.affected(),
-- then calls t.back() and records the verdict with t.check().

create schema t;
grant usage on schema t to public;

create table t.results (
  id   serial primary key,
  name text not null,
  ok   boolean not null
);

create table t.ids (label text primary key, id uuid not null);
grant select on t.ids to public;   -- test code looks ids up while it is acting as other roles

create function t.id(label text) returns uuid
language sql stable as $$ select id from t.ids where ids.label = $1 $$;

create function t.check(name text, ok boolean) returns void
language plpgsql as $$
begin
  insert into t.results (name, ok) values (name, coalesce(ok, false));
end
$$;

create function t.back() returns void
language plpgsql as $$
begin
  execute 'reset role';
end
$$;

create function t.as_user(uid uuid) returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end
$$;

create function t.as_anon() returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  execute 'set local role anon';
end
$$;

create function t.as_service() returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  execute 'set local role service_role';
end
$$;

-- Run a statement as the current role; return 'ok' or the SQLSTATE of the error.
create function t.try(q text) returns text
language plpgsql as $$
begin
  execute q;
  return 'ok';
exception when others then
  return sqlstate;
end
$$;

-- Count rows a query returns as the current role.
create function t.count(q text) returns bigint
language plpgsql as $$
declare n bigint;
begin
  execute 'select count(*) from (' || q || ') s' into n;
  return n;
exception when others then
  return -1;   -- -1 means the query itself was refused
end
$$;

-- Run a write as the current role; return how many rows it changed, or -1 if it was refused.
create function t.affected(q text) returns bigint
language plpgsql as $$
declare n bigint;
begin
  execute q;
  get diagnostics n = row_count;
  return n;
exception when others then
  return -1;
end
$$;

-- Like t.try(), but undoes the statement afterwards, so tests can ask "would this be allowed?"
-- without changing the data.
create function t.try_rb(q text) returns text
language plpgsql as $$
begin
  begin
    execute q;
    raise exception 'rollback-marker' using errcode = 'P0001';
  exception when others then
    if sqlerrm = 'rollback-marker' then return 'ok'; end if;
    return sqlstate;
  end;
end
$$;

-- Like t.affected(), but undoes the change afterwards.
create function t.affected_rb(q text) returns bigint
language plpgsql as $$
declare n bigint := -1;
begin
  begin
    execute q;
    get diagnostics n = row_count;
    raise exception 'rollback-marker' using errcode = 'P0001';
  exception when others then
    if sqlerrm = 'rollback-marker' then return n; end if;
    return -1;
  end;
end
$$;

-- Try to store a quote built from a valid base record plus overrides; undo it afterwards.
-- Base record: service Fri 2026-10-09, rate EUR 333.33, base 1244.60, now 1534.70 per 1000 L, share 21.10 %
-- (the Febetra 2022 price levels), which gives +23.31 % diesel, 4.92 % surcharge, EUR 16.40, total EUR 349.73.
create function t.try_quote(overrides jsonb default '{}'::jsonb) returns text
language plpgsql as $$
declare
  base jsonb := jsonb_build_object(
    'id', gen_random_uuid(), 'organization_id', t.id('org1'), 'source', 'staff',
    'created_at', now(), 'zone_name', 'Brussels', 'vehicle_type_name', 'Van',
    'service_date', '2026-10-09', 'rate_cents', 33333, 'base_diesel_cents', 124460,
    'reference_monday', '2026-09-28', 'current_diesel_cents', 153470, 'fuel_share_bp', 2110,
    'lag_days', 7, 'threshold_bp', 0, 'floor_at_zero', false, 'change_bp', 2331,
    'surcharge_bp', 492, 'reason', 'APPLIED', 'surcharge_cents', 1640, 'total_cents', 34973,
    'engine_version', 'test');
begin
  begin
    insert into public.quotes select * from jsonb_populate_record(null::public.quotes, base || overrides);
    raise exception 'rollback-marker' using errcode = 'P0001';
  exception when others then
    if sqlerrm = 'rollback-marker' then return 'ok'; end if;
    return sqlstate;
  end;
end
$$;
