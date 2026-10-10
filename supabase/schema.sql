-- =============================================================================
-- Spellbook cloud sync schema for Supabase
-- Run once in Supabase → SQL Editor (safe to re-run).
--
-- Every row belongs to a user (user_id = auth.uid()). Row Level Security makes
-- sure a signed-in user can only see and change their own rows; the anon key
-- alone can't read anything.
--
-- Sync columns:
--   updated_at  client timestamp of the last edit → last-write-wins
--   deleted     soft delete (tombstone) so deletions reach other devices
--   synced_at   server time of the last write → incremental pull cursor
-- =============================================================================

-- ---------- tables ----------
create table if not exists public.collection_items (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,                 -- client-generated UUID of the collection entry
  card_id    text,                                 -- Scryfall card (printing) id
  card       jsonb,                                -- snapshot of card data (name, set, image, prices…)
  qty        integer     check (qty is null or qty >= 0),
  foil       boolean     default false,
  condition  text        default 'NM',
  added_at   timestamptz,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  synced_at  timestamptz not null default clock_timestamp(),
  primary key (user_id, id)
);

create table if not exists public.decks (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,                 -- client-generated UUID of the deck
  name       text,
  format     text,
  cards      jsonb       not null default '[]'::jsonb,  -- [{ cardId, qty, section: main|side|commander }]
  card_data  jsonb       not null default '{}'::jsonb,  -- { [cardId]: card snapshot }
  created_at timestamptz,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  synced_at  timestamptz not null default clock_timestamp(),
  primary key (user_id, id)
);

create index if not exists collection_items_user_synced on public.collection_items (user_id, synced_at);
create index if not exists decks_user_synced            on public.decks (user_id, synced_at);

-- ---------- write trigger: last-write-wins guard + server sync cursor ----------
create or replace function public.spellbook_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Ignore stale writes: an older edit must never overwrite a newer one.
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null;
  end if;
  -- Rows can't be moved to another user.
  if tg_op = 'UPDATE' and new.user_id <> old.user_id then
    raise exception 'user_id cannot change';
  end if;
  new.synced_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists collection_items_before_write on public.collection_items;
create trigger collection_items_before_write
  before insert or update on public.collection_items
  for each row execute function public.spellbook_before_write();

drop trigger if exists decks_before_write on public.decks;
create trigger decks_before_write
  before insert or update on public.decks
  for each row execute function public.spellbook_before_write();

-- ---------- Row Level Security ----------
alter table public.collection_items enable row level security;
alter table public.decks            enable row level security;

drop policy if exists "own rows: select" on public.collection_items;
drop policy if exists "own rows: insert" on public.collection_items;
drop policy if exists "own rows: update" on public.collection_items;
drop policy if exists "own rows: delete" on public.collection_items;
create policy "own rows: select" on public.collection_items for select to authenticated using ((select auth.uid()) = user_id);
create policy "own rows: insert" on public.collection_items for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own rows: update" on public.collection_items for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own rows: delete" on public.collection_items for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "own rows: select" on public.decks;
drop policy if exists "own rows: insert" on public.decks;
drop policy if exists "own rows: update" on public.decks;
drop policy if exists "own rows: delete" on public.decks;
create policy "own rows: select" on public.decks for select to authenticated using ((select auth.uid()) = user_id);
create policy "own rows: insert" on public.decks for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own rows: update" on public.decks for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own rows: delete" on public.decks for delete to authenticated using ((select auth.uid()) = user_id);

-- ---------- privileges ----------
revoke all on public.collection_items, public.decks from anon;
grant select, insert, update, delete on public.collection_items, public.decks to authenticated;

-- Optional housekeeping (run manually or schedule with pg_cron):
-- delete from public.collection_items where deleted and synced_at < now() - interval '180 days';
-- delete from public.decks            where deleted and synced_at < now() - interval '180 days';
