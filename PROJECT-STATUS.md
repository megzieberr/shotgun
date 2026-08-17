# Shotgun — project status

## What it is

A personal Spotify commute DJ for Megan. One tap before a drive stocks the
Spotify queue with a flow-ordered set of songs — chosen by mood, by a seed
song's vibe, or (later) by learned time-of-day taste — so everything is
decided before she pulls off and nothing needs touching mid-drive.

Full product brief: `C:\Users\megzi\Desktop\drive-dj-BRIEF.md` (app was
named "Drive DJ" there; renamed Shotgun before this build).

## Current state (build session — Spotify plumbing: PKCE auth + 429 breaker)

Spotify auth, the 429-safe request breaker, and a real `spotify-backend.js`
are now built and unit-verified — but **nothing has been through a real
logged-in Spotify session yet**. Every method that needs a real account
(library fetch, search, recently-played, queue POST, /me) is "built and
unit/URL-verified, not live-verified" until Megan does the first login with
the foreman. See "Spotify plumbing session notes" below for exactly what's
proven vs. still open.

## Previous state (build session 3 of 4 — brain: flow ordering + ReccoBeats)

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

**Architecture seams still open for session 4:**
- `js/backends/spotify-backend.js` is now real (this session) — the only
  remaining seam is Supabase.
- Session 4 (Supabase): swap `feature-cache.js`'s storage adapter, add
  taste scores / time-of-day profiles / drive history, make "Just Play" a
  real learned mix instead of the honest "balanced mix" stub it is now.

## Next up

- **Megan + foreman: the first real Spotify login.** Everything Spotify
  needs a logged-in session for is built and unit/URL-verified but not
  live-verified — see "Spotify plumbing session notes" below for the full
  list of what that covers. Load the app via `http://127.0.0.1:5208`
  (NOT `localhost:5208` — Spotify matches the redirect URI string exactly),
  click Settings → Connect Spotify, log in for real, then re-run a mood
  drive and confirm a queue actually lands on the phone.
- Session 4: Supabase schema (taste scores, time-of-day profiles, audio
  features cache — swap `feature-cache.js`'s adapter — drive history) + the
  learning loop that makes "Just Play" real.
- Also waiting on Megan: real seed songs per mood for `MOOD_SEEDS` in
  `js/config.js` — superseded by `MOOD-SEEDS.md`'s six-mood rulings
  (2026-08-17); NOT this session's job to wire the new moods in, a later
  session resolves her song lists to real track ids and rebuilds
  `MOOD_PRESETS`/`MOOD_SEEDS`/`MOOD_ORDER` for six buttons.
- Not done yet, deliberately out of this session's scope: any deploy, any
  git remote, any Supabase project, any real (logged-in) Spotify call, any
  mood-UI change for the new six-mood ruling.

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

## Spotify plumbing session notes (PKCE auth + 429 breaker)

**New files:**
- `js/spotify-auth.js` — Authorization Code with PKCE. code_verifier +
  S256 code_challenge (crypto.subtle), authorize URL with a checked `state`
  param, redirect-callback handler that exchanges the code then scrubs the
  query string via `history.replaceState` (so a reload never re-exchanges
  a spent code), token storage in localStorage, and single-flight
  proactive refresh (< 5 min validity remaining).
- `js/spotify-client.js` — the 429 breaker + `spotifyFetch()` wrapper every
  `api.spotify.com` call goes through. On 401: one forced refresh + one
  retry, then a clear English error.

**Changed files:**
- `js/backends/spotify-backend.js` — filled in for real: `getLibrary()`
  (saved tracks, paged 50/call, **capped at 200 tracks**),
  `searchTracks()`, `getRecentlyPlayed()`, `stockQueue()` (sequential
  per-track POST through the breaker; a 404/no-active-device fails fast
  with a `NO_ACTIVE_DEVICE`-coded error app.js turns into a toast),
  `getAudioFeatures()` (deliberately returns `{}` so `api.js`'s existing
  cache → backend → ReccoBeats chain reaches ReccoBeats instead of this
  file duplicating that client).
- `js/api.js` — `hasSpotifyAuth()` is real; backend selection
  (`getBackend()`) is now resolved **per call**, not once at module load —
  needed because app.js's redirect-callback handling can save fresh tokens
  mid-boot, and a fixed singleton computed at import time would have stayed
  on the local backend until a second page load. Added
  `getConnectedDisplayName()` (GET /v1/me) and the stocking-pipeline gate:
  `resolveCandidatePool()` / `keepTracksWithFeatures()` — see next
  paragraph.
- `js/app.js` — boots by calling `spotifyAuth.handleRedirectCallback()`
  BEFORE any `api.*` call; wires Settings' Connect Spotify (starts PKCE),
  Log out (clears tokens, local data untouched), and a live display-name
  panel; all three drive builders now run off a `candidatePool` (library
  merged with resolved audio features, unresolved tracks dropped) instead
  of the raw `library`; `runStockingFlow` now renders the confirm screen
  from the already-resolved ordered-track objects it built the queue FROM,
  not from the backend's `stockQueue()` return value (the real Spotify
  queue POST is 204 No Content — nothing to reconstruct display data from);
  seed-search results guard against a track with no `energy` yet (real
  Spotify search hits won't have one) instead of crashing on
  `.toFixed()`; picking a seed now resolves that track's own audio
  features before it becomes the drive anchor.
- `sw.js` — added `js/spotify-auth.js` + `js/spotify-client.js` to
  PRECACHE_FILES, bumped `shotgun-v4` → `shotgun-v5`.

**The stocking-pipeline feature gate (foreman review rule):**
`flow-order.js`'s `weightedDistance()` treats a track with NO comparable
dimensions as distance 0 from every anchor (correct behaviour for "missing
one dimension", wrong for "missing everything" — see its own doc comment).
A raw Spotify library/search result has no audio features at all until
`getAudioFeatures()` resolves them, so without a gate, an unresolved track
would jump to the front of every queue. Enforced in `js/api.js`
(`keepTracksWithFeatures` — pure, unit-tested; `resolveCandidatePool` — the
async wrapper that calls `getAudioFeatures` then filters), never inside
`flow-order.js` itself, per the brief. `js/app.js` calls
`resolveCandidatePool()` once after every library load and once per picked
seed track, and passes the result (`candidatePool`), not raw `library`, to
every `buildQueue()` call.

**How the breaker maps to DecklingAir's design:** kept — one serialized
queue, min gap that widens ×2 on any 429 (floor 1000ms, cap 8000ms) and
relaxes ×0.9 per clean response (floor 350ms), Retry-After honoured
exactly, hard ban above 15s persisted so a reload doesn't re-probe,
single-flight token refresh. Simplified: DecklingAir runs TWO priority
tiers (interactive vs. background-bulk) because his server does continuous
background library/history warming and a background rate-limit must never
stall the player; Shotgun makes ~15-25 calls per drive total and does no
background scanning at all (per the brief), so there's nothing background
to protect the interactive tier from — one tier is enough. Also dropped:
his file-persisted breaker (`BREAKER_FILE`) — this is a browser app, so the
ban deadline is persisted to `localStorage` instead (read fresh on every
check, not cached in a module variable, so it survives a real page reload
the same way his survives a `pm2 restart`).

**The exact authorize URL this build produced** (captured live at
`http://127.0.0.1:5208`, redirected to Spotify's real login page — proof
Spotify accepted it as well-formed — then stopped there, no login
attempted, per the hard rule):
```
https://accounts.spotify.com/authorize?
  scope=user-read-recently-played+user-top-read+user-library-read+user-read-playback-state+user-modify-playback-state+playlist-read-private+playlist-read-collaborative
  &response_type=code
  &redirect_uri=http%3A%2F%2F127.0.0.1%3A5208%2F
  &state=73d17598da39d850a0511946216425bf
  &code_challenge_method=S256
  &client_id=c6da2250ec364e29aa5e32c057f9dd05
  &code_challenge=Tc0jXebJC7Tj8AxsW2Jk_E7FAdlWpeVPOH0Y6r9TAng
```

**Test results:** 25/25 passing across `tests/flow-order.test.mjs` (the
original 12, untouched), `tests/stocking-filter.test.mjs` (6, new — the
feature-gate rule, pure functions, no network),
`tests/spotify-auth.test.mjs` (3, new — PKCE S256 against the RFC 7636 §A.2
reference vector, single-flight refresh under 10 concurrent callers, no
refresh when validity is fine), `tests/spotify-client.test.mjs` (4, new —
soft 429 pauses ~2s, hard 429 (30s) bans immediately without waiting it out
and refuses all further calls locally, the ban survives a fresh
localStorage-backed check, gap widens on 429 / relaxes on success). Browser
smoke test at `http://127.0.0.1:5208`: default unauthed state correctly
shows the local backend + "Connect Spotify" in Settings; `?local=1` drove a
full Chilled-mood tap through to a rendered 5-track confirm screen with no
console errors; Connect Spotify produced the URL above.

**Everything still waiting on a real logged-in user (not live-verified this
session):** `getLibrary()`/`searchTracks()`/`getRecentlyPlayed()`/
`stockQueue()`/`getConnectedDisplayName()` against real Spotify data; the
token exchange and refresh round-trips against Spotify's real token
endpoint; the actual 200-track library cap in practice; the
`NO_ACTIVE_DEVICE` toast against a real "nothing's playing" state; whether
Spotify's `next` pagination links behave exactly as assumed in
`getLibrary()`'s loop.

**Uncertain / left for later:** the 200-track library cap is a judgement
call ("keeps the initial fetch sensible" per the brief), not something
tuned against her real library size — may want raising or lowering once
she's connected and the drive quality is visible; `mustInclude` on a seed
picked from Spotify search (not her own library) only actually forces a
lead-in slot if that track happens to be in `candidatePool` — a search hit
outside her library still anchors the drive via `anchor`, it just isn't
guaranteed the literal first slot (this seam already existed in the
scaffold's original wiring, not introduced this session).

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
- **Spotify login testing MUST use `http://127.0.0.1:5208`, not
  `localhost:5208`.** Same server, but the two registered Spotify redirect
  URIs are exact strings (`http://127.0.0.1:5208/` for dev,
  `https://megzieberr.github.io/shotgun/` for prod — picked at runtime by
  `getSpotifyRedirectUri()` in `js/config.js`) and Spotify matches
  redirect_uri byte-for-byte. Opening the app via `localhost` will build an
  authorize URL Spotify rejects.
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
