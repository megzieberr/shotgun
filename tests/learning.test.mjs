// Shotgun — learning-loop tests (session 4b)
//
// Covers the pure half of js/learning.js: reconcile classification (win/
// skip/neutral, the last-item-no-next-timestamp deferral, watermark
// advance), the scoring engine (artist score deltas + clamps, track
// soft-ban set), the time-based soft-ban expiry, and score-weighted pool
// shaping (an avoided artist / a soft-banned track never survive into a
// built queue). No network, no localStorage, no `window` — same precedent
// as tests/stocking-filter.test.mjs and tests/seed-resolver.test.mjs: the
// async orchestration (runReconcile, pullCloudTasteIntoLocal) touches
// fetch/localStorage at call time and is live-verified instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WIN_FRAC,
  SKIP_FRAC,
  ARTIST_SCORE_MIN,
  ARTIST_SCORE_MAX,
  ARTIST_AVOID_THRESHOLD,
  TRACK_SOFTBAN_COUNT,
  playedFraction,
  classifyPlay,
  reconcileTimeline,
  bucketForDate,
  emptyLearningState,
  applyEvents,
  isTrackBanned,
  isArtistAvoided,
  shapePoolForDrive,
  computeFamiliarity,
} from '../js/learning.js';
import { buildQueue } from '../js/flow-order.js';

// ---------------------------------------------------------------------------
// playedFraction / classifyPlay
// ---------------------------------------------------------------------------

test('playedFraction: a full-length gap yields ~1.0', () => {
  const frac = playedFraction(200_000, 200); // 200s duration, 200s gap to the next play
  assert.equal(frac, 1);
});

test('playedFraction: a gap longer than the track duration is capped at 1', () => {
  const frac = playedFraction(500_000, 200);
  assert.equal(frac, 1);
});

test('playedFraction: missing duration or a negative gap returns null (unknown)', () => {
  assert.equal(playedFraction(100_000, null), null);
  assert.equal(playedFraction(100_000, 0), null);
  assert.equal(playedFraction(-1, 200), null);
});

test('classifyPlay: boundaries match the ported/adapted thresholds', () => {
  assert.equal(classifyPlay(null), 'unknown');
  assert.equal(classifyPlay(WIN_FRAC), 'win'); // >= WIN_FRAC (ported FINISH_FRAC = 0.80)
  assert.equal(classifyPlay(0.99), 'win');
  assert.equal(classifyPlay(SKIP_FRAC - 0.01), 'skip'); // < SKIP_FRAC (her stated ~60% cutline)
  assert.equal(classifyPlay(0), 'skip');
  assert.equal(classifyPlay(SKIP_FRAC), 'neutral'); // exactly at the skip line = not a skip
  assert.equal(classifyPlay((SKIP_FRAC + WIN_FRAC) / 2), 'neutral');
});

// ---------------------------------------------------------------------------
// reconcileTimeline
// ---------------------------------------------------------------------------

function mockTrack(overrides = {}) {
  return { id: 't1', artist: 'Artist One', duration: 200, ...overrides };
}

test('reconcileTimeline: a track played through to the next track is a win', () => {
  const items = [
    // newest-first input, as api.getRecentlyPlayed returns
    { trackId: 't2', playedAt: '2026-08-17T07:03:20.000Z', track: mockTrack({ id: 't2' }) },
    { trackId: 't1', playedAt: '2026-08-17T07:00:00.000Z', track: mockTrack({ id: 't1', duration: 200 }) },
  ];
  const { events } = reconcileTimeline(items);
  assert.equal(events.length, 1);
  assert.equal(events[0].trackId, 't1');
  assert.equal(events[0].outcome, 'win');
});

test('reconcileTimeline: a track cut well short (< 60%) of its duration is a skip', () => {
  const items = [
    { trackId: 't2', playedAt: '2026-08-17T07:01:30.000Z', track: mockTrack({ id: 't2' }) }, // 90s gap
    { trackId: 't1', playedAt: '2026-08-17T07:00:00.000Z', track: mockTrack({ id: 't1', duration: 200 }) }, // 90/200 = 0.45
  ];
  const { events } = reconcileTimeline(items);
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, 'skip');
});

test('reconcileTimeline: a gap in the neutral zone (60-80%) scores neither win nor skip', () => {
  const items = [
    { trackId: 't2', playedAt: '2026-08-17T07:02:20.000Z', track: mockTrack({ id: 't2' }) }, // 140s gap
    { trackId: 't1', playedAt: '2026-08-17T07:00:00.000Z', track: mockTrack({ id: 't1', duration: 200 }) }, // 140/200 = 0.70
  ];
  const { events } = reconcileTimeline(items);
  assert.equal(events[0].outcome, 'neutral');
});

test('reconcileTimeline: the most recent play (no next timestamp yet) is never classified this pass', () => {
  const items = [
    { trackId: 't1', playedAt: '2026-08-17T07:00:00.000Z', track: mockTrack({ id: 't1' }) },
  ];
  const { events, newWatermark } = reconcileTimeline(items);
  assert.equal(events.length, 0, 'a single item with no later timestamp must stay unclassified');
  assert.equal(newWatermark, null, 'watermark must not advance past an unclassified item');
});

test('reconcileTimeline: watermark advances only up to the second-to-last item, and a later pass classifies the deferred one', () => {
  const firstPass = [
    { trackId: 't1', playedAt: '2026-08-17T07:00:00.000Z', track: mockTrack({ id: 't1', duration: 200 }) },
  ];
  const pass1 = reconcileTimeline(firstPass, { watermark: null });
  assert.equal(pass1.events.length, 0);
  assert.equal(pass1.newWatermark, null);

  // Next open: t1 now has a track played after it, so THIS pass can finally
  // classify it — and t2 becomes the new deferred item.
  const secondPass = [
    { trackId: 't2', playedAt: '2026-08-17T07:03:20.000Z', track: mockTrack({ id: 't2', duration: 200 }) },
    { trackId: 't1', playedAt: '2026-08-17T07:00:00.000Z', track: mockTrack({ id: 't1', duration: 200 }) },
  ];
  const pass2 = reconcileTimeline(secondPass, { watermark: pass1.newWatermark });
  assert.equal(pass2.events.length, 1);
  assert.equal(pass2.events[0].trackId, 't1');
  assert.equal(pass2.newWatermark, '2026-08-17T07:00:00.000Z');

  // A third pass with the SAME data must not re-process t1 (already past watermark).
  const pass3 = reconcileTimeline(secondPass, { watermark: pass2.newWatermark });
  assert.equal(pass3.events.length, 0);
});

test('reconcileTimeline: a track with no known duration is classified "unknown" (no score change) but still advances the watermark', () => {
  const items = [
    { trackId: 't2', playedAt: '2026-08-17T07:03:20.000Z', track: mockTrack({ id: 't2' }) },
    { trackId: 't1', playedAt: '2026-08-17T07:00:00.000Z', track: { id: 't1', artist: 'Artist One' } }, // no duration
  ];
  const { events, newWatermark } = reconcileTimeline(items);
  assert.equal(events[0].outcome, 'unknown');
  assert.equal(newWatermark, '2026-08-17T07:00:00.000Z', 'still visited/classified — no point re-checking a track that will never have a duration');
});

// ---------------------------------------------------------------------------
// applyEvents — the scoring engine (deltas, clamps, soft-ban set)
// ---------------------------------------------------------------------------

test('applyEvents: a win nudges the artist score up by exactly ARTIST_SCORE_DELTA (+1)', () => {
  const state = emptyLearningState();
  const next = applyEvents(state, [{ outcome: 'win', trackId: 't1', artist: 'Nora Vale', bucket: 'morning', track: null }]);
  assert.equal(next.artists['nora vale'].score, 1);
});

test('applyEvents: a skip nudges the artist score down by exactly ARTIST_SCORE_DELTA (-1)', () => {
  const state = emptyLearningState();
  const next = applyEvents(state, [{ outcome: 'skip', trackId: 't1', artist: 'Nora Vale' }]);
  assert.equal(next.artists['nora vale'].score, -1);
});

test('applyEvents: neutral/unknown outcomes never touch the score', () => {
  const state = emptyLearningState();
  const next = applyEvents(state, [
    { outcome: 'neutral', trackId: 't1', artist: 'Nora Vale' },
    { outcome: 'unknown', trackId: 't2', artist: 'Nora Vale' },
  ]);
  assert.equal(Object.keys(next.artists).length, 0);
});

test('applyEvents: artist score clamps at ARTIST_SCORE_MIN/MAX and never goes further', () => {
  let state = emptyLearningState();
  for (let i = 0; i < 20; i++) {
    state = applyEvents(state, [{ outcome: 'win', trackId: `t${i}`, artist: 'Loved Artist' }]);
  }
  assert.equal(state.artists['loved artist'].score, ARTIST_SCORE_MAX);

  for (let i = 0; i < 20; i++) {
    state = applyEvents(state, [{ outcome: 'skip', trackId: `t${i}`, artist: 'Loved Artist' }]);
  }
  assert.equal(state.artists['loved artist'].score, ARTIST_SCORE_MIN);
});

test('applyEvents: an artist crossing ARTIST_AVOID_THRESHOLD becomes avoided AND gets a future soft_ban_until', () => {
  let state = emptyLearningState();
  for (let i = 0; i < Math.abs(ARTIST_AVOID_THRESHOLD); i++) {
    state = applyEvents(state, [{ outcome: 'skip', trackId: `t${i}`, artist: 'Rough Patch' }]);
  }
  assert.ok(state.artists['rough patch'].score <= ARTIST_AVOID_THRESHOLD);
  assert.ok(isArtistAvoided(state, 'Rough Patch'));
  assert.ok(new Date(state.artists['rough patch'].softBanUntil).getTime() > Date.now());
});

test('applyEvents: TRACK_SOFTBAN_COUNT hard skips soft-bans a track with a future expiry', () => {
  let state = emptyLearningState();
  for (let i = 0; i < TRACK_SOFTBAN_COUNT; i++) {
    state = applyEvents(state, [{ outcome: 'skip', trackId: 'ghost-track', artist: 'Someone' }]);
  }
  assert.ok(isTrackBanned(state, 'ghost-track'));
  assert.ok(new Date(state.tracks['ghost-track'].softBanUntil).getTime() > Date.now());
});

test('applyEvents: a win after skips recovers (decrements) a track dislike, and clears it entirely once it hits zero', () => {
  let state = emptyLearningState();
  state = applyEvents(state, [{ outcome: 'skip', trackId: 't1', artist: 'A' }]);
  assert.equal(state.tracks['t1'].skipCount, 1);
  state = applyEvents(state, [{ outcome: 'win', trackId: 't1', artist: 'A', bucket: 'morning', track: null }]);
  assert.equal(state.tracks['t1'], undefined, 'skipCount hit 0 -> the entry is cleared entirely');
});

test('applyEvents: wins roll a rolling-average time-of-day vector for their bucket', () => {
  let state = emptyLearningState();
  state = applyEvents(state, [
    { outcome: 'win', trackId: 't1', artist: 'A', bucket: 'morning', track: { energy: 0.2, valence: 0.5, tempo: 80 } },
  ]);
  assert.equal(state.todProfiles.morning.sampleCount, 1);
  assert.equal(state.todProfiles.morning.target.energy, 0.2);

  state = applyEvents(state, [
    { outcome: 'win', trackId: 't2', artist: 'A', bucket: 'morning', track: { energy: 0.4, valence: 0.5, tempo: 80 } },
  ]);
  assert.equal(state.todProfiles.morning.sampleCount, 2);
  assert.ok(
    Math.abs(state.todProfiles.morning.target.energy - 0.3) < 1e-9,
    'rolling mean of 0.2 and 0.4'
  );
});

// ---------------------------------------------------------------------------
// Soft-ban expiry (time-based safety net, Shotgun's own addition)
// ---------------------------------------------------------------------------

test('isTrackBanned: an expired soft_ban_until lifts the ban even though skipCount is still >= TRACK_SOFTBAN_COUNT', () => {
  const state = emptyLearningState();
  state.tracks['old-ban'] = { skipCount: TRACK_SOFTBAN_COUNT, softBanUntil: '2020-01-01T00:00:00.000Z' };
  assert.equal(isTrackBanned(state, 'old-ban'), false);
});

test('isTrackBanned: a soft_ban_until still in the future keeps the ban active', () => {
  const state = emptyLearningState();
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  state.tracks['fresh-ban'] = { skipCount: TRACK_SOFTBAN_COUNT, softBanUntil: future };
  assert.equal(isTrackBanned(state, 'fresh-ban'), true);
});

test('isArtistAvoided: same expiry behaviour as tracks', () => {
  const state = emptyLearningState();
  state.artists['stale grudge'] = { score: ARTIST_AVOID_THRESHOLD, softBanUntil: '2020-01-01T00:00:00.000Z' };
  assert.equal(isArtistAvoided(state, 'Stale Grudge'), false);

  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  state.artists['current grudge'] = { score: ARTIST_AVOID_THRESHOLD, softBanUntil: future };
  assert.equal(isArtistAvoided(state, 'Current Grudge'), true);
});

// ---------------------------------------------------------------------------
// shapePoolForDrive — score-weighted selection plugging into buildQueue
// ---------------------------------------------------------------------------

function samplePool() {
  return [
    { id: 'keep-1', artist: 'Keeper', title: 'A', energy: 0.5, valence: 0.5, tempo: 100 },
    { id: 'banned-track', artist: 'Someone Else', title: 'B', energy: 0.5, valence: 0.5, tempo: 100 },
    { id: 'avoided-1', artist: 'Avoided Artist', title: 'C', energy: 0.5, valence: 0.5, tempo: 100 },
    { id: 'avoided-2', artist: 'Avoided Artist', title: 'D', energy: 0.5, valence: 0.5, tempo: 100 },
    { id: 'keep-2', artist: 'Keeper', title: 'E', energy: 0.5, valence: 0.5, tempo: 100 },
  ];
}

function stateWithBans() {
  const state = emptyLearningState();
  state.tracks['banned-track'] = { skipCount: TRACK_SOFTBAN_COUNT, softBanUntil: new Date(Date.now() + 999999).toISOString() };
  state.artists['avoided artist'] = { score: ARTIST_AVOID_THRESHOLD - 1, softBanUntil: new Date(Date.now() + 999999).toISOString() };
  return state;
}

test('shapePoolForDrive: drops the soft-banned track and every track by the avoided artist', () => {
  const shaped = shapePoolForDrive(samplePool(), stateWithBans());
  const ids = shaped.map((t) => t.id);
  assert.ok(!ids.includes('banned-track'));
  assert.ok(!ids.includes('avoided-1'));
  assert.ok(!ids.includes('avoided-2'));
  assert.deepEqual(ids.sort(), ['keep-1', 'keep-2']);
});

test('shapePoolForDrive: a heavily-down-scored artist never appears in an actual built queue', () => {
  const shaped = shapePoolForDrive(samplePool(), stateWithBans());
  const queue = buildQueue(shaped, { n: 10, varietySeed: 'test-seed' });
  assert.ok(!queue.some((t) => t.artist === 'Avoided Artist'));
  assert.ok(!queue.some((t) => t.id === 'banned-track'));
  assert.equal(queue.length, 2, 'only the two un-excluded tracks were ever eligible');
});

test('shapePoolForDrive: familiarityWeighted merges a familiarity field from reconciled play counts', () => {
  const state = emptyLearningState();
  state.playCounts['keep-1'] = 3;
  const shaped = shapePoolForDrive(samplePool(), state, { familiarityWeighted: true });
  const t = shaped.find((x) => x.id === 'keep-1');
  assert.equal(t.familiarity, computeFamiliarity(state, 'keep-1'));
  assert.ok(t.familiarity > 1, 'a played track should read as more familiar than an unplayed one (1)');

  const unplayed = shaped.find((x) => x.id === 'keep-2');
  assert.equal(unplayed.familiarity, 1);
});

test('shapePoolForDrive: familiarity is NOT added when familiarityWeighted is false (default)', () => {
  const shaped = shapePoolForDrive(samplePool(), emptyLearningState());
  assert.ok(shaped.every((t) => !('familiarity' in t)));
});

// ---------------------------------------------------------------------------
// bucketForDate
// ---------------------------------------------------------------------------

test('bucketForDate: morning/afternoon/evening boundaries', () => {
  assert.equal(bucketForDate(new Date('2026-08-17T05:00:00')), 'morning');
  assert.equal(bucketForDate(new Date('2026-08-17T11:59:00')), 'morning');
  assert.equal(bucketForDate(new Date('2026-08-17T12:00:00')), 'afternoon');
  assert.equal(bucketForDate(new Date('2026-08-17T16:59:00')), 'afternoon');
  assert.equal(bucketForDate(new Date('2026-08-17T17:00:00')), 'evening');
  assert.equal(bucketForDate(new Date('2026-08-17T02:00:00')), 'evening');
});
