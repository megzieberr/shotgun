// Shotgun — config constants
//
// Everything a backend or the auth flow needs lives here so later sessions
// only have to touch one file. All values below are placeholders on purpose
// this session (scaffold + mock data only, no network calls of any kind).

// --- Spotify (Authorization Code with PKCE — no client secret exists, by
// design; see js/spotify-auth.js) ---
export const SPOTIFY_CLIENT_ID = 'c6da2250ec364e29aa5e32c057f9dd05';
export const SPOTIFY_AUTH_ENDPOINT = 'https://accounts.spotify.com/authorize';
export const SPOTIFY_TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
export const SPOTIFY_SCOPES = [
  'user-read-recently-played',
  'user-top-read',
  'user-library-read',
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
];

/**
 * The redirect URI is picked at RUNTIME, not stored as a constant, because
 * dev (127.0.0.1) and prod (GitHub Pages) need different exact strings —
 * Spotify matches redirect_uri byte-for-byte against what's registered on
 * the app. Both strings below are registered on her Spotify app already.
 *
 * IMPORTANT: dev login testing must load the app via 127.0.0.1:5208, NOT
 * localhost:5208 — same server, but Spotify treats them as different hosts
 * and will reject the redirect with an "INVALID_CLIENT: Insecure redirect
 * URI" style error if the page was opened via localhost.
 */
export function getSpotifyRedirectUri() {
  const hostname = typeof window !== 'undefined' ? window.location.hostname : '';
  return hostname === '127.0.0.1'
    ? 'http://127.0.0.1:5208/'
    : 'https://megzieberr.github.io/shotgun/';
}

// --- ReccoBeats (audio features cache lookup, session 2/3) ---
export const RECCOBEATS_BASE_URL = ''; // TODO session 2/3

// --- Supabase (taste profile + drive history, session 4) ---
export const SUPABASE_URL = ''; // TODO session 4 — whenworks account, free project slot (her ruling)
export const SUPABASE_ANON_KEY = ''; // TODO session 4

// --- Drive length ---
export const DEFAULT_DRIVE_MINUTES = 15;
export const DRIVE_LENGTH_OPTIONS = [15, 30, 45, 60, 90, 120];
export const MINUTES_PER_SONG = 3; // rough heuristic from the brief: ~3 min per song
export const MIN_SONGS_PER_DRIVE = 3;

export function songsForMinutes(minutes) {
  return Math.max(MIN_SONGS_PER_DRIVE, Math.round(minutes / MINUTES_PER_SONG));
}

// --- Mood presets ---
// Each preset now carries three pieces the real flow-order algorithm
// (js/flow-order.js) needs:
//   - `target`   an anchor feature vector (energy/valence/tempo/danceability/
//                acousticness) — the drive's starting neighbourhood.
//   - `filters`  min/max ranges per feature; a candidate failing ANY present
//                range is excluded from selection outright (see
//                passesMoodFilters in flow-order.js). A filter dimension is
//                skipped for tracks that don't have that field yet (e.g. the
//                mock library / early ReccoBeats lookups lacking
//                danceability), never treated as a hard fail.
//   - `familiarityWeighted` (Singalong only) — true means selection should
//                prefer tracks she knows best (most-played/most-finished)
//                once real play-history exists. With today's mock data every
//                track is treated as equally familiar (see flow-order.js),
//                so this is a documented no-op until Supabase data lands.
//   - `arc` (optional) — a gentle within-drive drift, e.g. Pumped Up easing
//                a little more intense toward the end. Never overrides the
//                hard adjacent-step smoothness requirement, just nudges it.
//
// `accent` names a CSS custom property (see css/styles.css) so every mood
// gets its own glow colour without inventing a new palette.
export const MOOD_PRESETS = {
  chilled: {
    id: 'chilled',
    label: 'Chilled',
    descriptor: 'Easy tempo, low stakes',
    icon: 'chilled',
    accent: '--mood-chilled',
    // Indie, easy, low-energy calm mornings (her ruling).
    target: { energy: 0.22, valence: 0.56, tempo: 78, danceability: 0.32, acousticness: 0.58 },
    filters: { energy: [0.10, 0.40], valence: [0.35, 0.72] },
    familiarityWeighted: false,
  },
  feelGood: {
    id: 'feelGood',
    label: 'Feel Good Vibes',
    descriptor: 'Windows down, know every word',
    icon: 'feelGood',
    accent: '--mood-feel-good',
    // Renamed from "Singalong" (2026-08-17 six-mood ruling) — same lane,
    // same target: film/soundtrack + Taylor Swift energy, defining trait is
    // she knows every word, hence familiarityWeighted (her ruling).
    target: { energy: 0.60, valence: 0.86, tempo: 120, danceability: 0.56, acousticness: 0.18 },
    filters: { energy: [0.45, 0.76], valence: [0.65, 1.00] },
    familiarityWeighted: true,
  },
  pumped: {
    id: 'pumped',
    label: 'Pumped Up',
    descriptor: 'Foot on the gas',
    icon: 'pumped',
    accent: '--mood-pumped',
    // Club music + hard rap — high energy, driving tempo (her ruling).
    target: { energy: 0.90, valence: 0.66, tempo: 145, danceability: 0.78, acousticness: 0.03 },
    filters: { energy: [0.78, 1.00], valence: [0.40, 0.90] },
    familiarityWeighted: false,
    arc: { energy: 0.10 }, // gentle build across the drive, brief's "Pumped Up may build" guidance
  },
  sadGangster: {
    id: 'sadGangster',
    label: 'Sad Gangster',
    descriptor: 'Moody 808s, main-character energy',
    icon: 'sadGangster',
    accent: '--mood-sad-gangster',
    // Emo rap (Juice WRLD, XXXTentacion, nothing,nowhere, MGK, Lithe) — LOW
    // valence but still groove/bounce: low valence + mid-high
    // danceability/energy, explicitly NOT acoustic ballads (her ruling).
    target: { energy: 0.47, valence: 0.17, tempo: 79, danceability: 0.62, acousticness: 0.12 },
    filters: {
      energy: [0.28, 0.62],
      valence: [0.00, 0.32],
      danceability: [0.42, 1.00],
      acousticness: [0.00, 0.30],
    },
    familiarityWeighted: false,
  },
  headBumping: {
    id: 'headBumping',
    label: 'Head Bumping',
    descriptor: 'Heavy riffs, all rage',
    icon: 'headBumping',
    accent: '--mood-head-bumping',
    // New mood (2026-08-17 six-mood ruling) — the metal/rage lane (Pantera,
    // Linkin Park, Maximum The Hormone per her seed list, MOOD-SEEDS.md).
    // Vector bound to her brief: energy 0.88 / valence 0.35 / high tempo;
    // danceability/acousticness are this session's best guess, not her
    // ruling — refine once her real seeds resolve to real audio features.
    target: { energy: 0.88, valence: 0.35, tempo: 155, danceability: 0.52, acousticness: 0.06 },
    filters: { energy: [0.70, 1.00], acousticness: [0.00, 0.40] },
    familiarityWeighted: false,
  },
  afrikaansRap: {
    id: 'afrikaansRap',
    label: 'Afrikaans Rap',
    descriptor: 'Local bars, home turf',
    icon: 'afrikaansRap',
    accent: '--mood-afrikaans-rap',
    // New mood (2026-08-17 six-mood ruling) — primarily SEED/ARTIST-driven,
    // not vector-driven (her brief): `target` below is only the fallback
    // used until real seeds resolve — resolveMoodAnchor() in js/app.js
    // already averages resolved MOOD_SEEDS features over this whenever any
    // exist for this mood, same generic mechanism every mood uses.
    // `filters: null` is deliberate — loose on purpose, this mood leans on
    // WHICH tracks get in (seeds + artist matches), not a feature band.
    target: { energy: 0.70, valence: 0.60 },
    filters: null,
    familiarityWeighted: false,
  },
};

export const MOOD_ORDER = ['chilled', 'feelGood', 'pumped', 'sadGangster', 'headBumping', 'afrikaansRap'];

// --- Mood seeds ---
// Real seed songs per mood. These six arrays start empty and are populated
// at runtime by js/seed-resolver.js's applyResolvedSeedsToConfig() (called
// from app.js on boot) from whatever's already resolved in localStorage —
// see js/mood-seeds-data.js for her raw song lists (MOOD-SEEDS.md) and the
// resolver that turns them into real Spotify track ids. When a mood has
// seed track IDs, the average of THOSE tracks' features overrides/refines
// the static `target` vector above for that mood — see resolveMoodAnchor()
// in js/app.js.
//
// Keyed the same way as MOOD_PRESETS/MOOD_ORDER above (`pumped`, not
// `pumpedUp`; `feelGood`, not `singalong`) so a resolved ID always lands on
// the mood it's meant for.
export const MOOD_SEEDS = {
  chilled: [],
  feelGood: [],
  pumped: [],
  sadGangster: [],
  headBumping: [],
  afrikaansRap: [],
};
