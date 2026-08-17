// Shotgun — API facade
//
// The UI never talks to a backend directly. It calls these five methods;
// which backend actually answers is decided once, here.
//
// Backend selection:
//   - ?local=1 in the URL forces the local (mock) backend.
//   - Otherwise: local backend is the default fallback while no Spotify
//     auth exists yet (session 2 adds the real auth check).

import { LocalBackend } from './backends/local-backend.js';
import { SpotifyBackend } from './backends/spotify-backend.js';
import { getFeatures, putFeatures } from './feature-cache.js';
import { getAudioFeaturesBatch } from './reccobeats.js';

function hasSpotifyAuth() {
  // TODO session 2: check for a valid (or refreshable) token in localStorage.
  return false;
}

function resolveBackend() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('local') === '1') return new LocalBackend();
  if (hasSpotifyAuth()) return new SpotifyBackend();
  return new LocalBackend();
}

const backend = resolveBackend();

/** Which backend is actually live right now — handy for a settings-screen badge. */
export function activeBackendName() {
  return backend.name;
}

/** @returns {Promise<Array>} the full track library */
export function getLibrary() {
  return backend.getLibrary();
}

/** @param {string} query @returns {Promise<Array>} matching tracks */
export function searchTracks(query) {
  return backend.searchTracks(query);
}

/** @param {number} [limit] @returns {Promise<Array>} recently-played items, newest first */
export function getRecentlyPlayed(limit) {
  return backend.getRecentlyPlayed(limit);
}

/** @param {string[]} trackIds - ordered list to queue @returns {Promise<{ok:boolean, queuedAt:string, tracks:Array}>} */
export function stockQueue(trackIds) {
  return backend.stockQueue(trackIds);
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
    backendFeatures = (await backend.getAudioFeatures(missing)) || {};
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
