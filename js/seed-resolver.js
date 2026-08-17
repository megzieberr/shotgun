// Shotgun — seed-song resolver
//
// Turns Megan's raw mood-seed lists (js/mood-seeds-data.js, transcribed from
// MOOD-SEEDS.md) into real Spotify track ids: search for each entry, score
// how confident the top match is, auto-accept confident matches, queue
// everything uncertain for her to eyeball in the review UI (js/app.js).
//
// Two halves, deliberately kept separable:
//   - PURE matching logic (normalize/similarity/scoreCandidate/
//     classifyEntry) — no network, no storage, unit-tested directly in
//     tests/seed-resolver.test.mjs against mocked search results.
//   - Orchestration + storage (resolveAllMoodSeeds, accept/skip, the
//     localStorage adapter) — exercised via the browser DOM, not Node
//     tests, same reasoning as js/api.js's resolveCandidatePool (both touch
//     `window`/localStorage at call time, which a plain `node --test`
//     environment doesn't have).
//
// Storage is behind a small swappable adapter (same pattern as
// js/feature-cache.js) so session 4b can move this to Supabase without
// touching the matching logic or app.js's calls into this module.

import { MOOD_SEEDS } from './config.js';
import { MOOD_SEED_ENTRIES, ARTIST_WILDCARDS } from './mood-seeds-data.js';
import { searchTracks, searchArtistTopTracks } from './api.js';

// ---------------------------------------------------------------------------
// Pure matching logic
// ---------------------------------------------------------------------------

/** Lowercase, strip diacritics, collapse anything non-alphanumeric to a
 * single space — so "SICKO MODE!!" and "Sicko Mode" (or "Satusfaction" vs
 * "Satisfaction" once bestGuess has already fixed the spelling) compare on
 * substance, not punctuation/case. */
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics left behind by NFKD
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

/** 0..1 normalized-edit-distance similarity between two free-text strings. */
function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  const maxLen = Math.max(na.length, nb.length);
  if (!maxLen) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

/** Her raw/bestGuess string is "Title - Artist" — split on the FIRST
 * " - " (titles occasionally contain their own hyphens without spaces
 * around them, e.g. "step into my life", which this leaves alone).
 * bestGuess wins when present; raw is the query otherwise.
 * @param {{raw:string, bestGuess?:string}} entry
 * @returns {{title:string, artist:string}}
 */
export function parseEntryQuery(entry) {
  const source = (entry && (entry.bestGuess || entry.raw)) || '';
  const idx = source.indexOf(' - ');
  if (idx === -1) return { title: source.trim(), artist: '' };
  return { title: source.slice(0, idx).trim(), artist: source.slice(idx + 3).trim() };
}

const TITLE_WEIGHT = 0.7;
const ARTIST_WEIGHT = 0.3;

/** Weighted title+artist similarity between an entry and one search
 * candidate. A candidate with no artist parsed from the entry (rare —
 * every real entry has one) doesn't get penalised on artist.
 * @param {{raw:string, bestGuess?:string}} entry
 * @param {{title:string, artist:string}} candidate
 * @returns {number} 0..1
 */
export function scoreCandidate(entry, candidate) {
  const { title, artist } = parseEntryQuery(entry);
  const titleScore = similarity(title, candidate && candidate.title);
  const artistScore = artist ? similarity(artist, candidate && candidate.artist) : 1;
  return titleScore * TITLE_WEIGHT + artistScore * ARTIST_WEIGHT;
}

/**
 * @param {{raw:string, bestGuess?:string}} entry
 * @param {Array<{id:string, title:string, artist:string}>} candidates
 * @returns {{best:object|null, score:number, ranked:Array<{candidate:object, score:number}>}}
 */
export function pickBestMatch(entry, candidates) {
  const ranked = (candidates || [])
    .map((candidate) => ({ candidate, score: scoreCandidate(entry, candidate) }))
    .sort((a, b) => b.score - a.score);
  return {
    best: ranked.length ? ranked[0].candidate : null,
    score: ranked.length ? ranked[0].score : 0,
    ranked,
  };
}

// Tuned by hand against the typo cases in tests/seed-resolver.test.mjs
// (bestGuess-corrected titles score ~0.95+; a wrong-song match scores well
// under this). Exported so tests can assert against it directly rather than
// a duplicated magic number.
export const AUTO_ACCEPT_THRESHOLD = 0.82;

/**
 * Decide auto-accept vs. review for one entry against its search results.
 * An `unsure` row (her own flag in MOOD-SEEDS.md) NEVER auto-accepts,
 * regardless of score — always queued for her review, per the hard rule.
 * @param {{raw:string, bestGuess?:string, unsure?:boolean}} entry
 * @param {Array<object>} candidates
 * @param {number} [threshold=AUTO_ACCEPT_THRESHOLD]
 * @returns {{status:'auto'|'review', best:object|null, score:number, alternatives:object[]}}
 */
export function classifyEntry(entry, candidates, threshold = AUTO_ACCEPT_THRESHOLD) {
  const { best, score, ranked } = pickBestMatch(entry, candidates);
  const alternatives = ranked.slice(0, 3).map((r) => r.candidate);
  if (!entry.unsure && best && score >= threshold) {
    return { status: 'auto', best, score, alternatives };
  }
  return { status: 'review', best, score, alternatives };
}

// ---------------------------------------------------------------------------
// Storage (swappable — 4b's Supabase seam)
// ---------------------------------------------------------------------------

const RESOLVED_KEY = 'shotgun.moodSeeds.resolved.v1';
const PENDING_KEY = 'shotgun.moodSeeds.pendingReview.v1';
const ARTIST_CACHE_KEY = 'shotgun.moodSeeds.artistCache.v1';
const RAN_ONCE_KEY = 'shotgun.moodSeeds.ranOnce.v1';
const OFFERED_KEY = 'shotgun.moodSeeds.reviewOffered.v1';

const localStorageAdapter = {
  load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (err) {
      console.warn(`Shotgun: seed-resolver storage read failed for ${key}`, err);
      return fallback;
    }
  },
  save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.warn(`Shotgun: seed-resolver storage write failed for ${key}`, err);
    }
  },
};

let storage = localStorageAdapter;

/** Swap the storage backend — e.g. a future Supabase-backed adapter (4b). */
export function setStorageAdapter(adapter) {
  storage = adapter;
}

export function getResolvedSeeds() {
  return storage.load(RESOLVED_KEY, {}) || {};
}
function saveResolvedSeeds(obj) {
  storage.save(RESOLVED_KEY, obj);
}

/** @returns {Array<{id:string, moodKey:string, entry:object, query:string, best:object|null, score:number, alternatives:object[]}>} */
export function getPendingReviewItems() {
  return storage.load(PENDING_KEY, []) || [];
}
function savePendingReviewItems(list) {
  storage.save(PENDING_KEY, list);
}

export function hasResolvedOnce() {
  return !!storage.load(RAN_ONCE_KEY, false);
}
function markResolvedOnce() {
  storage.save(RAN_ONCE_KEY, true);
}

export function hasOfferedReview() {
  return !!storage.load(OFFERED_KEY, false);
}
export function markReviewOffered() {
  storage.save(OFFERED_KEY, true);
}

function getArtistCache() {
  return storage.load(ARTIST_CACHE_KEY, {}) || {};
}
function saveArtistCache(obj) {
  storage.save(ARTIST_CACHE_KEY, obj);
}

/** Copies whatever's already resolved in storage onto the live MOOD_SEEDS
 * runtime object from js/config.js (mutating it in place — MOOD_SEEDS is a
 * `const` reference, not a frozen object, and app.js's resolveMoodAnchor()
 * reads the SAME object instance, so this is what makes a resolved seed
 * actually affect the next drive built). Safe to call on every boot, before
 * any resolution has ever run (resolved stays `{}`, MOOD_SEEDS stays empty
 * arrays) and after every accept/skip in the review UI. */
export function applyResolvedSeedsToConfig() {
  const resolved = getResolvedSeeds();
  for (const key of Object.keys(MOOD_SEEDS)) {
    MOOD_SEEDS[key] = resolved[key] || MOOD_SEEDS[key] || [];
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function resolveEntries(moodKey, entries, search, callCounter) {
  const autoIds = [];
  const pending = [];
  for (const entry of entries) {
    const { title, artist } = parseEntryQuery(entry);
    const query = [title, artist].filter(Boolean).join(' ');
    let candidates = [];
    try {
      candidates = (await search(query)) || [];
      callCounter.calls++;
    } catch (err) {
      console.warn(`Shotgun: seed search failed for "${query}"`, err);
    }
    const result = classifyEntry(entry, candidates);
    if (result.status === 'auto') {
      autoIds.push(result.best.id);
    } else {
      pending.push({
        id: `${moodKey}:${normalize(title)}:${normalize(artist)}`,
        moodKey,
        entry,
        query,
        best: result.best,
        score: result.score,
        alternatives: result.alternatives,
      });
    }
  }
  return { autoIds, pending };
}

async function resolveArtistWildcard(artistName, searchArtist, callCounter) {
  const cache = getArtistCache();
  const key = artistName.toLowerCase();
  if (cache[key]) return cache[key];

  let ids = [];
  try {
    const tracks = (await searchArtist(artistName)) || [];
    callCounter.calls++;
    ids = tracks.map((t) => t.id).filter(Boolean);
  } catch (err) {
    console.warn(`Shotgun: artist wildcard resolution failed for "${artistName}"`, err);
  }
  cache[key] = ids; // cache even an empty result — "once-ever", not "once-ever-successful"
  saveArtistCache(cache);
  return ids;
}

/**
 * Run the full resolution pass over every mood's seed list + artist
 * wildcards (js/mood-seeds-data.js): search, score, auto-accept confident
 * matches, queue everything else for review. Meant to run once-ever per
 * device (gated by hasResolvedOnce() in app.js) — safe to re-run, but a
 * re-run repeats every search call (nothing here short-circuits on
 * "already resolved" except the artist-wildcard cache, which is genuinely
 * a permanent cache).
 * @param {object} [options]
 * @param {(query:string)=>Promise<Array>} [options.search] - defaults to
 *   js/api.js's searchTracks; overridable for tests/other backends.
 * @param {(artistName:string)=>Promise<Array>} [options.searchArtist] -
 *   defaults to js/api.js's searchArtistTopTracks.
 * @param {(done:number, total:number)=>void} [options.onProgress] - called
 *   once per mood processed (6 total), not per song.
 * @returns {Promise<{resolved:object, pending:Array, callsMade:number}>}
 */
export async function resolveAllMoodSeeds(options = {}) {
  const { search = searchTracks, searchArtist = searchArtistTopTracks, onProgress } = options;
  const callCounter = { calls: 0 };

  const resolved = getResolvedSeeds();
  const pendingAll = getPendingReviewItems();

  const moodKeys = Object.keys(MOOD_SEED_ENTRIES);
  let done = 0;

  for (const moodKey of moodKeys) {
    const entries = MOOD_SEED_ENTRIES[moodKey] || [];
    const { autoIds, pending } = await resolveEntries(moodKey, entries, search, callCounter);

    const wildcardIds = [];
    for (const artistName of ARTIST_WILDCARDS[moodKey] || []) {
      wildcardIds.push(...(await resolveArtistWildcard(artistName, searchArtist, callCounter)));
    }

    resolved[moodKey] = [...new Set([...(resolved[moodKey] || []), ...autoIds, ...wildcardIds])];

    // Replace this mood's pending items with the fresh pass's results
    // (stale items from an earlier run for the same mood shouldn't linger
    // alongside new ones).
    for (let i = pendingAll.length - 1; i >= 0; i--) {
      if (pendingAll[i].moodKey === moodKey) pendingAll.splice(i, 1);
    }
    pendingAll.push(...pending);

    done++;
    if (onProgress) onProgress(done, moodKeys.length);
  }

  saveResolvedSeeds(resolved);
  savePendingReviewItems(pendingAll);
  markResolvedOnce();

  return { resolved, pending: pendingAll, callsMade: callCounter.calls };
}

/** Accept a review item — adds the chosen track's id to its mood's resolved
 * seed list (deduped) and removes the item from the pending queue.
 * @param {string} itemId
 * @param {{id:string}|null} chosenTrack - the item's own `best`, or one of
 *   its `alternatives` if she picked a different one.
 * @returns {Array} the remaining pending queue
 */
export function acceptReviewItem(itemId, chosenTrack) {
  const pending = getPendingReviewItems();
  const item = pending.find((p) => p.id === itemId);
  if (!item) return pending;

  if (chosenTrack && chosenTrack.id) {
    const resolved = getResolvedSeeds();
    const list = resolved[item.moodKey] || [];
    if (!list.includes(chosenTrack.id)) list.push(chosenTrack.id);
    resolved[item.moodKey] = list;
    saveResolvedSeeds(resolved);
  }

  const remaining = pending.filter((p) => p.id !== itemId);
  savePendingReviewItems(remaining);
  return remaining;
}

/** Skip a review item — removes it from the pending queue, resolves
 * nothing (her call that this one isn't worth chasing further).
 * @param {string} itemId
 * @returns {Array} the remaining pending queue
 */
export function skipReviewItem(itemId) {
  const remaining = getPendingReviewItems().filter((p) => p.id !== itemId);
  savePendingReviewItems(remaining);
  return remaining;
}
