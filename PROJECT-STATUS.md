# Shotgun — project status

## What it is

A personal Spotify commute DJ for Megan. One tap before a drive stocks the
Spotify queue with a flow-ordered set of songs — chosen by mood, by a seed
song's vibe, or (later) by learned time-of-day taste — so everything is
decided before she pulls off and nothing needs touching mid-drive.

Full product brief: `C:\Users\megzi\Desktop\drive-dj-BRIEF.md` (app was
named "Drive DJ" there; renamed Shotgun before this build).

## Current state (build session 3 of 4 — brain: flow ordering + ReccoBeats)

Static ES-module PWA, no build step. Local mock backend (`?local=1`) still
has zero external network calls; the NEW ReccoBeats client is real and
network-capable, verified live, but only reached for track ids the local
mock library doesn't already know (i.e. never during a local-mode demo).

**Screens** unchanged from session 1 (pre-drive home, stocking, confirm,
settings) — this session rewired what happens BEHIND the mood tiles/seed
search/Just Play, not the UI markup.

**What's real now:**
- `js/flow-order.js` — the actual flow algorithm. `buildQueue(pool, options)`
  is a single greedy nearest-neighbour walk that does selection AND ordering
  together (see "the flow algorithm" below) — this is what app.js calls for
  every drive kind. `orderForFlow(tracks, anchor, options)` is the same walk
  run to completion over an already-chosen list (the old placeholder's call
  seam, kept). Both exported alongside `weightedDistance` and
  `passesMoodFilters` for testing.
- `js/reccobeats.js` — ReccoBeats client (batch id lookup → per-track
  audio-features, serialized + backed-off call queue). See "ReccoBeats
  findings" below for what the live API actually returns.
- `js/feature-cache.js` — localStorage-backed `getFeatures`/`putFeatures`,
  storage layer swappable via `setStorageAdapter()` for session 4's Supabase
  sync.
- `js/api.js` `getAudioFeatures()` now routes cache → backend → ReccoBeats,
  caching every new result (including confirmed-unknown as `null`).
- `js/config.js` `MOOD_PRESETS` — each mood now has a `target` anchor vector,
  `filters` (min/max ranges, missing dimensions never hard-fail), and
  `familiarityWeighted` (Singalong only). New `MOOD_SEEDS` slot (keyed
  `chilled`/`singalong`/`pumped`/`sadGangster` — note **not** `pumpedUp`,
  matching the existing MOOD_PRESETS/MOOD_ORDER keys) is empty and wired:
  drop real seed track ids in and `js/app.js`'s `resolveMoodAnchor()`
  averages their features to override the static `target` automatically.
- `js/backends/local-backend.js` — the 40-song mock library now also carries
  `danceability`/`acousticness` per track (matches what ReccoBeats actually
  returns), so the mood filters have real data to exercise fully offline.
- `tests/flow-order.test.mjs` — 12 tests, `node --test tests/`, mock library
  only, no network. All passing.

**Architecture seams still open for sessions 2 & 4:**
- `js/backends/spotify-backend.js` — untouched, still throws
  `"Spotify backend not wired yet (session 2)"` for every method. This
  session's `api.js` change calls it defensively (try/catch, falls through
  to ReccoBeats), so it stays safe to wire up in either order.
- Session 4 (Supabase): swap `feature-cache.js`'s storage adapter, add
  taste scores / time-of-day profiles / drive history, make "Just Play" a
  real learned mix instead of the honest "balanced mix" stub it is now.

## Next up

- Session 2: Spotify Authorization Code w/ PKCE, the 429-safe request queue
  from the brief, fill in `spotify-backend.js` for real.
- Session 4: Supabase schema (taste scores, time-of-day profiles, audio
  features cache — swap `feature-cache.js`'s adapter — drive history) + the
  learning loop that makes "Just Play" real.
- Waiting on Megan: real seed songs per mood for `MOOD_SEEDS` in
  `js/config.js` (empty for all four moods right now — override logic is
  wired and will "just work" the moment ids land, per the build brief).
- Not done yet, deliberately out of this session's scope: any deploy, any
  git remote, any Supabase project, real Spotify calls, touching
  `spotify-backend.js`.

## Session 3 notes (brain: flow ordering + ReccoBeats)

**The flow algorithm, in ~5 lines:** `buildQueue` filters the candidate pool
by the mood's min/max feature ranges (a field the track lacks never
hard-fails), then runs ONE greedy walk from the anchor: at each step, pick
the nearest (weighted energy + relative-tempo-gap + valence + danceability
distance) unpicked track to the current position, with seeded randomness
among near-ties so two drives with the same anchor differ. Selection and
ordering are the same walk — a far-off cluster is only ever reached once
everything closer is used up, which is what actually guarantees no jarring
jumps (an earlier "shortlist then random-sample" design could strand an
outlier the ordering pass alone couldn't fix — caught and rewritten during
this session's own browser verification, see below).

**ReccoBeats findings (live, 2026-08-17):**
- No auth, no API key. Base `https://api.reccobeats.com/v1`.
- Two-step lookup: `GET /track?ids=<spotify_id>[,<spotify_id>...]` (batch —
  confirmed a 3-id comma-separated request works) resolves Spotify track ids
  to ReccoBeats' own uuid; each result's `href` field is an
  `open.spotify.com/track/<id>` URL, which is the reliable way to map a
  result back to the id that was requested — **the response array does NOT
  preserve request order** (confirmed live). Then
  `GET /track/<uuid>/audio-features` returns the actual features.
- Real response fields (from `Blinding Lights`, `Never Gonna Give You Up`,
  `Mr. Brightside`): `id, href, isrc, acousticness, danceability, energy,
  instrumentalness, key, liveness, loudness, mode, speechiness, tempo,
  valence` — same shape Spotify's old dead endpoint used.
- Example live values: Blinding Lights → energy 0.73, valence 0.334, tempo
  171.0, danceability 0.513, acousticness 0.00143. Never Gonna Give You Up →
  energy 0.939, valence 0.914, tempo 113.3, danceability 0.721, acousticness
  0.115.
- A batch id lookup for a well-formed-but-unknown id returns HTTP 200 with
  `{content: []}` — not an error. `audio-features` for an unknown uuid
  returns HTTP 404.
- Rate behaviour: 5 rapid sequential calls (no client-side gap) all came
  back 200 — no 429 seen this session. Per-call latency ran ~0.9–1.3s
  (server-side, not something a client gap changes). The client still
  serializes every call through one queue (300ms min gap, backs off to 4s
  max on any 429/5xx, honours `Retry-After` when present) per the brief's
  429-protection design, since ReccoBeats' actual limits aren't documented.
- Reference: her brother's DecklingAir (`github.com/Py-xxx/DecklingAir`,
  `server/spotify.js`) uses this exact two-step lookup + the same serialized
  /backed-off queue design; `js/reccobeats.js` is Shotgun's from-scratch
  browser port of it.

**Mood vectors chosen** (full detail in `js/config.js`):
- Chilled: target energy 0.22 / valence 0.56 / tempo 78, filters energy
  [0.10, 0.40] / valence [0.35, 0.72] (unchanged from session 1's bands).
- Singalong: target energy 0.60 / valence 0.86 / tempo 120, filters energy
  [0.45, 0.76] / valence [0.65, 1.00], `familiarityWeighted: true`.
- Pumped Up: target energy 0.90 / valence 0.66 / tempo 145, filters energy
  [0.78, 1.00] / valence [0.40, 0.90], `arc: { energy: 0.10 }` (gentle build).
- Sad Gangster: target energy 0.47 / valence 0.17 / tempo 79, filters energy
  [0.28, 0.62] / valence [0.00, 0.32] / danceability [0.42, 1.00] /
  acousticness [0.00, 0.30] — the danceability/acousticness ranges are what
  actually keeps acoustic ballads out (verified in tests and against a
  fixture track mixed into the real 40-song pool).

**Uncertain / left for later:**
- ReccoBeats' true rate limit is still unknown (never hit a 429 in testing)
  — the client is defensively throttled but the numbers (300ms/4s) are
  guesses, not measured limits.
- `familiarityWeighted` is fully wired but a documented no-op with mock
  data (every track defaults to familiarity 1) — needs session 4's real
  play-history to do anything.
- Batch size cap of 40 for the ReccoBeats id-lookup endpoint is untested
  above 3 ids live; picked as a conservative round number, not verified.

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
