// Shotgun — ReccoBeats client
//
// ReccoBeats (reccobeats.com) is a free, no-auth, no-key public API that
// stands in for Spotify's own audio-features endpoint (closed to new apps
// Nov 2024). Verified LIVE on 2026-08-17 with real Spotify track IDs — see
// PROJECT-STATUS.md for the actual response fields/values this session got
// back. Her brother's DecklingAir (github.com/Py-xxx/DecklingAir,
// server/spotify.js) is the reference for this exact two-step lookup and the
// serialized/backed-off call queue; this file is Shotgun's from-scratch
// browser-side port of that same design.
//
// Two-step lookup, because ReccoBeats indexes by its OWN uuid, not Spotify's:
//   1. GET /v1/track?ids=<spotify_id>[,<spotify_id>,...]   (confirmed batch —
//      a 3-id comma-separated request worked live). Each result's `href` is
//      an open.spotify.com/track/<id> URL — THAT is how a result maps back
//      to the Spotify id that was asked for; the response array is NOT
//      guaranteed to preserve request order (confirmed live: a 3-id request
//      came back in a different order than requested).
//   2. GET /v1/track/<reccobeats_uuid>/audio-features       (per resolved id)
//
// A track ReccoBeats has never heard of comes back as `{content: []}` on
// step 1 — still HTTP 200, not an error. This client returns null for that
// id rather than throwing; a genuinely bad/unreachable batch also degrades
// to null-for-everything-in-it rather than blowing up the whole lookup.

const BASE_URL = 'https://api.reccobeats.com/v1';
const BATCH_SIZE = 40; // no documented cap; batches round trips without risking an oversized query string

// --- Polite call queue -------------------------------------------------
// Same design as the brief's Spotify 429 breaker, scaled down: a live smoke
// test (5 rapid sequential calls, no client-side gap) came back all-200 —
// ReccoBeats didn't 429 this session — but every call still goes through one
// serialized queue with a minimum gap, widening on any 429/5xx and relaxing
// on success, so nothing bursts on it if that ever changes.
const GAP_MIN_MS = 300;
const GAP_MAX_MS = 4000;
let gapMs = GAP_MIN_MS;
let chain = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throttled(fn) {
  const run = chain.then(async () => {
    await sleep(gapMs);
    return fn();
  });
  chain = run.then(
    () => {},
    () => {}
  ); // keep the chain alive whether this call succeeded or failed
  return run;
}

/** Serialized, backed-off fetch. Retries 429/5xx up to 3 times; throws on final failure. */
async function reccoFetch(url) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await throttled(() => fetch(url, { headers: { Accept: 'application/json' } }));
    } catch (networkErr) {
      // Network-level failure (offline, DNS, etc.) — treat as transient.
      if (attempt < maxAttempts) {
        await sleep(600 * 2 ** (attempt - 1));
        continue;
      }
      throw networkErr;
    }

    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      const retryAfterHeader = res.headers.get('Retry-After');
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
      if (attempt < maxAttempts) {
        gapMs = Math.min(GAP_MAX_MS, retryAfterMs || gapMs + 500);
        await sleep(retryAfterMs || 600 * 2 ** (attempt - 1));
        continue;
      }
      throw new Error(`ReccoBeats ${res.status} after ${maxAttempts} attempts`);
    }

    if (!res.ok) {
      // Genuine 4xx other than 429 — not transient, don't retry (e.g. a
      // malformed url would be a bug in this file, not a rate-limit).
      throw new Error(`ReccoBeats ${res.status} for ${url}`);
    }

    gapMs = Math.max(GAP_MIN_MS, gapMs - 100); // relax the gap a little on every success
    return res.json();
  }
}

function spotifyIdFromHref(href) {
  const m = /\/track\/([A-Za-z0-9]+)/.exec(href || '');
  return m ? m[1] : null;
}

function isNum(v) {
  return typeof v === 'number' && !Number.isNaN(v);
}

/** Normalise a raw /audio-features response to Shotgun's shared feature shape. */
function normaliseFeatures(raw) {
  if (!raw || !isNum(raw.tempo)) return null;
  const out = {
    energy: isNum(raw.energy) ? raw.energy : null,
    valence: isNum(raw.valence) ? raw.valence : null,
    tempo: raw.tempo,
  };
  if (isNum(raw.danceability)) out.danceability = raw.danceability;
  if (isNum(raw.acousticness)) out.acousticness = raw.acousticness;
  return out;
}

/** Resolve a batch of Spotify track ids to ReccoBeats uuids. Missing ids map to null. */
async function lookupUuids(spotifyIds) {
  const map = new Map();
  for (let i = 0; i < spotifyIds.length; i += BATCH_SIZE) {
    const batch = spotifyIds.slice(i, i + BATCH_SIZE);
    let data;
    try {
      data = await reccoFetch(`${BASE_URL}/track?ids=${batch.join(',')}`);
    } catch (err) {
      console.warn('[ReccoBeats] batch id lookup failed, treating batch as unknown:', err.message);
      for (const id of batch) map.set(id, null);
      continue;
    }
    const content = Array.isArray(data?.content) ? data.content : [];
    const bySpotifyId = new Map();
    for (const item of content) {
      const sid = spotifyIdFromHref(item.href);
      if (sid) bySpotifyId.set(sid, item.id);
    }
    for (const id of batch) map.set(id, bySpotifyId.get(id) || null);
  }
  return map;
}

/**
 * Look up audio features for a list of Spotify track IDs.
 * @param {string[]} spotifyTrackIds
 * @returns {Promise<Object<string, {energy:number, valence:number, tempo:number, danceability?:number, acousticness?:number}|null>>}
 *   Keyed by the ORIGINAL Spotify id. Value is null — never a throw — for
 *   any track ReccoBeats doesn't know, or whose features lookup ultimately
 *   fails after retries.
 */
export async function getAudioFeaturesBatch(spotifyTrackIds) {
  const ids = [...new Set((spotifyTrackIds || []).filter(Boolean))];
  const out = {};
  if (!ids.length) return out;

  const uuidMap = await lookupUuids(ids);

  for (const id of ids) {
    const uuid = uuidMap.get(id);
    if (!uuid) {
      out[id] = null;
      continue;
    }
    try {
      const raw = await reccoFetch(`${BASE_URL}/track/${uuid}/audio-features`);
      out[id] = normaliseFeatures(raw);
    } catch (err) {
      console.warn(`[ReccoBeats] features unavailable for ${id}:`, err.message);
      out[id] = null;
    }
  }
  return out;
}
