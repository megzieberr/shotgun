// Shotgun — config constants
//
// Everything a backend or the auth flow needs lives here so later sessions
// only have to touch one file. All values below are placeholders on purpose
// this session (scaffold + mock data only, no network calls of any kind).

// --- Spotify (filled in session 2: Authorization Code with PKCE) ---
export const SPOTIFY_CLIENT_ID = ''; // TODO session 2: Spotify developer dashboard, Development Mode app
export const SPOTIFY_REDIRECT_URI = ''; // TODO session 2: the deployed GitHub Pages URL, e.g. https://<user>.github.io/shotgun/
export const SPOTIFY_AUTH_ENDPOINT = 'https://accounts.spotify.com/authorize'; // reference only, not called this session
export const SPOTIFY_TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token'; // reference only, not called this session
export const SPOTIFY_SCOPES = [
  // TODO session 2: trim to exactly what queue-stocking + recently-played needs
  'user-read-recently-played',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-top-read',
  'playlist-read-private',
];

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
// Each preset is an energy/valence window used to pull candidate tracks from
// the library. `accent` names a CSS custom property (see css/styles.css)
// so every mood gets its own glow colour without inventing a new palette.
export const MOOD_PRESETS = {
  chilled: {
    id: 'chilled',
    label: 'Chilled',
    descriptor: 'Easy tempo, low stakes',
    icon: 'chilled',
    accent: '--mood-chilled',
    energy: [0.10, 0.40],
    valence: [0.35, 0.72],
  },
  singalong: {
    id: 'singalong',
    label: 'Singalong',
    descriptor: 'Windows down, know every word',
    icon: 'singalong',
    accent: '--mood-singalong',
    energy: [0.45, 0.76],
    valence: [0.65, 1.00],
  },
  pumped: {
    id: 'pumped',
    label: 'Pumped Up',
    descriptor: 'Foot on the gas',
    icon: 'pumped',
    accent: '--mood-pumped',
    energy: [0.78, 1.00],
    valence: [0.40, 0.90],
  },
  sadGangster: {
    id: 'sadGangster',
    label: 'Sad Gangster',
    descriptor: 'Moody 808s, main-character energy',
    icon: 'sadGangster',
    accent: '--mood-sad-gangster',
    energy: [0.28, 0.62],
    valence: [0.00, 0.32],
  },
};

export const MOOD_ORDER = ['chilled', 'singalong', 'pumped', 'sadGangster'];
