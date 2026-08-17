// Shotgun — Spotify fetch wrapper + 429 breaker
//
// Every api.spotify.com call goes through spotifyFetch() below. The design
// is ported from her brother's DecklingAir (server/spotify.js —
// _spotifyThrottle/_drainSpotify/_spotifySend): ONE serialized queue with a
// minimum gap between requests, widening on any 429 and relaxing gradually
// on success, honouring Retry-After exactly, with a persisted hard-ban
// circuit breaker above ~15s so reopening the app never probes back into a
// longer ban.
//
// Simplified from DecklingAir on purpose: his version runs TWO priority
// tiers (interactive vs. background-bulk, kept separate so a background
// rate-limit can't stall the player) because his server does continuous
// background library/history warming. Shotgun makes ~15-25 calls per drive
// total and does no background scanning at all (per the brief), so one tier
// is enough — there's nothing background to protect the interactive tier
// from. Also dropped: his two-tier queue-draining loop (kept, but
// single-tier) and his file-persisted breaker (BREAKER_FILE) — this is a
// browser app, so the breaker deadline is persisted to localStorage instead,
// which is the browser equivalent of "survive a restart".
//
// On a 401 (the proactive < 5min refresh in spotify-auth.js should make this
// rare): one forced refresh + one retry, then give up with a clear English
// error rather than looping.

import { getValidAccessToken, forceRefresh } from './spotify-auth.js';

const SPOTIFY_API = 'https://api.spotify.com/v1';

const GAP_MIN_MS = 350; // per the brief's "~350ms minimum gap"
const GAP_MAX_MS = 8000;
const HARD_BAN_THRESHOLD_MS = 15000; // brief: "Retry-After > ~15s = HARD BAN"
const MAX_ATTEMPTS = 3;

const BAN_KEY = 'shotgun.spotify.banUntil.v1';

let gapMs = GAP_MIN_MS;
let lastCallTs = 0;
let chain = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Persisted hard-ban deadline -------------------------------------------
// Read fresh from localStorage on every check (not cached in a module
// variable) so "reopening the app doesn't probe into a longer ban" holds
// even across a full page reload / new tab, not just within one session.

function readBanUntil() {
  try {
    const raw = localStorage.getItem(BAN_KEY);
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (err) {
    console.warn('Shotgun: could not read persisted Spotify ban deadline', err);
    return 0;
  }
}

function writeBanUntil(ts) {
  try {
    localStorage.setItem(BAN_KEY, String(ts));
  } catch (err) {
    console.warn('Shotgun: could not persist Spotify ban deadline', err);
  }
}

/** True while a persisted hard ban is in effect. */
export function isBanned() {
  return Date.now() < readBanUntil();
}

/** @returns {number} ms remaining on a hard ban, 0 if none. */
export function banRemainingMs() {
  return Math.max(0, readBanUntil() - Date.now());
}

function formatWait(ms) {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)} min`;
}

/** Thrown for both a hard ban and an exhausted soft-limit retry — always a
 * calm, English, ready-to-toast message with the wait time. */
export class SpotifyBanError extends Error {
  constructor(ms) {
    super(`Spotify is asking us to slow down — please wait about ${formatWait(ms)} and try again.`);
    this.name = 'SpotifyBanError';
    this.remainingMs = ms;
  }
}

// --- The serialized queue ---------------------------------------------------

function throttled(fn) {
  const run = chain.then(async () => {
    const wait = Math.max(0, lastCallTs + gapMs - Date.now());
    if (wait > 0) await sleep(wait);
    lastCallTs = Date.now();
    return fn();
  });
  // Keep the chain alive whether this job succeeded or failed, so one
  // rejected request never breaks every request queued after it.
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

/**
 * Low-level throttled + backed-off fetch, no auth attached. Exported (with a
 * leading underscore, by convention with flow-order.js's testable
 * internals) so the breaker mechanics — gap widen/relax, Retry-After
 * handling, hard-ban persistence — can be unit-verified with a mocked
 * `fetch` and no real Spotify token.
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function _throttledFetch(url, init) {
  if (isBanned()) throw new SpotifyBanError(banRemainingMs());

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (isBanned()) throw new SpotifyBanError(banRemainingMs());

    const res = await throttled(() => fetch(url, init));

    if (res.status === 429) {
      const retryAfterHeader = res.headers.get('Retry-After');
      const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      const raMs = Number.isFinite(retryAfterSec) && retryAfterSec >= 0 ? retryAfterSec * 1000 : 5000;

      // Widen the gap on ANY 429, soft or hard — the brief's "gap widens on
      // any 429, relaxes gradually on success".
      gapMs = Math.min(GAP_MAX_MS, Math.max(gapMs * 2, 1000));

      if (raMs > HARD_BAN_THRESHOLD_MS) {
        const until = Date.now() + raMs;
        writeBanUntil(until);
        console.warn(`Shotgun: Spotify HARD 429 — all Spotify traffic paused for ${Math.ceil(raMs / 1000)}s`);
        throw new SpotifyBanError(raMs);
      }

      console.warn(`Shotgun: Spotify soft 429 — pausing ${raMs}ms (gap now ${gapMs}ms)`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(raMs);
        continue;
      }
      // Retries exhausted on a short limit — surface the same calm error
      // rather than a raw fetch failure.
      throw new SpotifyBanError(raMs);
    }

    if (res.status >= 500 && res.status < 600 && attempt < MAX_ATTEMPTS) {
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }

    if (res.ok) {
      // Relax the gap a little on every clean response, floor at GAP_MIN.
      gapMs = Math.max(GAP_MIN_MS, Math.round(gapMs * 0.9));
    }
    return res;
  }
}

/**
 * Authenticated, throttled, breaker-protected fetch to a Spotify Web API
 * endpoint. `path` is either relative to /v1 (e.g. '/me/tracks') or a full
 * URL (Spotify's own pagination `next` links are full URLs).
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function spotifyFetch(path, init = {}) {
  if (isBanned()) throw new SpotifyBanError(banRemainingMs());

  const url = path.startsWith('http') ? path : `${SPOTIFY_API}${path}`;
  let token = await getValidAccessToken();

  const withAuth = (tok) => ({
    ...init,
    headers: { Authorization: `Bearer ${tok}`, ...(init.headers || {}) },
  });

  let res = await _throttledFetch(url, withAuth(token));

  if (res.status === 401) {
    // Proactive refresh (5 min margin, spotify-auth.js) should make this
    // rare — a defensive one-shot: force a refresh, retry once, then give
    // up with a clear message rather than looping.
    try {
      token = await forceRefresh();
    } catch (refreshErr) {
      throw new Error('Shotgun: Spotify session expired and could not refresh — please log in again.');
    }
    res = await _throttledFetch(url, withAuth(token));
    if (res.status === 401) {
      throw new Error('Shotgun: Spotify session expired — please log in again.');
    }
  }

  return res;
}

// --- Test hooks -------------------------------------------------------------
// In-memory throttle state only; the persisted ban key is deliberately NOT
// reset here (tests that need a clean ban state clear localStorage directly,
// same as production "the ban really did survive a reload" behaviour).

export function _resetThrottleForTests() {
  gapMs = GAP_MIN_MS;
  lastCallTs = 0;
  chain = Promise.resolve();
}

export function _getGapMsForTests() {
  return gapMs;
}
