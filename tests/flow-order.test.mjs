// Shotgun — flow-order tests
//
// Run with: node --test tests/
// Uses only the mock library (js/backends/local-backend.js) — no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { orderForFlow, buildQueue, passesMoodFilters, weightedDistance } from '../js/flow-order.js';
import { MOOD_PRESETS } from '../js/config.js';
import { LocalBackend } from '../js/backends/local-backend.js';

async function library() {
  return new LocalBackend().getLibrary();
}

// ---------------------------------------------------------------------
// Queue length respected
// ---------------------------------------------------------------------

test('buildQueue returns exactly the requested length (or the whole pool if smaller)', async () => {
  const lib = await library();
  for (const n of [1, 3, 8, 12, 25, 60]) {
    const q = buildQueue(lib, { n, varietySeed: `len-${n}` });
    assert.equal(q.length, Math.min(n, lib.length), `n=${n}`);
  }
});

test('orderForFlow never changes the track count', async () => {
  const lib = await library();
  const subset = lib.slice(0, 7);
  const ordered = orderForFlow(subset, subset[0]);
  assert.equal(ordered.length, subset.length);
  // Same set of ids, just reordered.
  const idsBefore = new Set(subset.map((t) => t.id));
  const idsAfter = new Set(ordered.map((t) => t.id));
  assert.deepEqual([...idsAfter].sort(), [...idsBefore].sort());
});

// ---------------------------------------------------------------------
// Adjacent-step smoothness — the hard requirement — across many seeded runs
// ---------------------------------------------------------------------

test('adjacent steps stay smooth across many seeded runs, for every mood', async () => {
  const lib = await library();
  const THRESHOLD = 0.4; // weighted-distance budget for any single adjacent step
  const RUNS = 25;

  for (const moodId of Object.keys(MOOD_PRESETS)) {
    const preset = MOOD_PRESETS[moodId];
    for (let run = 0; run < RUNS; run++) {
      const q = buildQueue(lib, {
        n: 10,
        anchor: preset.target,
        filters: preset.filters,
        familiarityWeighted: preset.familiarityWeighted,
        arc: preset.arc,
        varietySeed: `${moodId}-${run}`,
      });
      for (let i = 1; i < q.length; i++) {
        const d = weightedDistance(q[i - 1], q[i]);
        assert.ok(
          d <= THRESHOLD,
          `${moodId} run ${run}: step ${i} (${q[i - 1].title} -> ${q[i].title}) distance ${d.toFixed(3)} exceeded ${THRESHOLD}`
        );
      }
    }
  }
});

test('adjacent steps stay smooth for an unfiltered (Just Play style) queue too', async () => {
  const lib = await library();
  const THRESHOLD = 0.5; // a bit looser — no mood filter constrains the pool to one cluster
  for (let run = 0; run < 15; run++) {
    const q = buildQueue(lib, { n: 12, varietySeed: `justplay-${run}` });
    for (let i = 1; i < q.length; i++) {
      const d = weightedDistance(q[i - 1], q[i]);
      assert.ok(d <= THRESHOLD, `run ${run}: step ${i} distance ${d.toFixed(3)} exceeded ${THRESHOLD}`);
    }
  }
});

// ---------------------------------------------------------------------
// Anchor respected
// ---------------------------------------------------------------------

test('the first track lands near the anchor, for every mood', async () => {
  const lib = await library();
  for (const moodId of Object.keys(MOOD_PRESETS)) {
    const preset = MOOD_PRESETS[moodId];
    for (let run = 0; run < 10; run++) {
      const q = buildQueue(lib, {
        n: 8,
        anchor: preset.target,
        filters: preset.filters,
        varietySeed: `${moodId}-anchor-${run}`,
      });
      const d = weightedDistance(q[0], preset.target);
      assert.ok(d < 0.35, `${moodId} run ${run}: first track too far from anchor (${d.toFixed(3)})`);
    }
  }
});

test('a seed track anchors the drive and always leads it', async () => {
  const lib = await library();
  const seedTrack = lib.find((t) => t.id === 't31'); // Sad Gangster zone
  for (let run = 0; run < 10; run++) {
    const q = buildQueue(lib, {
      n: 6,
      anchor: seedTrack,
      mustInclude: [seedTrack.id],
      varietySeed: `seedtrack-${run}`,
    });
    assert.equal(q[0].id, seedTrack.id, `run ${run}: seed track was not first`);
  }
});

// ---------------------------------------------------------------------
// Variety — two runs with different seeds should differ
// ---------------------------------------------------------------------

test('different variety seeds produce different drives for the same anchor', async () => {
  const lib = await library();
  const preset = MOOD_PRESETS.singalong;
  const a = buildQueue(lib, { n: 8, anchor: preset.target, filters: preset.filters, varietySeed: 'seedA' });
  const b = buildQueue(lib, { n: 8, anchor: preset.target, filters: preset.filters, varietySeed: 'seedB' });
  const identical = a.length === b.length && a.every((t, i) => b[i] && b[i].id === t.id);
  assert.ok(!identical, 'two different variety seeds produced an identical queue');
});

test('the same variety seed reproduces the same drive (deterministic)', async () => {
  const lib = await library();
  const preset = MOOD_PRESETS.pumped;
  const a = buildQueue(lib, { n: 8, anchor: preset.target, filters: preset.filters, arc: preset.arc, varietySeed: 'fixed-seed' });
  const b = buildQueue(lib, { n: 8, anchor: preset.target, filters: preset.filters, arc: preset.arc, varietySeed: 'fixed-seed' });
  assert.deepEqual(a.map((t) => t.id), b.map((t) => t.id));
});

// ---------------------------------------------------------------------
// Mood filters exclude obviously-wrong tracks
// ---------------------------------------------------------------------

test('Sad Gangster filters reject a high-valence acoustic ballad outright', () => {
  const ballad = {
    id: 'fixture-ballad',
    title: 'Acoustic Ballad',
    artist: 'Test Fixture',
    energy: 0.30,
    valence: 0.90,
    tempo: 88,
    danceability: 0.20,
    acousticness: 0.85,
  };
  assert.equal(passesMoodFilters(ballad, MOOD_PRESETS.sadGangster.filters), false);
});

test('Sad Gangster selection never includes a mixed-in acoustic ballad, even across many runs', async () => {
  const lib = await library();
  const ballad = {
    id: 'fixture-ballad',
    title: 'Acoustic Ballad',
    artist: 'Test Fixture',
    duration: 200,
    energy: 0.30,
    valence: 0.90,
    tempo: 88,
    danceability: 0.20,
    acousticness: 0.85,
  };
  const preset = MOOD_PRESETS.sadGangster;
  const pool = [...lib, ballad];

  for (let run = 0; run < 10; run++) {
    const q = buildQueue(pool, {
      n: 10,
      anchor: preset.target,
      filters: preset.filters,
      varietySeed: `ballad-${run}`,
    });
    assert.ok(
      !q.some((t) => t.id === 'fixture-ballad'),
      `run ${run}: the acoustic ballad slipped into a Sad Gangster drive`
    );
  }
});

test('Chilled filters reject an obviously high-energy club track', () => {
  const clubTrack = { id: 'fixture-club', energy: 0.95, valence: 0.60, tempo: 150 };
  assert.equal(passesMoodFilters(clubTrack, MOOD_PRESETS.chilled.filters), false);
});

test('Pumped Up filters reject an obviously low-energy acoustic track', () => {
  const softTrack = { id: 'fixture-soft', energy: 0.15, valence: 0.50, tempo: 70 };
  assert.equal(passesMoodFilters(softTrack, MOOD_PRESETS.pumped.filters), false);
});
