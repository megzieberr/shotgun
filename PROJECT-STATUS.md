# Shotgun — project status — updated 2026-09-01

A personal Spotify commute DJ. One tap before a drive stocks the Spotify queue with a
flow-ordered set of songs — by mood, by a seed song's vibe, or by learned time-of-day taste — so
everything is decided before she pulls off and nothing needs touching mid-drive.

Full build diary (every session's write-up, the DecklingAir port notes, the Spotify plumbing
notes and the full test inventory) is in `PROJECT-HISTORY.md`. Catch-up does not read it.
Product brief: `C:\Users\megzi\Desktop\drive-dj-BRIEF.md` (named "Drive DJ" there).
Mood song lists: `MOOD-SEEDS.md` — canonical.

## Where we are

**SHIPPED & LIVE since 2026-08-17.** <https://megzieberr.github.io/shotgun/> — public repo
`megzieberr/shotgun`, Pages main/root, sw `shotgun-v7`. (The root-commit author was rewritten to
her noreply address before the first push, so no personal email sits in public history.)

- **Supabase project `shotgun`** (`jgcutvnmmehqpskpvmzy`, on the whenworks account's free slot):
  schema applied, migration-check PASSED — all 6 tables RLS-on, anon blocked, `keepalive()`
  pinned and anon-exec. Her user `megan@shotgun.app` exists, cloud sync ON, first sync verified
  in-DB: 218 track_features, 52 auto-accepted mood_seeds.
- **Spotify verified end to end live by Megan** on 127.0.0.1: login, 200-track library scan,
  ReccoBeats features, a real queue landing in her Spotify app.
- Six moods live: Chilled · Feel Good Vibes · Pumped Up · Sad Gangster · Head Bumping ·
  Afrikaans Rap, plus "Just Play" and "This vibe" (seed search).
- The taste-learning loop is in (`js/learning.js`, ported from her brother's DecklingAir):
  reconcile recently-played → classify win/skip → artist scores, track soft-bans, a rolling
  time-of-day vector; the pool is shaped before `buildQueue` so `flow-order.js` never changed.
- All 61 tests green.

## Decisions

(one-liners; full reasoning under the same date in `PROJECT-HISTORY.md`)

- **English only.** No Afrikaans anywhere in this app — unlike her learner-facing apps.
  Exemption: `js/mood-seeds-data.js` and `MOOD-SEEDS.md` may carry any language (it's her music,
  data not UI copy). Re-grep the repo after touching seed data.
- 2026-08-17 — **six moods, final:** Chilled, Feel Good Vibes, Pumped Up, Sad Gangster, Head
  Bumping, Afrikaans Rap. "Feel Good Vibes" replaced "Singalong" (same vector, key
  `singalong` → `feelGood`).
- Supabase lives on the **whenworks account's free project slot** — never a new account.
- ⚠️ **Spotify login testing MUST use `http://127.0.0.1:5208`, not `localhost:5208`** — the two
  registered redirect URIs are exact strings and Spotify matches byte-for-byte.
- Dev port 5208 (`python -m http.server`), launch.json entry `shotgun` in the nested
  `C:\Users\megzi\.claude\.claude\launch.json` (that doubled path is correct).
- **Theme "Amber Mile"** — dark cockpit console: `--ink` `#0b0e14`, `--panel` `#141a24`,
  `--amber` `#ff9d3f`, `--teal` `#34d1c4`. Converging-highway icon motif; EQ bars double as the
  loader and the per-song intensity readout.
- **System fonts only** — zero external network calls, so no Google Fonts. Bahnschrift display,
  Segoe UI body, Cascadia Mono/Consolas for numerals. A webfont would have to be self-hosted.
- **Each mood tile has its own accent colour** (not one flat accent) — keeps the one-tap decision
  glanceable at a red light.
- Cloud sync **never overwrites local**: it is a fill-gaps merge only; a full bidirectional
  last-write-wins sync would need per-field versioning (out of scope, flagged not oversold).
- Cloud-sync functions silently no-op when not configured or signed in, but a REAL failure once
  signed in DOES toast — her "surface every save error" rule.
- `feature-cache.js` / `seed-resolver.js` were deliberately NOT swapped to an async storage
  adapter: their storage is read synchronously by un-awaited callers, so an async adapter would
  hand those call sites a Promise and lose data quietly. Explicit pull-then-merge instead.
- Reconciliation reads ALL of recently-played, not just `drive_history`-matched tracks — a
  skip is real signal wherever the track came from. `drive_history` stays a log, not a filter.
- `SKIP_FRAC = 0.6` is HER single cutline (DecklingAir's dual strong/soft zone collapsed into
  one); `WIN_FRAC = 0.8` is ported exactly. `SOFT_BAN_EXPIRY_DAYS = 21` was ADDED because
  score-only recovery could never fire in an app that only plays on drives.
- The seed resolver never silently guesses: anything it is not confident about waits in the
  review queue for her.

## Pending on Megan

1. 📱 ~5 min — open the LIVE url on her phone, log in to Spotify + cloud sync
   (username `megan`), then Add to Home Screen (PWA install).
2. 📱 ~10 min — Review seed songs (gear → Review seed songs): ~30 uncertain
   matches awaiting her accept/skip.
3. 💻 2 min, whenever — register `shotgun` with the supabase-keepalive-396 pinger
   fleet (its `keepalive()` RPC already matches the convention).

## Next up

**After ~a week of real drives:** the tuning pass her "too fast?" instinct asked for — read
`drive_history` + the taste tables against reality, tune the resolver thresholds and the 60% skip
cutline, decide whether to raise the 200-song library cap, fix the sign-in papercut (strip a
typed @domain), then consider v3 (Discover Weekly weaving + a freshness dial). Read
`MOOD-SEEDS.md` and the Decisions above first.

Known refinement, not built: intermediate (not-yet-avoided) artist scores are not smoothly
down-weighted across every mood — today it is hard exclusion for avoided/banned tracks plus real
familiarity for Feel Good Vibes.
