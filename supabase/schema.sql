-- Shotgun — Supabase schema (session 4b)
--
-- Cloud twin of everything the app already keeps in localStorage: the audio-
-- feature cache, resolved mood seeds, the taste-learning profile (artist/
-- track scores + soft-bans), drive history, and time-of-day taste profiles.
-- The app degrades gracefully while this hasn't been run yet — local-first
-- behaviour continues either way, this just adds durability across a phone
-- change/reinstall and lets the learning loop read/write from one place.
--
-- ============================================================
-- MEGAN — click-steps to run this (once):
-- ============================================================
--   1. Supabase dashboard → this project (jgcutvnmmehqpskpvmzy) → SQL
--      Editor → New query → paste this whole file → Run.
--      Safe to re-run any time — every statement below is idempotent.
--   2. Authentication → Providers → Email → turn "Confirm email" OFF.
--      (Same reasoning as her other single-user apps: no email inbox for a
--      synthetic address to receive a confirmation link in.)
--   3. Create her one user, either:
--        a) Authentication → Users → Add user → email
--           `megan@shotgun.app` (or any address on that domain — see
--           js/cloud-sync.js's SYNTHETIC_EMAIL_DOMAIN) → set a real
--           password → Auto Confirm User: ON. RECOMMENDED — the dashboard
--           also creates the matching auth.identities row Supabase now
--           needs for email/password login to work; a raw SQL insert into
--           auth.users alone can leave that out.
--        b) OR, only if (a) fails for some reason, uncomment + fill in the
--           seed snippet at the very bottom of this file and re-run just
--           that block. Do not commit a real password to this repo either
--           way.
--   4. In the app: Settings → Cloud sync → sign in with the USERNAME part
--      only (e.g. "megan", not the full email) + that password. The app
--      turns the username into the synthetic email itself.
--   5. (Optional, whenever it's convenient) register this project with her
--      existing `supabase-keepalive-396` daily pinger fleet so it doesn't
--      auto-pause from inactivity — the `keepalive()` RPC below already
--      matches that worker's calling convention (anon-executable, no-op).
-- ============================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- track_features — cloud twin of js/feature-cache.js's localStorage cache.
-- One row per Spotify track id, looked up once (ReccoBeats), kept forever.
-- ---------------------------------------------------------------------
create table if not exists public.track_features (
  spotify_id    text primary key,
  energy        real,
  valence       real,
  tempo         real,
  danceability  real,
  acousticness  real,
  fetched_at    timestamptz not null default now()
);

alter table public.track_features enable row level security;
drop policy if exists "authenticated full access" on public.track_features;
create policy "authenticated full access" on public.track_features
  for all to authenticated using (true) with check (true);
revoke all on public.track_features from anon;
grant select, insert, update, delete on public.track_features to authenticated;

-- ---------------------------------------------------------------------
-- taste_artists — durable net taste score per artist (ported from
-- DecklingAir's server/spotify.js _artistTaste: +1 per engaged listen,
-- -1 per hard skip, clamped so taste can always recover). soft_ban_until
-- is Shotgun's own addition (see js/learning.js) — DecklingAir recovers a
-- down-scored artist only via a later engaged listen, which works fine for
-- an app that plays continuously all day; Shotgun only resurfaces an artist
-- if it's picked for a FUTURE drive, which an avoided artist by definition
-- won't be. Without a time-based expiry an avoided artist could never earn
-- its way back. The score itself is still the primary signal; the expiry is
-- a safety net under it.
-- ---------------------------------------------------------------------
create table if not exists public.taste_artists (
  artist_name    text primary key,  -- lowercased, same key DecklingAir uses
  score          integer not null default 0 check (score between -8 and 8),
  soft_ban_until timestamptz,
  updated_at     timestamptz not null default now()
);

alter table public.taste_artists enable row level security;
drop policy if exists "authenticated full access" on public.taste_artists;
create policy "authenticated full access" on public.taste_artists
  for all to authenticated using (true) with check (true);
revoke all on public.taste_artists from anon;
grant select, insert, update, delete on public.taste_artists to authenticated;

-- ---------------------------------------------------------------------
-- taste_tracks — durable per-track hard-skip count (ported from
-- DecklingAir's _trackDislikes: a hard skip bumps it, a full listen decays
-- it, soft-banned once it reaches TRACK_SOFTBAN_COUNT). soft_ban_until is
-- the same time-expiry safety net as taste_artists, above.
-- ---------------------------------------------------------------------
create table if not exists public.taste_tracks (
  spotify_id     text primary key,
  skip_count     integer not null default 0 check (skip_count >= 0),
  soft_ban_until timestamptz,
  updated_at     timestamptz not null default now()
);

alter table public.taste_tracks enable row level security;
drop policy if exists "authenticated full access" on public.taste_tracks;
create policy "authenticated full access" on public.taste_tracks
  for all to authenticated using (true) with check (true);
revoke all on public.taste_tracks from anon;
grant select, insert, update, delete on public.taste_tracks to authenticated;

-- ---------------------------------------------------------------------
-- mood_seeds — cloud twin of js/seed-resolver.js's resolved-seeds storage.
-- One row per (mood, accepted track) — a plain unique constraint (not
-- partial), so a straight upsert is safe here (her standing partial-index-
-- upsert gotcha doesn't apply to this index).
-- ---------------------------------------------------------------------
create table if not exists public.mood_seeds (
  id           bigint generated always as identity primary key,
  mood_key     text not null,
  spotify_id   text not null,
  source_raw   text,
  accepted_at  timestamptz not null default now(),
  unique (mood_key, spotify_id)
);

alter table public.mood_seeds enable row level security;
drop policy if exists "authenticated full access" on public.mood_seeds;
create policy "authenticated full access" on public.mood_seeds
  for all to authenticated using (true) with check (true);
revoke all on public.mood_seeds from anon;
grant select, insert, update, delete on public.mood_seeds to authenticated;

-- ---------------------------------------------------------------------
-- drive_history — one row per stocked drive (a log, not a per-track play
-- record — the per-track skip/win signal lives in taste_tracks/
-- taste_artists, reconciled from Spotify's recently-played, not from this
-- table). track_ids is the ordered queue as stocked.
-- ---------------------------------------------------------------------
create table if not exists public.drive_history (
  id            bigint generated always as identity primary key,
  started_at    timestamptz not null default now(),
  kind          text not null,       -- 'mood' | 'seed' | 'justPlay'
  mood_or_seed  text,                -- the mood label or seed track title
  minutes       integer,
  track_ids     text[] not null default '{}',
  time_bucket   text                 -- 'morning' | 'afternoon' | 'evening'
);

alter table public.drive_history enable row level security;
drop policy if exists "authenticated full access" on public.drive_history;
create policy "authenticated full access" on public.drive_history
  for all to authenticated using (true) with check (true);
revoke all on public.drive_history from anon;
grant select, insert, update, delete on public.drive_history to authenticated;

-- ---------------------------------------------------------------------
-- tod_profiles — one row per time-of-day bucket, a rolling-average learned
-- feature vector (energy/valence/tempo/danceability/acousticness) built
-- from tracks that WON (played through) during reconcile in that bucket.
-- "Just Play" anchors on this once sample_count > 0; falls back to the
-- library centroid until then (see js/learning.js, js/app.js).
-- ---------------------------------------------------------------------
create table if not exists public.tod_profiles (
  bucket        text primary key check (bucket in ('morning', 'afternoon', 'evening')),
  target        jsonb not null default '{}'::jsonb,
  sample_count  integer not null default 0,
  updated_at    timestamptz not null default now()
);

alter table public.tod_profiles enable row level security;
drop policy if exists "authenticated full access" on public.tod_profiles;
create policy "authenticated full access" on public.tod_profiles
  for all to authenticated using (true) with check (true);
revoke all on public.tod_profiles from anon;
grant select, insert, update, delete on public.tod_profiles to authenticated;

-- ---------------------------------------------------------------------
-- keepalive() — no-op RPC matching her existing keepalive-worker fleet's
-- convention (supabase-keepalive-396, ×10 projects, daily). Anon-executable
-- on purpose — the whole point is a ping that needs no auth round-trip.
-- SECURITY DEFINER with a pinned search_path (never leave it unset on a
-- SECURITY DEFINER function — that's the classic privilege-escalation
-- footgun). Does nothing but prove the project is awake.
-- ---------------------------------------------------------------------
create or replace function public.keepalive()
returns void
language sql
security definer
set search_path = public
as $$
  select 1;
$$;

grant execute on function public.keepalive() to anon;

-- ============================================================
-- OPTIONAL — create her one user via SQL instead of the dashboard (step 3b
-- above). Leave commented out unless she'd rather do it this way. Fill in a
-- REAL password before running, and never commit that filled-in password —
-- run this block once by hand in the SQL editor, don't leave it pasted here.
-- ============================================================
-- insert into auth.users (
--   instance_id, id, aud, role, email, encrypted_password,
--   email_confirmed_at, created_at, updated_at,
--   raw_app_meta_data, raw_user_meta_data
-- ) values (
--   '00000000-0000-0000-0000-000000000000',
--   gen_random_uuid(),
--   'authenticated',
--   'authenticated',
--   'megan@shotgun.app',                          -- username part is what she types in-app
--   crypt('REPLACE_WITH_A_REAL_PASSWORD', gen_salt('bf')),
--   now(), now(), now(),
--   '{"provider":"email","providers":["email"]}',
--   '{}'
-- );
