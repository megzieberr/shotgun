// Shotgun — stocking-pipeline feature gate tests
//
// Foreman review rule: before ANY candidate pool reaches flow-order.js's
// buildQueue, a track with no resolved audio features must be dropped —
// weightedDistance() treats a fully-featureless track as distance 0 from
// every anchor (see flow-order.js's own doc comment), which would jump it
// to the front of every queue. api.js's keepTracksWithFeatures() is the
// gate that enforces this at the stocking-pipeline level, not inside
// flow-order.js (which a later session owns and this session was told not
// to touch).
//
// Pure-function test — no network, no localStorage, no `window` — so it
// runs the same as tests/flow-order.test.mjs: `node --test tests/`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { keepTracksWithFeatures } from '../js/api.js';
import { weightedDistance } from '../js/flow-order.js';

test('a track with no resolved features is dropped, not merged in as distance-0', () => {
  const tracks = [
    { id: 'known-1', title: 'Known One' },
    { id: 'unknown-1', title: 'Never Looked Up' },
    { id: 'known-2', title: 'Known Two' },
  ];
  const featuresById = {
    'known-1': { energy: 0.5, valence: 0.5, tempo: 100 },
    // unknown-1 intentionally absent — simulates "ReccoBeats returned null
    // / not yet fetched" per the review comment.
    'known-2': { energy: 0.6, valence: 0.4, tempo: 110 },
  };

  const kept = keepTracksWithFeatures(tracks, featuresById);

  assert.equal(kept.length, 2);
  assert.ok(!kept.some((t) => t.id === 'unknown-1'), 'the unresolved track slipped through');
  assert.deepEqual(
    kept.map((t) => t.id).sort(),
    ['known-1', 'known-2']
  );
});

test('a confirmed-unknown (cached null) result is also dropped', () => {
  const tracks = [{ id: 't1' }];
  const featuresById = { t1: null }; // getAudioFeatures' shape for "ReccoBeats confirmed it doesn't know this track"
  const kept = keepTracksWithFeatures(tracks, featuresById);
  assert.equal(kept.length, 0);
});

test('a track missing the featuresById map entirely is dropped, not treated as a pass', () => {
  const tracks = [{ id: 't1' }, { id: 't2' }];
  const kept = keepTracksWithFeatures(tracks, {});
  assert.equal(kept.length, 0);
});

test('a track with SOME but not enough dimensions to compare (missing tempo) is dropped', () => {
  // Distinct from flow-order.js's own per-dimension graceful-degradation
  // rule (a track missing e.g. danceability is fine) — this is the
  // minimum triad buildQueue's distance function needs to mean anything
  // at all.
  const tracks = [{ id: 't1' }];
  const featuresById = { t1: { energy: 0.5, valence: 0.5 } }; // no tempo
  const kept = keepTracksWithFeatures(tracks, featuresById);
  assert.equal(kept.length, 0);
});

test('a track with a partial-but-sufficient feature set (missing only danceability) is kept and merged', () => {
  const tracks = [{ id: 't1', title: 'Partial Data' }];
  const featuresById = { t1: { energy: 0.5, valence: 0.5, tempo: 100 } };
  const kept = keepTracksWithFeatures(tracks, featuresById);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].title, 'Partial Data'); // original fields preserved
  assert.equal(kept[0].energy, 0.5); // features merged in
});

test('regression: without the gate, a featureless track WOULD score as distance 0 (the bug this exists to prevent)', () => {
  // This test intentionally reproduces the failure mode being guarded
  // against — it exercises flow-order.js's weightedDistance directly (not
  // the gate) to document WHY the gate is needed, not to assert on
  // flow-order.js's own behaviour (which is correct and untouched).
  const anchor = { energy: 0.9, valence: 0.1, tempo: 180 }; // nothing like a featureless track
  const featureless = { id: 'ghost' }; // no energy/valence/tempo at all
  const d = weightedDistance(featureless, anchor);
  assert.equal(d, 0, 'a fully featureless track scores as distance 0 against ANY anchor — this is why it must never reach buildQueue');
});
