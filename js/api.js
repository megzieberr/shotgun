// Shotgun — API facade
//
// The UI never talks to a backend directly. It calls these methods; which
// backend actually answers is decided here, per call (not once at load
// time) — see getBackend() below for why that matters.
//
// Backend selection:
//   - ?local=1 in the URL forces the local (mock) backend, always.
//   - Otherwise: Spotify backend once a session exists (hasSpotifyAuth()),
//     local mock backend as the fallback before she's connected.

import { LocalBackend } from './backends/local-backend.js';
import { SpotifyBackend } from './backends/spotify-backend.js';
import { getFeatures, putFeatures } from './feature-cache.js';
import { getAudioFeaturesBatch } from './reccobeats.js';
import { hasSession } from './spotify-auth.js';
import { spotifyFetch } from './spotify-client.js';

/** True once a Spotify session (access + refresh token) exists. */
export function hasSpotifyAuth() {
  return hasSession();
}

function isLocalForced() {
  return new URLSearchParams(window.location.search).get('local') === '1';
}

// Backend selection is intentionally NOT resolved once at module-load time.
// app.js's boot sequence calls spotifyAuth.handleRedirectCallback() (which
// can save fresh tokens) BEFORE the first api.* call — if the backend were
// a fixed singleton computed at import time, the very first post-login page
// load would still see "not authed" and wrongly stay on the local backend
// until a full second reload. Re-checking per call (cheap: two localStorage
// reads) means login/logout take effect on the very next facade call.
let cached = null;
let cachedKey = null;

function getBackend() {
  const key = isLocalForced() ? 'local' : hasSpotifyAuth() ? 'spotify' : 'local';
  if (!cached || cachedKey !== key) {
    cached = key === 'spotify' ? new SpotifyBackend() : new LocalBackend();
    cachedKey = key;
  }
  return cached;
}

/** Which backend is actually live right now — handy for a settings-screen badge. */
export function activeBackendName() {
  return getBackend().name;
}

/** @returns {Promise<Array>} the full track library */
export function getLibrary() {
  return getBackend().getLibrary();
}

/** @param {string} query @returns {Promise<Array>} matching tracks */
export function searchTracks(query) {
  return getBackend().searchTracks(query);
}

/** @param {number} [limit] @returns {Promise<Array>} recently-played items, newest first */
export function getRecentlyPlayed(limit) {
  return getBackend().getRecentlyPlayed(limit);
}

/** @param {string[]} trackIds - ordered list to queue @returns {Promise<{ok:boolean, queuedAt:string, tracks:Array}>} */
export function stockQueue(trackIds) {
  return getBackend().stockQueue(trackIds);
}

/**
 * Her Spotify display name (GET /v1/me), for the Settings "connected as…"
 * line. Only meaningful once hasSpotifyAuth() is true; returns null rather
 * than throwing when there's no session so a caller can render a graceful
 * "not connected" state without a try/catch for the common case.
 * @returns {Promise<string|null>}
 */
export async function getConnectedDisplayName() {
  if (!hasSpotifyAuth()) return null;
  const res = await spotifyFetch('/me');
  if (!res.ok) throw new Error(`Shotgun: could not load the Spotify profile (${res.status}).`);
  const data = await res.json();
  return data.display_name || null;
}

/**
 * Look up audio features for a list of track ids, routed:
 *   1. feature-cache first (looked up once, cached forever)
 *   2. whatever's still missing goes to the active backend — for the local
 *      backend this answers instantly from its mock library (no network);
 *      for the Spotify backend this yields nothing, since Spotify's own
 *      audio-features endpoint is the one ReccoBeats exists to replace
 *   3. whatever's STILL missing goes to ReccoBeats — the path real Spotify
 *      track ids actually take once a real backend is wired up
 * Every new result (including confirmed-unknown -> null) is cached before
 * returning, so a track is only ever looked up once.
 * @param {string[]} trackIds
 * @returns {Promise<Object<string,{energy:number,valence:number,tempo:number,danceability?:number,acousticness?:number}|null>>}
 */
export async function getAudioFeatures(trackIds) {
  const ids = [...new Set((trackIds || []).filter(Boolean))];
  const out = {};
  if (!ids.length) return out;

  const { found, missing } = getFeatures(ids);
  for (const [id, features] of found) {
    if (features) out[id] = features;
  }
  if (!missing.length) return out;

  const toCache = new Map();
  let backendFeatures = {};
  try {
    backendFeatures = (await getBackend().getAudioFeatures(missing)) || {};
  } catch (err) {
    // Expected for the Spotify backend until session 2+ wires it (and even
    // then, Spotify's audio-features endpoint is dead) — non-fatal, falls
    // through to ReccoBeats below.
    console.warn('Shotgun: backend.getAudioFeatures failed, falling back to ReccoBeats', err);
  }

  const stillMissing = [];
  for (const id of missing) {
    if (backendFeatures[id]) {
      out[id] = backendFeatures[id];
      toCache.set(id, backendFeatures[id]);
    } else {
      stillMissing.push(id);
    }
  }

  if (stillMissing.length) {
    const reccoFeatures = await getAudioFeaturesBatch(stillMissing);
    for (const id of stillMissing) {
      const features = reccoFeatures[id] || null;
      out[id] = features;
      toCache.set(id, features);
    }
  }

  putFeatures(toCache);
  return out;
}

// ---------------------------------------------------------------------------
// Stocking-pipeline feature gate
// ---------------------------------------------------------------------------
// Foreman review rule: flow-order.js's weightedDistance() treats a track
// missing ALL comparable dimensions as distance 0 from every anchor (see its
// own doc comment — "nothing comparable — treat as equidistant, not
// infinitely far"). That's the right call for a track that's merely missing
// ONE dimension (say danceability), but it means a track with NO resolved
// features at all would score as a perfect match against every anchor and
// jump to the front of every queue. flow-order.js is deliberately left
// alone (a later session owns it) — the fix belongs at the stocking
// pipeline, one gate, before ANY pool ever reaches buildQueue.

function isFiniteNumber(v) {
  return typeof v === 'number' && !Number.isNaN(v);
}

/**
 * Pure gate (no network/cache access — exported mainly so this rule is
 * unit-testable without mocking localStorage or fetch): merges each track
 * with its already-resolved features and drops any track whose features
 * are missing entirely, OR too thin to compare (buildQueue's distance
 * function needs at least energy + valence + tempo to mean anything).
 * @param {Array<{id:string}>} tracks
 * @param {Object<string, object|null>} featuresById - id -> features, or
 *   null/undefined for unresolved/confirmed-unknown (getAudioFeatures' shape).
 * @returns {Array<object>} tracks merged with their features, features-only
 *   ones dropped — safe to hand straight to flow-order.js's buildQueue.
 */
export function keepTracksWithFeatures(tracks, featuresById) {
  const out = [];
  for (const t of tracks || []) {
    const f = t && featuresById ? featuresById[t.id] : null;
    if (!f) continue; // unresolved / confirmed-unknown — never let it reach buildQueue
    const merged = { ...t, ...f };
    if (!isFiniteNumber(merged.energy) || !isFiniteNumber(merged.valence) || !isFiniteNumber(merged.tempo)) {
      continue; // too thin to compare meaningfully even though SOMETHING resolved
    }
    out.push(merged);
  }
  return out;
}

/**
 * Resolve audio features for a track list (via getAudioFeatures — cache ->
 * backend -> ReccoBeats, same path everything else uses) and return ONLY
 * the tracks that resolved, merged with their features. This is what
 * app.js calls once per library load (and once per picked seed track) to
 * turn a raw library/search result into a pool buildQueue can safely use.
 * @param {Array<{id:string}>} tracks
 * @returns {Promise<Array<object>>}
 */
export async function resolveCandidatePool(tracks) {
  const list = tracks || [];
  if (!list.length) return [];
  const featuresById = await getAudioFeatures(list.map((t) => t.id));
  return keepTracksWithFeatures(list, featuresById);
}
