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

/** @param {string[]} trackIds @returns {Promise<Object<string,{energy:number,valence:number,tempo:number}>>} */
export function getAudioFeatures(trackIds) {
  return backend.getAudioFeatures(trackIds);
}
