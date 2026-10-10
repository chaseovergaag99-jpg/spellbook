-- Minimal stand-in for the parts of Supabase that schema.sql relies on,
-- so it can be tested against plain Postgres + PostgREST. Dev only.
create role anon nologin;
create role authenticated nologin;
create role authenticator login password 'authpass' noinherit;
create role mockadmin login superuser password 'mockpass';  -- used by server.mjs for the fake auth.users table
grant anon, authenticated to authenticator;
create schema auth;
create table auth.users (id uuid primary key, email text unique, password text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
