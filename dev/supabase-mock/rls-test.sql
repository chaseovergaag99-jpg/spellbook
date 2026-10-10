-- RLS / trigger checks for supabase/schema.sql (run against the mock DB).
\set ON_ERROR_STOP 0
insert into auth.users values ('11111111-1111-1111-1111-111111111111','a@test','x'), ('22222222-2222-2222-2222-222222222222','b@test','x');

set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', false);
insert into public.collection_items (id, card_id, qty, updated_at) values ('e1','c1',2,'2026-01-02T00:00:00Z');   -- user_id defaults to auth.uid()
select 'A sees own rows' as test, count(*) = 1 as pass from public.collection_items;
update public.collection_items set qty = 99, updated_at = '2026-01-01T00:00:00Z' where id = 'e1';          -- stale → ignored
select 'stale update ignored' as test, qty = 2 as pass from public.collection_items where id = 'e1';
update public.collection_items set qty = 3, updated_at = '2026-01-03T00:00:00Z' where id = 'e1';
select 'newer update applied' as test, qty = 3 as pass from public.collection_items where id = 'e1';
insert into public.collection_items (user_id, id, qty, updated_at) values ('11111111-1111-1111-1111-111111111111','e1',5,'2026-01-04T00:00:00Z')
  on conflict (user_id, id) do update set qty = excluded.qty, updated_at = excluded.updated_at;
select 'upsert newer applied' as test, qty = 5 as pass from public.collection_items where id = 'e1';
insert into public.collection_items (user_id, id, qty, updated_at) values ('11111111-1111-1111-1111-111111111111','e1',7,'2026-01-01T00:00:00Z')
  on conflict (user_id, id) do update set qty = excluded.qty, updated_at = excluded.updated_at;
select 'upsert stale ignored' as test, qty = 5 as pass from public.collection_items where id = 'e1';

select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222"}', false);
select 'B cannot see A rows' as test, count(*) = 0 as pass from public.collection_items;
update public.collection_items set qty = 0, updated_at = now() where id = 'e1';
delete from public.collection_items where id = 'e1';
\echo '--- next statement must FAIL with a row-level security error:'
insert into public.collection_items (user_id, id, qty) values ('11111111-1111-1111-1111-111111111111','evil',1);
insert into public.decks (id, name, updated_at) values ('d1','B deck', now());
select 'B sees own deck' as test, count(*) = 1 as pass from public.decks;

reset role;
select 'A row untouched by B' as test, qty = 5 as pass from public.collection_items where id = 'e1';
select 'no evil row' as test, count(*) = 0 as pass from public.collection_items where id = 'evil';

set role anon;
\echo '--- next statement must FAIL with permission denied (anon):'
select count(*) from public.collection_items;
reset role;
