// Shotgun — Spotify backend
//
// Implements the api.js facade for real. Every network call is routed
// through spotify-client.js's spotifyFetch() (auth + the 429 breaker) —
// nothing in here ever calls fetch() directly.
//
// getAudioFeatures() deliberately answers "nothing new": Spotify's own
// audio-features endpoint has been dead to new apps since Nov 2024 (see
// PROJECT-STATUS.md's ReccoBeats findings from this build). Returning {}
// here just lets js/api.js's existing cache -> backend -> ReccoBeats
// fallback chain fall through to ReccoBeats, the actual source — this file
// doesn't duplicate that client.

import { spotifyFetch } from '../spotify-client.js';

// A deliberate ceiling: "open the app" should never trigger an unbounded
// library scan. A drive only ever needs a modest pool to flow-order a
// handful of songs from (~15-25 API calls per drive total, per the brief) —
// 200 saved tracks / 50-per-call = at most 4 paged calls to build the pool.
const LIBRARY_PAGE_SIZE = 50;
const LIBRARY_CAP = 200;

function msToSeconds(ms) {
  return Math.round((ms || 0) / 1000);
}

function normaliseTrack(raw) {
  if (!raw || !raw.id) return null;
  return {
    id: raw.id,
    title: raw.name,
    artist: (raw.artists || []).map((a) => a.name).join(', '),
    duration: msToSeconds(raw.duration_ms),
    // Deliberately NO energy/valence/tempo here — Spotify's saved-tracks,
    // search and recently-played responses never carry audio features.
    // js/api.js's getAudioFeatures() resolves them separately (cache ->
    // this backend's getAudioFeatures, which is a no-op -> ReccoBeats), and
    // the stocking pipeline (app.js's resolveCandidatePool step) drops any
    // track whose features never resolve before it ever reaches buildQueue.
  };
}

async function readJson(res) {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Spotify ${res.status}: ${text || res.statusText || 'request failed'}`);
  }
  return res.json();
}

export class SpotifyBackend {
  constructor() {
    this.name = 'spotify';
  }

  /**
   * Her saved tracks (GET /v1/me/tracks), paged 50/call, capped at
   * LIBRARY_CAP (200) tracks total.
   */
  async getLibrary() {
    const tracks = [];
    let url = `/me/tracks?limit=${LIBRARY_PAGE_SIZE}`;
    while (url && tracks.length < LIBRARY_CAP) {
      const res = await spotifyFetch(url);
      const data = await readJson(res);
      for (const item of data.items || []) {
        const t = normaliseTrack(item.track);
        if (t) tracks.push(t);
        if (tracks.length >= LIBRARY_CAP) break;
      }
      // Spotify's `next` is a full absolute URL; spotifyFetch accepts one
      // as-is (see its `path.startsWith('http')` check).
      url = tracks.length < LIBRARY_CAP ? data.next : null;
    }
    return tracks;
  }

  /** GET /v1/search?type=track */
  async searchTracks(query) {
    const q = (query || '').trim();
    if (!q) return [];
    const res = await spotifyFetch(`/search?type=track&limit=10&q=${encodeURIComponent(q)}`);
    const data = await readJson(res);
    return (data.tracks?.items || []).map(normaliseTrack).filter(Boolean);
  }

  /**
   * Resolve an artist by name (GET /v1/search?type=artist), then their top
   * tracks (GET /v1/artists/{id}/top-tracks) — used once-ever per artist
   * wildcard by js/seed-resolver.js, which caches the result forever so
   * this never runs twice for the same artist. `market=ZA` is a reasonable
   * default for her (South African) account, not a Spotify requirement —
   * fine to change once she's connected and it matters.
   */
  async searchArtistTopTracks(artistName) {
    const q = (artistName || '').trim();
    if (!q) return [];
    const searchRes = await spotifyFetch(`/search?type=artist&limit=1&q=${encodeURIComponent(q)}`);
    const searchData = await readJson(searchRes);
    const artist = searchData.artists?.items?.[0];
    if (!artist) return [];
    const topRes = await spotifyFetch(`/artists/${artist.id}/top-tracks?market=ZA`);
    const topData = await readJson(topRes);
    return (topData.tracks || []).map(normaliseTrack).filter(Boolean);
  }

  /** GET /v1/me/player/recently-played */
  async getRecentlyPlayed(limit = 20) {
    const res = await spotifyFetch(`/me/player/recently-played?limit=${Math.min(limit, 50)}`);
    const data = await readJson(res);
    return (data.items || [])
      .map((item) => ({
        trackId: item.track?.id,
        playedAt: item.played_at,
        // Spotify's recently-played doesn't report how much of a track
        // played (no msPlayed field exists on this endpoint) — session 4's
        // learning loop is the one that reconciles skip-vs-play from
        // consecutive played_at timestamps vs. track duration, not this
        // field. Left null rather than guessed.
        msPlayed: null,
        track: normaliseTrack(item.track),
      }))
      .filter((r) => r.trackId);
  }

  /**
   * Queues tracks in order — one POST per track (Spotify has no bulk-queue
   * endpoint), sequential and awaited through the breaker, never parallel;
   * a burst of parallel POSTs is exactly what the breaker exists to
   * prevent. Stops immediately (doesn't keep hammering) if Spotify reports
   * no active playback device.
   * @param {string[]} trackIds
   */
  async stockQueue(trackIds) {
    const ids = (trackIds || []).filter(Boolean);
    const queued = [];
    for (const id of ids) {
      const res = await spotifyFetch(`/me/player/queue?uri=${encodeURIComponent(`spotify:track:${id}`)}`, {
        method: 'POST',
      });

      if (res.status === 404) {
        // NO_ACTIVE_DEVICE is Spotify's real-world way of saying "nothing's
        // playing anywhere" — the fix per the brief is: open Spotify on the
        // phone, tap play/pause once (wakes a device), then retry. Stop the
        // whole stock immediately rather than 404-ing on every remaining
        // track.
        throw Object.assign(
          new Error('No active Spotify device — open Spotify, tap play/pause once, then try again.'),
          { code: 'NO_ACTIVE_DEVICE' }
        );
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Spotify queue request failed for ${id}: ${res.status} ${text}`);
      }
      queued.push(id);
    }
    return {
      ok: true,
      queuedAt: new Date().toISOString(),
      // Deliberately just ids: this backend has no cheap way to get full
      // display data (title/artist/energy/duration) back from a queue POST
      // (204 No Content, no body). app.js's runStockingFlow already has the
      // full resolved track objects it built the queue FROM — it renders
      // the confirm screen from those, not from this return value.
      tracks: queued.map((id) => ({ id })),
    };
  }

  /**
   * Spotify's own audio-features endpoint is dead (Nov 2024) — see the
   * module doc comment. Answering "nothing new" lets js/api.js's fallback
   * chain reach ReccoBeats instead of duplicating that client here.
   */
  async getAudioFeatures(_trackIds) {
    return {};
  }
}
