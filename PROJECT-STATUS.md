# Shotgun — project status

## What it is

A personal Spotify commute DJ for Megan. One tap before a drive stocks the
Spotify queue with a flow-ordered set of songs — chosen by mood, by a seed
song's vibe, or (later) by learned time-of-day taste — so everything is
decided before she pulls off and nothing needs touching mid-drive.

Full product brief: `C:\Users\megzi\Desktop\drive-dj-BRIEF.md` (app was
named "Drive DJ" there; renamed Shotgun before this build).

## Current state (build session 1 of 4 — scaffold + look)

Static ES-module PWA, no build step, mock data only. Nothing here talks to
Spotify, Supabase, or any external network — that starts in session 2+.

**Screens (all working against 40 invented mock songs):**
- Pre-drive home — 4 mood tiles (Chilled / Singalong / Pumped Up / Sad
  Gangster), "Just Play" stub, "This vibe" seed search, drive-length chips
  (15/30/45/60/90/120 min, ~1 song per 3 min).
- Stocking — brief animated EQ-bar visual, then confirmation with the
  ordered track list (title, artist, per-song energy bars) and a "You're
  set — drive safe" close.
- Settings — default drive length, Spotify account placeholder (disabled,
  "coming in a later build"), log-out placeholder (disabled).

**Architecture seams for sessions 2–4:**
- `js/api.js` — facade the UI calls: `getLibrary()`, `searchTracks(q)`,
  `getRecentlyPlayed(limit)`, `stockQueue(trackIds)`, `getAudioFeatures(trackIds)`.
- `js/backends/local-backend.js` — mock implementation, 40-song library.
  `?local=1` forces it; it's also the default fallback until Spotify auth
  exists (`hasSpotifyAuth()` in api.js is a TODO stub returning `false`).
- `js/backends/spotify-backend.js` — same interface, every method throws
  `"Spotify backend not wired yet (session 2)"`.
- `js/flow-order.js` — `orderForFlow(tracks, seed)`, a trivial greedy
  nearest-neighbour-by-energy walk. Clearly TODO'd for session 3's real
  algorithm (energy + valence + tempo weighted, artist spacing, taste
  weighting). The call seam (array in, reordered array out) is meant to
  survive that rewrite unchanged.
- `js/config.js` — Spotify client ID / redirect URI / scopes, ReccoBeats
  base URL, Supabase URL/key: all empty placeholders with TODO comments for
  the session that fills them in. Drive-length + mood-preset constants live
  here too (`MOOD_PRESETS`, `songsForMinutes()`).

## Next up

- Session 2: Spotify Authorization Code w/ PKCE, the 429-safe request queue
  from the brief, fill in `spotify-backend.js` for real.
- Session 3: real flow-ordering algorithm in `flow-order.js`.
- Session 4: Supabase schema (taste scores, time-of-day profiles, audio
  features cache, drive history) + the learning loop that makes "Just Play"
  real instead of a random-mix stub.
- Not done yet, deliberately out of this session's scope: any deploy, any
  git remote, any Supabase project, real Spotify calls.

## Rulings

- **English only.** No Afrikaans anywhere in this app — unlike her other
  (learner-facing) apps, this one is explicitly English-only.
- **Mood button names (final):** Chilled, Singalong, Pumped Up, Sad
  Gangster, plus "Just Play" as a fifth non-mood option.
- **Supabase** goes on the `whenworks` Supabase account's free project slot
  when session 4 needs it (per her note in the build brief) — do not create
  a new Supabase account for this.
- **Dev port:** 5208, `python -m http.server`, launch.json entry `shotgun`
  added at `C:\Users\megzi\.claude\.claude\launch.json` (the nested
  `.claude\.claude` path is correct, not a typo).
- **Theme name: "Amber Mile."** Dark cockpit-console palette (`--ink`
  `#0b0e14` background, `--panel` `#141a24` surfaces, `--amber` `#ff9d3f`
  primary glow, `--teal` `#34d1c4` secondary/"shotgun-seat-cool" accent,
  `--paper`/`--haze` for text). Signature element: a converging-highway
  motif in the app icon (two lane lines to a small amber sunrise/vanishing
  point) and EQ-bar energy indicators used both as a loading visualizer and
  as the per-song "how intense is this track" readout on the confirm
  screen — both read as dashboard/car-stereo instrumentation, tying
  directly into "phone in a dock at 07:00."
- **Fonts are system-stack only, deliberately** — this session's hard rule
  is zero external network calls, which rules out a Google Fonts CDN link.
  Display face is `Bahnschrift` (ships with Windows, reads as highway
  signage/dashboard type — a genuine fit, not just a fallback), body is
  `Segoe UI`, numerals/data use `Cascadia Mono`/`Consolas`. If she wants a
  custom webfont later, self-hosting the font files is the way to add one
  without breaking the no-external-calls rule.
- **Mood tiles get their own accent colour** (chilled = teal, singalong =
  amber, pumped up = a hot coral-red, sad gangster = a dusky violet) rather
  than one flat accent for all four — deliberate, keeps the "one tap"
  decision glanceable at a red light.
