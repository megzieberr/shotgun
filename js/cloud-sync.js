// Shotgun — cloud sync
//
// A thin, fetch-based Supabase REST client — no @supabase/supabase-js
// dependency, since this is a static ES-module site with no build step.
// Handles sign-in/out (synthetic-email username+password, her house
// pattern) and every sync flow the learning loop needs: feature-cache
// merge, resolved-seeds merge, drive-history logging, taste-profile
// read/write.
//
// Local-first, always: every sync function here checks Supabase is
// configured AND she's signed in, and silently no-ops (a console.info, no
// toast, no UI change) if either isn't true — that's the expected state
// before she's run supabase/schema.sql and signed in once, not an error.
// A REAL failure once signed in (network hiccup, a genuine write error)
// DOES toast, per her "surface every save error" rule — see runSyncStep().
//
// Deliberately NOT a literal storage-adapter swap for feature-cache.js or
// seed-resolver.js, even though both modules expose a setStorageAdapter()
// seam for exactly that. Both modules' storage.load()/save() are called
// SYNCHRONOUSLY by existing callers (e.g. app.js's un-awaited
// applyResolvedSeedsToConfig() during boot) — swapping in a network-backed
// (necessarily async) adapter would make those calls silently see a Promise
// object instead of real data, degrading to "nothing resolved" without ever
// throwing. Instead, this module does an explicit async PULL-THEN-MERGE
// pattern: fetch the cloud rows, fold them into local storage via each
// module's own synchronous exports (putFeatures/getAllCached,
// mergeResolvedSeeds/getResolvedSeeds — see js/feature-cache.js and
// js/seed-resolver.js), then let the next synchronous read see the merged
// result. Same durability goal (resolved seeds + cached features survive a
// reinstall), zero risk to any existing synchronous call site.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import * as seedResolver from './seed-resolver.js';
import { putFeatures, getAllCached } from './feature-cache.js';

const SYNTHETIC_EMAIL_DOMAIN = 'shotgun.app';

const SESSION_KEY = 'shotgun.cloud.session.v1';
const LAST_SYNC_KEY = 'shotgun.cloud.lastSync.v1';

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn('Shotgun: cloud session read failed, treating as signed out', err);
    return null;
  }
}
function saveSession(session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch (err) {
    console.warn('Shotgun: could not persist the cloud session', err);
  }
}
function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch (err) {
    console.warn('Shotgun: could not clear the cloud session', err);
  }
}

export function isSupabaseConfigured() {
  return !!SUPABASE_URL && !!SUPABASE_ANON_KEY;
}
export function isSignedIn() {
  return !!(loadSession() && loadSession().access_token);
}
export function getSignedInUsername() {
  const s = loadSession();
  return s ? s.username : null;
}
export function getLastSyncedAt() {
  try {
    return localStorage.getItem(LAST_SYNC_KEY);
  } catch (err) {
    return null;
  }
}
function markSynced() {
  try {
    localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
  } catch (err) {
    // non-fatal — worst case the Settings "last synced" line goes stale
  }
}

function deriveEmail(username) {
  return `${String(username || '').trim().toLowerCase()}@${SYNTHETIC_EMAIL_DOMAIN}`;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function authFetch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error_description || data.msg || `Sign-in failed (${res.status})`), {
      status: res.status,
    });
  }
  return data;
}

/** @param {string} username @param {string} password @returns {Promise<{ok:boolean, error?:string}>} */
export async function signIn(username, password) {
  if (!isSupabaseConfigured()) return { ok: false, error: 'Cloud sync is not set up yet.' };
  try {
    const data = await authFetch('/token?grant_type=password', { email: deriveEmail(username), password });
    saveSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
      username: String(username || '').trim(),
    });
    return { ok: true };
  } catch (err) {
    console.warn('Shotgun: cloud sign-in failed', err);
    return { ok: false, error: 'Could not sign in — check the username and password.' };
  }
}

export function signOut() {
  clearSession();
}

// Single-flight refresh — same reasoning as js/spotify-client.js's (never
// touched directly, per the hard rule), but this is cloud-sync's own small
// copy: call volume here is a handful of REST calls per app open, nowhere
// near what warrants the full 429-breaker machinery Spotify needs.
let refreshInFlight = null;
async function ensureFreshToken() {
  const session = loadSession();
  if (!session) return null;
  if (session.expires_at - Date.now() > 5 * 60 * 1000) return session;
  if (!refreshInFlight) {
    refreshInFlight = authFetch('/token?grant_type=refresh_token', { refresh_token: session.refresh_token })
      .then((data) => {
        const next = {
          ...session,
          access_token: data.access_token,
          refresh_token: data.refresh_token || session.refresh_token,
          expires_at: Date.now() + (data.expires_in || 3600) * 1000,
        };
        saveSession(next);
        return next;
      })
      .catch((err) => {
        console.warn('Shotgun: cloud session refresh failed — signing out of cloud sync', err);
        clearSession();
        return null;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

// ---------------------------------------------------------------------------
// REST plumbing
// ---------------------------------------------------------------------------

class CloudUnavailableError extends Error {}
class CloudSchemaMissingError extends Error {}

/** True when a PostgREST error body means "the table/column isn't in the
 * schema cache" — i.e. supabase/schema.sql hasn't been run yet. That's
 * expected pre-setup state, not a real failure. */
function isSchemaMissingError(status, body) {
  if (status !== 404 && status !== 400) return false;
  if (body && typeof body.code === 'string' && body.code.startsWith('PGRST2')) return true;
  if (body && typeof body.message === 'string' && /schema cache|does not exist/i.test(body.message)) return true;
  return false;
}

async function restFetch(path, options = {}) {
  if (!isSupabaseConfigured()) throw new CloudUnavailableError('Supabase not configured');
  const session = await ensureFreshToken();
  if (!session) throw new CloudUnavailableError('not signed in');

  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (res.status === 204) return null;
  const text = await res.text().catch(() => '');
  const body = text ? JSON.parse(text) : null;

  if (!res.ok) {
    if (isSchemaMissingError(res.status, body)) {
      throw new CloudSchemaMissingError((body && body.message) || 'schema not ready');
    }
    throw Object.assign(new Error((body && body.message) || `Cloud request failed (${res.status})`), {
      status: res.status,
    });
  }
  return body;
}

// A page-level toast hook, registered once by app.js — kept as a setter
// rather than importing app.js directly (app.js already imports this
// module; importing back would be a cycle).
let toastHandler = null;
export function setToastHandler(fn) {
  toastHandler = fn;
}

/** Wraps one sync operation with the graceful-degrade + surfaced-error
 * rules: silently skip (console.info only) when not configured/signed in or
 * the schema isn't ready yet; toast on any OTHER failure once she's actually
 * signed in, per her "surface every save error" rule.
 * @param {string} label - short human name for console/toast messages
 * @param {() => Promise<any>} fn
 */
async function runSyncStep(label, fn) {
  if (!isSupabaseConfigured() || !isSignedIn()) return { ok: false, skipped: true };
  try {
    const result = await fn();
    markSynced();
    return { ok: true, result };
  } catch (err) {
    if (err instanceof CloudUnavailableError || err instanceof CloudSchemaMissingError) {
      console.info(`Shotgun: cloud sync skipped (${label}) — ${err.message}`);
      return { ok: false, skipped: true };
    }
    console.warn(`Shotgun: cloud sync failed (${label})`, err);
    if (toastHandler) toastHandler(`Cloud sync couldn't save (${label}).`);
    return { ok: false, error: err };
  }
}

// ---------------------------------------------------------------------------
// Feature-cache merge (push local-only, pull cloud-only)
// ---------------------------------------------------------------------------

const FEATURE_COLUMNS = 'spotify_id,energy,valence,tempo,danceability,acousticness';
const SYNC_BATCH = 200;

export async function syncFeatureCache() {
  return runSyncStep('feature cache', async () => {
    const local = getAllCached(); // id -> features|null
    const cloudRows = (await restFetch(`/track_features?select=${FEATURE_COLUMNS}`)) || [];
    const cloudIds = new Set(cloudRows.map((r) => r.spotify_id));

    const toCacheLocally = new Map();
    for (const row of cloudRows) {
      if (!local[row.spotify_id]) {
        toCacheLocally.set(row.spotify_id, {
          energy: row.energy,
          valence: row.valence,
          tempo: row.tempo,
          danceability: row.danceability,
          acousticness: row.acousticness,
        });
      }
    }
    if (toCacheLocally.size) putFeatures(toCacheLocally);

    const localOnlyIds = Object.keys(local).filter((id) => local[id] && !cloudIds.has(id));
    for (let i = 0; i < localOnlyIds.length; i += SYNC_BATCH) {
      const batch = localOnlyIds.slice(i, i + SYNC_BATCH).map((id) => ({
        spotify_id: id,
        energy: local[id].energy,
        valence: local[id].valence,
        tempo: local[id].tempo,
        danceability: local[id].danceability,
        acousticness: local[id].acousticness,
      }));
      await restFetch('/track_features?on_conflict=spotify_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(batch),
      });
    }

    return { pulled: toCacheLocally.size, pushed: localOnlyIds.length };
  });
}

// ---------------------------------------------------------------------------
// Resolved mood-seed merge
// ---------------------------------------------------------------------------

export async function syncResolvedSeeds() {
  return runSyncStep('seed songs', async () => {
    const local = seedResolver.getResolvedSeeds(); // {mood: [ids]}
    const cloudRows = (await restFetch('/mood_seeds?select=mood_key,spotify_id')) || [];
    const cloudByMood = {};
    for (const row of cloudRows) {
      (cloudByMood[row.mood_key] = cloudByMood[row.mood_key] || []).push(row.spotify_id);
    }

    seedResolver.mergeResolvedSeeds(cloudByMood);
    seedResolver.applyResolvedSeedsToConfig();

    const rows = [];
    for (const [mood, ids] of Object.entries(local)) {
      const already = new Set(cloudByMood[mood] || []);
      for (const id of ids || []) {
        if (!already.has(id)) rows.push({ mood_key: mood, spotify_id: id, source_raw: null });
      }
    }
    if (rows.length) {
      await restFetch('/mood_seeds?on_conflict=mood_key,spotify_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(rows),
      });
    }

    return { pulled: cloudRows.length, pushed: rows.length };
  });
}

// ---------------------------------------------------------------------------
// Drive history
// ---------------------------------------------------------------------------

/** @param {{kind:string, label:string, minutes:number, trackIds:string[], timeBucket:string}} drive */
export async function recordDriveHistory(drive) {
  return runSyncStep('drive history', async () => {
    await restFetch('/drive_history', {
      method: 'POST',
      body: JSON.stringify([
        {
          kind: drive.kind,
          mood_or_seed: drive.label,
          minutes: drive.minutes,
          track_ids: drive.trackIds,
          time_bucket: drive.timeBucket,
        },
      ]),
    });
  });
}

// ---------------------------------------------------------------------------
// Taste profile (artists + tracks + time-of-day) read/write
// ---------------------------------------------------------------------------

/** @returns {Promise<{artists:object, tracks:object, todProfiles:object}|null>} null when
 *  unavailable (not configured/signed in/schema missing) — callers treat that
 *  as "nothing to merge in," never as an error. */
export async function loadTasteState() {
  const result = await runSyncStep('taste read', async () => {
    const [artistRows, trackRows, todRows] = await Promise.all([
      restFetch('/taste_artists?select=artist_name,score,soft_ban_until'),
      restFetch('/taste_tracks?select=spotify_id,skip_count,soft_ban_until'),
      restFetch('/tod_profiles?select=bucket,target,sample_count'),
    ]);

    const artists = {};
    for (const r of artistRows || []) artists[r.artist_name] = { score: r.score, softBanUntil: r.soft_ban_until };

    const tracks = {};
    for (const r of trackRows || []) tracks[r.spotify_id] = { skipCount: r.skip_count, softBanUntil: r.soft_ban_until };

    const todProfiles = {};
    for (const r of todRows || []) todProfiles[r.bucket] = { target: r.target, sampleCount: r.sample_count };

    return { artists, tracks, todProfiles };
  });
  return result.ok ? result.result : null;
}

/** Upserts every row currently in the given learning state. Small dataset
 * (a personal library's worth of artists/tracks, three tod buckets) so a
 * full-table push on every reconcile pass is simple and cheap — no
 * per-field dirty-tracking needed. @param {object} state - js/learning.js's shape */
export async function pushTasteState(state) {
  return runSyncStep('taste write', async () => {
    const nowIso = new Date().toISOString();

    const artistRows = Object.entries(state.artists || {}).map(([name, v]) => ({
      artist_name: name,
      score: v.score,
      soft_ban_until: v.softBanUntil || null,
      updated_at: nowIso,
    }));
    const trackRows = Object.entries(state.tracks || {}).map(([id, v]) => ({
      spotify_id: id,
      skip_count: v.skipCount,
      soft_ban_until: v.softBanUntil || null,
      updated_at: nowIso,
    }));
    const todRows = Object.entries(state.todProfiles || {}).map(([bucket, v]) => ({
      bucket,
      target: v.target || {},
      sample_count: v.sampleCount || 0,
      updated_at: nowIso,
    }));

    if (artistRows.length) {
      await restFetch('/taste_artists?on_conflict=artist_name', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(artistRows),
      });
    }
    if (trackRows.length) {
      await restFetch('/taste_tracks?on_conflict=spotify_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(trackRows),
      });
    }
    if (todRows.length) {
      await restFetch('/tod_profiles?on_conflict=bucket', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(todRows),
      });
    }

    return { artists: artistRows.length, tracks: trackRows.length, tod: todRows.length };
  });
}
