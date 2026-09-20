-- Scoop Journal — Supabase schema
-- Paste this whole file into Supabase Dashboard → SQL Editor → New query → Run.

-- 1. Table -------------------------------------------------------------
create table if not exists public.recipes (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  title        text not null default 'Untitled',
  category     text default '',
  servings     text default '',
  source       text default '',
  ingredients  text default '',
  instructions text default '',
  tweaks       text default '',
  tags         text[] default '{}',
  rating       int default 0,
  photo_paths  text[] default '{}',
  -- batches: [{ "date": "iso-string", "note": "text", "rating": 1-5 }, ...]
  batches      jsonb default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists recipes_owner_idx on public.recipes (owner_id, updated_at desc);

-- 2. Row Level Security --------------------------------------------------
-- Nobody can read or write a row unless they're logged in AND own it.
alter table public.recipes enable row level security;

drop policy if exists "select own recipes" on public.recipes;
create policy "select own recipes" on public.recipes
  for select using (auth.uid() = owner_id);

drop policy if exists "insert own recipes" on public.recipes;
create policy "insert own recipes" on public.recipes
  for insert with check (auth.uid() = owner_id);

drop policy if exists "update own recipes" on public.recipes;
create policy "update own recipes" on public.recipes
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "delete own recipes" on public.recipes;
create policy "delete own recipes" on public.recipes
  for delete using (auth.uid() = owner_id);

-- 3. Storage bucket for photos -------------------------------------------
-- Photos are uploaded under a path like "<user_id>/<random-filename>.jpg".
-- The bucket is public (so <img src> just works with the returned URL),
-- but only the owner can upload/delete into their own folder, and paths
-- are unguessable, so this is a reasonable default for a personal app.
-- If you want photos fully private later, flip public to false and switch
-- the app to createSignedUrl() instead of getPublicUrl() — see README.

insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do nothing;

drop policy if exists "read photos" on storage.objects;
create policy "read photos" on storage.objects
  for select using (bucket_id = 'photos');

drop policy if exists "upload own photos" on storage.objects;
create policy "upload own photos" on storage.objects
  for insert with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "delete own photos" on storage.objects;
create policy "delete own photos" on storage.objects
  for delete using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
