-- 00_supabase_stub.sql
-- LOCAL TESTING ONLY. Never run this on a real Supabase project.
-- Recreates the few parts of a Supabase project that our schema depends on, so the migration
-- and its security rules can be tested on a plain Postgres.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema auth;
create table auth.users (id uuid primary key);

-- Same logic as Supabase's auth.uid(): read the user id from the request's JWT claims.
create function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Supabase hands new tables in `public` to all three API roles by default. Our migration must undo that.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
