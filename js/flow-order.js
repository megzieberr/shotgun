// Shotgun — flow ordering
//
// This is the whole point of the app: given a pool of candidate tracks (each
// with energy/valence/tempo and, where available, danceability/acousticness),
// an anchor (a mood's target vector, or a seed track's own features), and a
// queue size N, pick and arrange N tracks so consecutive songs never jump —
// energy, mood (valence) and tempo all ease gradually.
//
// Two exports:
//   - orderForFlow(tracks, anchor, options)  — pure ordering: arrange an
//     ALREADY-selected list of tracks for smooth adjacent-step flow. This is
//     the seam the scaffold session's placeholder established; app.js can
//     still call it directly with an already-chosen track list.
//   - buildQueue(pool, options)              — the real end-to-end call:
//     filters the pool by mood rules, scores candidates against the anchor
//     (with optional familiarity weighting), injects seeded variety so two
//     drives with the same anchor differ, then hands the result to
//     orderForFlow. This is what app.js uses for every drive kind.

// ---------------------------------------------------------------------------
// Weighted distance
// ---------------------------------------------------------------------------
// Energy and valence are already 0-1, directly comparable. Tempo isn't: a
// raw bpm difference means less at high tempo than low (a 20bpm gap is huge
// going 70->90 but barely noticeable 140->160), so tempo uses a RELATIVE gap
// (difference over the pair's average) rather than a raw one. Danceability
// contributes a smaller weight when both tracks have it; any dimension
// missing on either side is skipped rather than penalised, so mock data and
// partial ReccoBeats results degrade gracefully instead of breaking scoring.

const WEIGHTS = { energy: 1.0, valence: 0.85, tempo: 0.9, danceability: 0.35 };

function tempoGap(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || a <= 0 || b <= 0) return 0;
  return Math.abs(a - b) / ((a + b) / 2);
}

/**
 * Weighted distance between two feature vectors. Order-independent, ignores
 * any dimension not present as a finite number on BOTH sides.
 * @param {{energy?:number, valence?:number, tempo?:number, danceability?:number}} a
 * @param {{energy?:number, valence?:number, tempo?:number, danceability?:number}} b
 */
export function weightedDistance(a, b, weights = WEIGHTS) {
  if (!a || !b) return Infinity;
  let sumSq = 0;
  let sumW = 0;

  if (isNum(a.energy) && isNum(b.energy)) {
    sumSq += weights.energy * (a.energy - b.energy) ** 2;
    sumW += weights.energy;
  }
  if (isNum(a.valence) && isNum(b.valence)) {
    sumSq += weights.valence * (a.valence - b.valence) ** 2;
    sumW += weights.valence;
  }
  if (isNum(a.tempo) && isNum(b.tempo)) {
    const g = tempoGap(a.tempo, b.tempo);
    sumSq += weights.tempo * g * g;
    sumW += weights.tempo;
  }
  if (isNum(a.danceability) && isNum(b.danceability)) {
    sumSq += weights.danceability * (a.danceability - b.danceability) ** 2;
    sumW += weights.danceability;
  }

  if (!sumW) return 0; // nothing comparable — treat as equidistant, not infinitely far
  return Math.sqrt(sumSq / sumW);
}

function isNum(v) {
  return typeof v === 'number' && !Number.isNaN(v);
}

function hasFeatures(v) {
  return !!v && (isNum(v.energy) || isNum(v.valence) || isNum(v.tempo));
}

/** Average feature vector across a list of tracks — used as a fallback anchor
 * and to turn a set of mood-seed tracks into an override target vector. */
export function averageFeatures(tracks) {
  const list = (tracks || []).filter(hasFeatures);
  if (!list.length) return { energy: 0.5, valence: 0.5, tempo: 110 };
  const out = {};
  for (const key of ['energy', 'valence', 'tempo', 'danceability', 'acousticness']) {
    const vals = list.map((t) => t[key]).filter(isNum);
    if (vals.length) out[key] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mood filters
// ---------------------------------------------------------------------------

/**
 * @param {object} track
 * @param {Object<string,[number,number]>|null} filters - e.g. { valence: [0,0.32] }
 * @returns {boolean} false if the track fails ANY range whose field it HAS.
 *   A field the track lacks never fails the filter (graceful degradation).
 */
export function passesMoodFilters(track, filters) {
  if (!filters || !track) return true;
  for (const [key, range] of Object.entries(filters)) {
    const value = track[key];
    if (!isNum(value)) continue; // don't know — don't exclude on it
    const [min, max] = range;
    if (value < min || value > max) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Seeded randomness (mulberry32) — deterministic given a seed, so tests can
// pin a run, while production passes a fresh seed (e.g. Date.now()) per drive
// so two drives with the same anchor don't play out identically.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromInput(seed) {
  if (typeof seed === 'number' && !Number.isNaN(seed)) return seed >>> 0;
  if (typeof seed === 'string' && seed.length) {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}

// ---------------------------------------------------------------------------
// Selection (buildQueue's first phase): pick N tracks from a filtered pool,
// biased toward the anchor but with seeded variety among near-equal options.
// ---------------------------------------------------------------------------

const FAMILIARITY_BIAS = 0.15; // how much a familiarity>1 track's effective distance shrinks

function effectiveDistance(track, target, familiarityWeighted) {
  let d = weightedDistance(track, target);
  if (familiarityWeighted) {
    // With mock/early data every track defaults to familiarity 1 ("treat all
    // as familiar" per the brief) — this multiplier is then exactly 1, a
    // documented no-op until real most-played/most-finished data exists.
    const fam = isNum(track.familiarity) ? track.familiarity : 1;
    d *= 1 - FAMILIARITY_BIAS * (fam - 1);
  }
  return Math.max(0, d);
}

// ---------------------------------------------------------------------------
// The walk: ONE greedy nearest-neighbour pass does both selection AND
// ordering. At every step, the next track is the nearest (with seeded
// near-tie variety) UNPICKED candidate to the current cursor, out of the
// WHOLE remaining pool — never a pre-narrowed shortlist. This is what
// actually guarantees the hard smoothness requirement for buildQueue's
// selection, not just for reordering an already-chosen set: a far-off
// cluster is only ever reached once everything closer has been used up, so
// a short queue drawn from a large pool never has to make a jarring jump to
// reach its Nth track — it simply never wanders that far in the first place.
//
// orderForFlow (pure reordering of an already-chosen list) and buildQueue's
// selection are both this same walk; orderForFlow just runs it to
// completion (limit = the whole list) instead of stopping at N.
// ---------------------------------------------------------------------------

const VARIETY_EPSILON = 0.05; // near-ties within this much of the best distance are all fair game

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function applyArc(target, arc, posFrac) {
  if (!arc) return target;
  const shifted = { ...target };
  for (const key of ['energy', 'valence']) {
    if (isNum(arc[key]) && isNum(target[key])) {
      shifted[key] = clamp01(target[key] + arc[key] * posFrac);
    }
  }
  return shifted;
}

/**
 * @param {Array<object>} pool - candidates to walk through (consumed, not mutated).
 * @param {object} anchor - real feature vector to start the walk from (always
 *   resolved to a concrete vector by the caller — never null here).
 * @param {object} [options]
 * @param {number} [options.limit=Infinity] - stop after this many picks.
 * @param {string|number} [options.varietySeed]
 * @param {{energy?:number, valence?:number}} [options.arc]
 * @param {(a:object,b:object)=>number} [options.distanceFn=weightedDistance]
 */
function walk(pool, anchor, options = {}) {
  const { limit = Infinity, varietySeed = null, arc = null, distanceFn = weightedDistance } = options;
  if (!Array.isArray(pool) || !pool.length) return [];

  const rng = mulberry32(seedFromInput(varietySeed));
  const remaining = [...pool];
  const total = Math.min(limit, remaining.length);

  const ordered = [];
  let cursor = anchor;

  while (ordered.length < total && remaining.length) {
    const posFrac = total > 1 ? ordered.length / (total - 1) : 0;
    const target = applyArc(cursor, arc, posFrac);

    const scored = remaining.map((t, i) => ({ i, t, d: distanceFn(t, target) }));
    scored.sort((a, b) => a.d - b.d);

    const best = scored[0].d;
    const nearTies = scored.filter((s) => s.d <= best + VARIETY_EPSILON);
    const pick = nearTies[Math.floor(rng() * nearTies.length)];

    remaining.splice(pick.i, 1);
    ordered.push(pick.t);
    cursor = pick.t;
  }

  return ordered;
}

/**
 * Arrange an already-chosen set of tracks for smooth adjacent-step flow.
 * @param {Array<object>} tracks
 * @param {{energy?:number, valence?:number, tempo?:number}|null} [anchor] -
 *   starting neighbourhood; defaults to the tracks' own centroid.
 * @param {{varietySeed?:string|number, arc?:{energy?:number, valence?:number}}} [options]
 * @returns {Array} the same track objects, reordered
 */
export function orderForFlow(tracks, anchor = null, options = {}) {
  if (!Array.isArray(tracks) || tracks.length <= 1) return [...tracks];
  const start = hasFeatures(anchor) ? anchor : averageFeatures(tracks);
  return walk(tracks, start, { ...options, limit: Infinity });
}

// ---------------------------------------------------------------------------
// buildQueue — selection + ordering, the function app.js actually calls for
// every drive kind (mood, seed, and the Just Play stub).
// ---------------------------------------------------------------------------

/**
 * @param {Array<object>} pool - candidate tracks, each with at least
 *   energy/valence/tempo (danceability/acousticness optional).
 * @param {object} [options]
 * @param {object|null} [options.anchor] - target feature vector (a mood's
 *   `target`, or a seed track's own features). Defaults to the filtered
 *   pool's centroid when omitted (a "balanced mix" anchor).
 * @param {number} [options.n=10] - desired queue length.
 * @param {Object<string,[number,number]>|null} [options.filters] - mood
 *   selection filters (see passesMoodFilters). If filtering leaves nothing,
 *   selection falls back to the whole pool rather than returning empty —
 *   a small library should never produce a blank drive.
 * @param {boolean} [options.familiarityWeighted=false] - prefer higher
 *   track.familiarity (default 1 = "treat as familiar") when true.
 * @param {string[]} [options.mustInclude] - track ids guaranteed a slot
 *   (e.g. the seed song itself), even if filters would otherwise exclude it.
 * @param {string|number} [options.varietySeed] - deterministic seed for the
 *   variety RNG; two different seeds with the same anchor should differ.
 * @param {{energy?:number, valence?:number}} [options.arc] - optional gentle
 *   within-drive drift, passed through to orderForFlow.
 * @returns {Array} ordered array of up to `n` tracks
 */
export function buildQueue(pool, options = {}) {
  const {
    anchor = null,
    n = 10,
    filters = null,
    familiarityWeighted = false,
    mustInclude = [],
    varietySeed = null,
    arc = null,
  } = options;

  if (!Array.isArray(pool) || !pool.length || n <= 0) return [];

  let candidates = filters ? pool.filter((t) => passesMoodFilters(t, filters)) : [...pool];
  if (!candidates.length) candidates = [...pool]; // never produce a blank drive over an empty band

  const mustIds = new Set(mustInclude);
  const forced = pool.filter((t) => mustIds.has(t.id));
  const rest = candidates.filter((t) => !mustIds.has(t.id));

  const target = hasFeatures(anchor) ? anchor : averageFeatures(candidates);
  const distanceFn = familiarityWeighted
    ? (track, tgt) => effectiveDistance(track, tgt, true)
    : weightedDistance;

  // `forced` (mustInclude, e.g. a picked seed song) must LEAD the drive, not
  // just be present somewhere in it — order the forced tracks among
  // themselves first (rare to have more than one), then walk the rest
  // starting from wherever the forced lead-in ends.
  if (forced.length) {
    const orderedForced = forced.length > 1 ? orderForFlow(forced, target, { varietySeed }) : forced;
    const leadOutAnchor = orderedForced[orderedForced.length - 1];
    const remainingSlots = Math.max(0, Math.min(n, pool.length) - orderedForced.length);
    const orderedRest = walk(rest, leadOutAnchor, { limit: remainingSlots, varietySeed, arc, distanceFn });
    return [...orderedForced, ...orderedRest].slice(0, n);
  }

  return walk(rest, target, { limit: Math.min(n, rest.length), varietySeed, arc, distanceFn });
}
