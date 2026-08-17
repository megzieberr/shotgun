// Shotgun — feature cache
//
// Look up a track's audio features once, cache forever. localStorage-backed
// for this session; a later session swaps the storage adapter for a
// Supabase-backed one (setStorageAdapter below) without any caller
// (js/api.js is the only one) needing to change.

const STORAGE_KEY = 'shotgun.featureCache.v1';

// --- Storage layer ----------------------------------------------------
// Swappable: any adapter exposing { load(): object, save(obj): void }.
const localStorageAdapter = {
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      console.warn('Shotgun: feature cache read failed, starting empty this session', err);
      return {};
    }
  },
  save(all) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch (err) {
      // localStorage can throw (quota, private-browsing) — non-fatal, just
      // means this batch of lookups isn't persisted and gets re-fetched later.
      console.warn('Shotgun: feature cache write failed (not persisted this run)', err);
    }
  },
};

let storage = localStorageAdapter;

/** Swap the storage backend — e.g. a future Supabase-backed adapter. */
export function setStorageAdapter(adapter) {
  storage = adapter;
}

/**
 * @param {string[]} trackIds
 * @returns {{found: Map<string, object|null>, missing: string[]}}
 *   `found` includes cached NEGATIVE results too (a track ReccoBeats
 *   confirmed it doesn't know, cached as null) so those aren't re-asked
 *   every session; `missing` is only ids never looked up before.
 */
export function getFeatures(trackIds) {
  const all = storage.load();
  const found = new Map();
  const missing = [];
  for (const id of trackIds || []) {
    if (Object.prototype.hasOwnProperty.call(all, id)) {
      found.set(id, all[id]);
    } else {
      missing.push(id);
    }
  }
  return { found, missing };
}

/** @param {Map<string, object|null>} featureMap - id -> features, or null for a confirmed-unknown track */
export function putFeatures(featureMap) {
  if (!featureMap || !featureMap.size) return;
  const all = storage.load();
  for (const [id, features] of featureMap) {
    all[id] = features;
  }
  storage.save(all);
}

/**
 * The whole cache as one plain object (id -> features|null) — session 4b's
 * cloud-sync merge needs to enumerate everything local to know what's
 * local-only vs. cloud-only; getFeatures() alone can't answer that since it
 * requires the ids up front. Not used by any hot path — cheap regardless,
 * since the whole cache is already one JSON blob.
 * @returns {Object<string, object|null>}
 */
export function getAllCached() {
  return storage.load();
}
