// Shotgun — the learning loop (v2 core)
//
// "Driving IS the rating" (per the brief): on every authed open, reconcile
// Spotify's recently-played list against what's expected of a full listen,
// derive a skip/win per track, and nudge taste scores from that — no manual
// rating UI anywhere.
//
// The scoring engine (deltas, clamps, soft-ban rule) is PORTED from her
// brother's DecklingAir (github.com/Py-xxx/DecklingAir, server/spotify.js —
// read directly for this session, see the constants below for exactly what
// was kept vs. adapted). Two deliberate adaptations, both because Shotgun
// has none of DecklingAir's tuning sliders and plays far less continuously:
//   1. DecklingAir derives its skip/win split from a "skip sensitivity"
//      slider (two thresholds, ~0.165/~0.475 at its default). Shotgun has no
//      such slider — this session's brief states a single ~60% cutline
//      instead, so SKIP_FRAC below collapses DecklingAir's dual strong/soft
//      zone into one line. WIN_FRAC (0.80) is ported exactly (its
//      FINISH_FRAC).
//   2. DecklingAir recovers a soft-banned artist/track ONLY via a later
//      engaged listen — fine for an app playing continuously all day, but
//      Shotgun only resurfaces something if it's picked for a FUTURE drive,
//      which a soft-banned item by definition won't be, so it could never
//      earn its way back. SOFT_BAN_EXPIRY_DAYS adds a time-based safety net
//      under the same score-based recovery (still primary) — 21 days
//      borrows DecklingAir's own REDISCOVER_MIN_AGE_MS constant, its
//      "haven't heard in a while" floor, for consistency with the reference.
//
// Pure logic (reconcileTimeline, classifyPlay, applyEvents, the ban
// predicates, shapePoolForDrive) has no network/storage access, so it's
// unit-tested directly in tests/learning.test.mjs. The async half
// (runReconcile, pullCloudTasteIntoLocal) does the actual I/O — same
// precedent as js/api.js's resolveCandidatePool: exercised live, not
// Node-unit-tested, since it touches window/localStorage/fetch at call time.

import * as api from './api.js';
import * as cloudSync from './cloud-sync.js';

// ---------------------------------------------------------------------------
// Ported constants
// ---------------------------------------------------------------------------

export const WIN_FRAC = 0.8; // ported exactly: DecklingAir's FINISH_FRAC
export const SKIP_FRAC = 0.6; // Megan's stated single cutline (adaptation #1 above)

export const ARTIST_SCORE_DELTA = 1; // ported: each engaged listen +1, each hard skip -1
export const ARTIST_SCORE_MIN = -8; // ported: DecklingAir's ARTIST_TASTE_MIN
export const ARTIST_SCORE_MAX = 8; // ported: DecklingAir's ARTIST_TASTE_MAX
export const ARTIST_AVOID_THRESHOLD = -3; // ported: DecklingAir's ARTIST_DISLIKE_SCORE

export const TRACK_SOFTBAN_COUNT = 2; // ported: DecklingAir's TRACK_SOFTBAN_COUNT
export const SOFT_BAN_EXPIRY_DAYS = 21; // adaptation #2 above

export const TOD_BUCKETS = ['morning', 'afternoon', 'evening'];

const FAMILIARITY_CAP_PLAYS = 5; // plays beyond this add no further familiarity boost
const FAMILIARITY_STEP = 0.3; // per reconciled win, up to the cap — matches flow-order.js's FAMILIARITY_BIAS scale

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function isFiniteNumber(v) {
  return typeof v === 'number' && !Number.isNaN(v) && Number.isFinite(v);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function clampArtistScore(v) {
  return clamp(v, ARTIST_SCORE_MIN, ARTIST_SCORE_MAX);
}

function addDaysIso(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

/** Local-time-of-day bucket for a Date. Boundaries: morning 05:00-11:59,
 * afternoon 12:00-16:59, evening everything else (17:00-04:59) — her schema
 * only names three buckets (no separate "night"), so late-night listening
 * folds into "evening" rather than adding a fourth. */
export function bucketForDate(date) {
  const h = date.getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  return 'evening';
}

// ---------------------------------------------------------------------------
// Play-fraction + classification (pure)
// ---------------------------------------------------------------------------

/** @param {number} gapMs - time from this play's start to the NEXT play's start
 *  @param {number|null|undefined} durationSeconds
 *  @returns {number|null} 0..1, or null when it can't be computed */
export function playedFraction(gapMs, durationSeconds) {
  if (!isFiniteNumber(durationSeconds) || durationSeconds <= 0) return null;
  if (!isFiniteNumber(gapMs) || gapMs < 0) return null;
  return Math.min(1, gapMs / (durationSeconds * 1000));
}

/** win (>= WIN_FRAC) / skip (< SKIP_FRAC) / neutral (between) / unknown (frac
 * couldn't be computed — no score change either way, same as DecklingAir's
 * "didn't fit the vibe" neutral zone). */
export function classifyPlay(frac) {
  if (frac == null) return 'unknown';
  if (frac >= WIN_FRAC) return 'win';
  if (frac < SKIP_FRAC) return 'skip';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Reconcile: recently-played timeline -> classified events (pure)
// ---------------------------------------------------------------------------

/**
 * @param {Array<{trackId:string, playedAt:string, track?:{id?:string,artist?:string,duration?:number}}>} items
 *   - as returned by api.getRecentlyPlayed(): NEWEST FIRST.
 * @param {{watermark?: string|null}} [options]
 * @returns {{events: Array<object>, newWatermark: string|null}}
 *
 * The most recent play (chronologically LAST) is never classified this
 * pass — there's no later timestamp yet to derive its play fraction from.
 * It stays unclassified (and the watermark doesn't advance past it) until a
 * future fetch shows something played after it. This is the deliberate
 * "last-item-no-next-timestamp" behaviour the brief calls out.
 */
export function reconcileTimeline(items, options = {}) {
  const { watermark = null } = options;
  const clean = (items || []).filter((it) => it && it.trackId && it.playedAt);

  // newest-first input -> chronological (oldest-first) for gap math
  const chrono = [...clean].sort((a, b) => new Date(a.playedAt) - new Date(b.playedAt));

  const sinceWatermark = watermark ? chrono.filter((it) => new Date(it.playedAt) > new Date(watermark)) : chrono;

  const events = [];
  let newWatermark = watermark;

  for (let i = 0; i < sinceWatermark.length - 1; i++) {
    const item = sinceWatermark[i];
    const next = sinceWatermark[i + 1];

    const durationSec = item.track && isFiniteNumber(item.track.duration) ? item.track.duration : null;
    const gapMs = new Date(next.playedAt) - new Date(item.playedAt);
    const frac = playedFraction(gapMs, durationSec);
    const outcome = classifyPlay(frac);

    events.push({
      trackId: item.trackId,
      artist: item.track ? item.track.artist : null,
      playedAt: item.playedAt,
      frac,
      outcome,
      bucket: bucketForDate(new Date(item.playedAt)),
      track: item.track || null,
    });

    newWatermark = item.playedAt;
  }

  return { events, newWatermark };
}

// ---------------------------------------------------------------------------
// Learning state — pure shape + pure mutators (applyEvents is the whole
// scoring engine, testable without any I/O)
// ---------------------------------------------------------------------------

export function emptyLearningState() {
  return { watermark: null, artists: {}, tracks: {}, playCounts: {}, todProfiles: {} };
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state || emptyLearningState()));
}

function bumpArtistScore(state, artist, delta) {
  if (!artist) return;
  const key = artist.toLowerCase();
  const cur = state.artists[key] || { score: 0, softBanUntil: null };
  const nextScore = clampArtistScore((cur.score || 0) + delta);
  const softBanUntil =
    nextScore <= ARTIST_AVOID_THRESHOLD
      ? addDaysIso(new Date(), SOFT_BAN_EXPIRY_DAYS) // (re)confirmed still avoided — refresh the expiry window
      : null; // recovered on score alone, no need to wait out a timer
  state.artists[key] = { score: nextScore, softBanUntil, updatedAt: new Date().toISOString() };
}

function bumpTrackDislike(state, trackId) {
  if (!trackId) return;
  const cur = state.tracks[trackId] || { skipCount: 0, softBanUntil: null };
  const nextCount = (cur.skipCount || 0) + 1;
  const softBanUntil = nextCount >= TRACK_SOFTBAN_COUNT ? addDaysIso(new Date(), SOFT_BAN_EXPIRY_DAYS) : cur.softBanUntil || null;
  state.tracks[trackId] = { skipCount: nextCount, softBanUntil, updatedAt: new Date().toISOString() };
}

function recoverTrackDislike(state, trackId) {
  if (!trackId || !state.tracks[trackId]) return;
  const cur = state.tracks[trackId];
  const nextCount = Math.max(0, (cur.skipCount || 0) - 1);
  if (nextCount <= 0) {
    delete state.tracks[trackId];
  } else {
    state.tracks[trackId] = {
      skipCount: nextCount,
      softBanUntil: nextCount >= TRACK_SOFTBAN_COUNT ? cur.softBanUntil : null,
      updatedAt: new Date().toISOString(),
    };
  }
}

/** Rolling (incremental) mean — a true running average, not a windowed one,
 * matching the brief's "rolling average" wording. Only ever fed WINS (a
 * skip is negative signal about that specific listen, not evidence about
 * what the bucket's sound should be — the same reasoning DecklingAir uses
 * for its own slot-bias learning). */
function rollTodVector(state, bucket, track) {
  if (!bucket || !track) return;
  const prof = state.todProfiles[bucket] || { target: {}, sampleCount: 0 };
  const n = prof.sampleCount || 0;
  const nextTarget = { ...prof.target };
  for (const key of ['energy', 'valence', 'tempo', 'danceability', 'acousticness']) {
    if (isFiniteNumber(track[key])) {
      const prevVal = isFiniteNumber(nextTarget[key]) ? nextTarget[key] : track[key];
      nextTarget[key] = prevVal + (track[key] - prevVal) / (n + 1);
    }
  }
  state.todProfiles[bucket] = { target: nextTarget, sampleCount: n + 1, updatedAt: new Date().toISOString() };
}

/**
 * The whole scoring engine over a batch of classified events — pure,
 * returns a NEW state (never mutates the input), so it's directly
 * unit-testable with hand-built events and asserted against for score
 * deltas/clamps/soft-ban set.
 * @param {object} state - emptyLearningState() shape
 * @param {Array<object>} events - reconcileTimeline()'s output (win events
 *   should already have their track's audio features merged in by the
 *   caller — see resolveWinTrackFeatures() below — so rollTodVector has
 *   something to average; recently-played's own track objects never carry
 *   audio features, only title/artist/duration).
 * @returns {object} the next state
 */
export function applyEvents(state, events) {
  const next = cloneState(state);
  for (const ev of events || []) {
    if (ev.outcome === 'win') {
      bumpArtistScore(next, ev.artist, ARTIST_SCORE_DELTA);
      recoverTrackDislike(next, ev.trackId);
      if (ev.trackId) next.playCounts[ev.trackId] = (next.playCounts[ev.trackId] || 0) + 1;
      if (ev.track) rollTodVector(next, ev.bucket, ev.track);
    } else if (ev.outcome === 'skip') {
      bumpArtistScore(next, ev.artist, -ARTIST_SCORE_DELTA);
      bumpTrackDislike(next, ev.trackId);
    }
    // neutral / unknown: no score change — ported "didn't fit the vibe, don't penalize" zone
  }
  return next;
}

// ---------------------------------------------------------------------------
// Ban predicates + pool shaping — the plug-in point for buildQueue, WITHOUT
// touching flow-order.js. Two mechanisms, both already-existing seams in
// flow-order.js's buildQueue:
//   - hard exclusion (avoided artists, soft-banned tracks) happens by
//     filtering the POOL array handed to buildQueue, before it's called —
//     buildQueue never sees an excluded track at all.
//   - familiarity (Feel Good Vibes only, per its familiarityWeighted flag)
//     happens by annotating surviving tracks with a `familiarity` field —
//     the exact field flow-order.js's effectiveDistance() already reads;
//     nothing new to add there.
// ---------------------------------------------------------------------------

/** @param {object} state @param {string} trackId @param {number} [now] */
export function isTrackBanned(state, trackId, now = Date.now()) {
  const t = state.tracks[trackId];
  if (!t) return false;
  if (t.softBanUntil && now >= new Date(t.softBanUntil).getTime()) return false; // expired — see module doc comment
  return (t.skipCount || 0) >= TRACK_SOFTBAN_COUNT;
}

/** @param {object} state @param {string} artist @param {number} [now] */
export function isArtistAvoided(state, artist, now = Date.now()) {
  if (!artist) return false;
  const a = state.artists[artist.toLowerCase()];
  if (!a) return false;
  if (a.softBanUntil && now >= new Date(a.softBanUntil).getTime()) return false; // expired
  return (a.score || 0) <= ARTIST_AVOID_THRESHOLD;
}

export function computeFamiliarity(state, trackId) {
  const plays = (state.playCounts && state.playCounts[trackId]) || 0;
  return 1 + Math.min(plays, FAMILIARITY_CAP_PLAYS) * FAMILIARITY_STEP;
}

/**
 * @param {Array<object>} pool - a drive's candidate pool (already
 *   feature-resolved by api.js's resolveCandidatePool).
 * @param {object} state - learning state (loadLocalTasteState()'s shape).
 * @param {{familiarityWeighted?:boolean, now?:number}} [options]
 * @returns {Array<object>} the pool with avoided-artist/soft-banned tracks
 *   removed, and (when familiarityWeighted) a `familiarity` field merged
 *   onto every surviving track.
 */
export function shapePoolForDrive(pool, state, options = {}) {
  const { familiarityWeighted = false, now = Date.now() } = options;
  return (pool || [])
    .filter((t) => t && !isTrackBanned(state, t.id, now) && !isArtistAvoided(state, t.artist, now))
    .map((t) => (familiarityWeighted ? { ...t, familiarity: computeFamiliarity(state, t.id) } : t));
}

// ---------------------------------------------------------------------------
// Local persistence (localStorage — same single-blob pattern as
// js/feature-cache.js)
// ---------------------------------------------------------------------------

const STATE_KEY = 'shotgun.learning.state.v1';

function loadLocalState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? { ...emptyLearningState(), ...JSON.parse(raw) } : emptyLearningState();
  } catch (err) {
    console.warn('Shotgun: learning state read failed, starting fresh this session', err);
    return emptyLearningState();
  }
}
function saveLocalState(state) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('Shotgun: learning state write failed (not persisted this run)', err);
  }
}

/** Read-only accessor for app.js — the pool-shaping + Just Play anchor need
 * the current state synchronously at drive-build time. */
export function loadLocalTasteState() {
  return loadLocalState();
}

// ---------------------------------------------------------------------------
// Async orchestration — the actual I/O. Live-verified, not Node-unit-tested
// (same precedent as js/api.js's resolveCandidatePool).
// ---------------------------------------------------------------------------

/** Recently-played's own track objects never carry audio features (see
 * js/backends/spotify-backend.js's normaliseTrack doc comment) — resolve
 * them for WIN events only, via the same cache -> backend -> ReccoBeats path
 * everything else uses, so rollTodVector has real energy/valence/tempo to
 * average. Skips don't need this (never rolled into a tod vector). */
async function resolveWinTrackFeatures(events) {
  const winIds = [...new Set(events.filter((e) => e.outcome === 'win' && e.trackId).map((e) => e.trackId))];
  if (!winIds.length) return events;

  let featuresById = {};
  try {
    featuresById = await api.getAudioFeatures(winIds);
  } catch (err) {
    console.warn('Shotgun: could not resolve audio features for reconciled wins (tod learning skipped for them this pass)', err);
    return events;
  }

  return events.map((ev) => {
    if (ev.outcome !== 'win' || !featuresById[ev.trackId]) return ev;
    return { ...ev, track: { ...(ev.track || {}), ...featuresById[ev.trackId] } };
  });
}

/**
 * The whole reconcile pass: fetch recently-played, classify what's new since
 * the watermark, score it, persist locally, push to the cloud
 * (fire-and-forget — a push failure never blocks or rolls back the local
 * save, since local-first is the hard rule this session).
 *
 * Deliberately reconciles from ALL of recently-played, not filtered to
 * tracks that came from a Shotgun-stocked drive_history row — a skip or a
 * full listen is real taste signal regardless of whether Spotify's own
 * autoplay picked the track after a stocked queue ran out, exactly the kind
 * of listening DecklingAir also learns from. drive_history stays a useful
 * log (per-drive stats) but isn't a filter gate on scoring.
 */
export async function runReconcile() {
  if (!api.hasSpotifyAuth()) return { ran: false, reason: 'not-authed' };

  let recent;
  try {
    recent = await api.getRecentlyPlayed(50);
  } catch (err) {
    console.warn('Shotgun: recently-played fetch failed, skipping this reconcile pass', err);
    return { ran: false, reason: 'fetch-failed' };
  }

  const state = loadLocalState();
  const { events, newWatermark } = reconcileTimeline(recent, { watermark: state.watermark });
  if (!events.length) return { ran: true, events: [] };

  const enrichedEvents = await resolveWinTrackFeatures(events);
  const nextState = applyEvents(state, enrichedEvents);
  nextState.watermark = newWatermark;
  saveLocalState(nextState);

  cloudSync
    .pushTasteState(nextState)
    .catch((err) => console.warn('Shotgun: cloud taste push failed — local learning is still saved', err));

  return { ran: true, events: enrichedEvents, state: nextState };
}

/** Fill-gaps merge of cloud taste data into local state — restores learning
 * after a reinstall/new phone. One-directional on purpose (cloud fills in
 * whatever local is MISSING, never overwrites an entry local already has):
 * a full bidirectional last-write-wins merge would need per-field
 * versioning, which is out of scope for this build; local always wins for
 * anything it already knows, so a returning device's freshest edits are
 * never clobbered by a possibly-stale cloud snapshot. */
export async function pullCloudTasteIntoLocal() {
  const cloud = await cloudSync.loadTasteState();
  if (!cloud) return { pulled: false };

  const state = loadLocalState();
  let changed = false;
  for (const [key, val] of Object.entries(cloud.artists || {})) {
    if (!state.artists[key]) {
      state.artists[key] = val;
      changed = true;
    }
  }
  for (const [id, val] of Object.entries(cloud.tracks || {})) {
    if (!state.tracks[id]) {
      state.tracks[id] = val;
      changed = true;
    }
  }
  for (const [bucket, val] of Object.entries(cloud.todProfiles || {})) {
    if (!state.todProfiles[bucket]) {
      state.todProfiles[bucket] = val;
      changed = true;
    }
  }

  if (changed) saveLocalState(state);
  return { pulled: true, changed };
}
