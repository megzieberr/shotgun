// Shotgun — Spotify backend (stub)
//
// Session 2 wires this up for real: Authorization Code with PKCE, the
// single-flight token refresh, and the 429-safe request queue described in
// the brief (min ~350ms gap between calls, widen on 429, honour
// Retry-After, hard-ban persisted to localStorage on long backoffs).
//
// Every method below matches the api.js facade signature exactly so app.js
// never has to change when this replaces the local backend — it just
// throws until then.

const NOT_WIRED = 'Spotify backend not wired yet (session 2)';

export class SpotifyBackend {
  constructor() {
    this.name = 'spotify';
  }

  async getLibrary() {
    throw new Error(NOT_WIRED);
  }

  async searchTracks(_query) {
    throw new Error(NOT_WIRED);
  }

  async getRecentlyPlayed(_limit = 20) {
    throw new Error(NOT_WIRED);
  }

  async stockQueue(_trackIds) {
    throw new Error(NOT_WIRED);
  }

  async getAudioFeatures(_trackIds) {
    throw new Error(NOT_WIRED);
  }
}
