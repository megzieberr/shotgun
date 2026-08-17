// Shotgun — seed-resolver matching tests
//
// Pure-function tests only (parseEntryQuery / scoreCandidate / classifyEntry)
// against MOCKED search results — no network, no localStorage, no `window`.
// Exercises the actual typo cases from her list (MOOD-SEEDS.md via
// js/mood-seeds-data.js): "Sweet Dreans" (Head Bumping) and "Satusfaction"
// (Pumped Up) must still resolve confidently once bestGuess has corrected
// the spelling, and any `unsure`-flagged row must never auto-accept no
// matter how good the match looks.
//
// Run the same way as every other test file here: `node --test tests/`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseEntryQuery, scoreCandidate, classifyEntry, AUTO_ACCEPT_THRESHOLD } from '../js/seed-resolver.js';

test('parseEntryQuery prefers bestGuess over raw, splits on the first " - "', () => {
  const withBestGuess = parseEntryQuery({
    raw: 'Sweet Dreans - Marilyn Manson',
    bestGuess: 'Sweet Dreams (Are Made of This) - Marilyn Manson',
  });
  assert.deepEqual(withBestGuess, { title: 'Sweet Dreams (Are Made of This)', artist: 'Marilyn Manson' });

  const rawOnly = parseEntryQuery({ raw: 'Walk - Pantera' });
  assert.deepEqual(rawOnly, { title: 'Walk', artist: 'Pantera' });
});

test('parseEntryQuery does not split on a hyphen inside the title itself (no " - " present)', () => {
  const parsed = parseEntryQuery({ raw: 'step into my life - Puwfu' });
  assert.deepEqual(parsed, { title: 'step into my life', artist: 'Puwfu' });
});

test('a bestGuess-corrected typo ("Sweet Dreans" -> "Sweet Dreams…") auto-accepts against a real search result', () => {
  const entry = {
    raw: 'Sweet Dreans - Marilyn Manson',
    bestGuess: 'Sweet Dreams (Are Made of This) - Marilyn Manson',
  };
  const candidates = [
    { id: 'sp1', title: 'Sweet Dreams (Are Made Of This)', artist: 'Marilyn Manson' },
    { id: 'sp2', title: 'Sweet Dreams', artist: 'Eurythmics' },
  ];
  const result = classifyEntry(entry, candidates);
  assert.equal(result.status, 'auto');
  assert.equal(result.best.id, 'sp1');
  assert.ok(result.score >= AUTO_ACCEPT_THRESHOLD);
});

test('a bestGuess-corrected typo ("Satusfaction" -> "Satisfaction") auto-accepts against a real search result', () => {
  const entry = { raw: 'Satusfaction - Benny Benassi', bestGuess: 'Satisfaction - Benny Benassi' };
  const candidates = [{ id: 'bb1', title: 'Satisfaction', artist: 'Benny Benassi' }];
  const result = classifyEntry(entry, candidates);
  assert.equal(result.status, 'auto');
  assert.equal(result.best.id, 'bb1');
});

test('case and punctuation differences alone never block an auto-accept', () => {
  const entry = { raw: 'Sicko Mode - Travis Scott', bestGuess: 'SICKO MODE - Travis Scott' };
  const candidates = [{ id: 'ts1', title: 'SICKO MODE!!', artist: 'travis scott' }];
  const result = classifyEntry(entry, candidates);
  assert.equal(result.status, 'auto');
  assert.equal(result.best.id, 'ts1');
});

test('an `unsure` row NEVER auto-accepts, even against a perfect-score match', () => {
  const entry = { raw: 'Nasy Jamx - Coolzone', unsure: true };
  const candidates = [{ id: 'perfect', title: 'Nasy Jamx', artist: 'Coolzone' }];
  const result = classifyEntry(entry, candidates);
  assert.equal(result.status, 'review');
  assert.equal(result.score, 1); // confirms this WOULD have auto-accepted if not for the unsure flag
  assert.equal(result.best.id, 'perfect'); // still surfaced as the top suggestion for her to confirm
});

test('a low-confidence match (wrong song entirely) is queued for review, not auto-accepted', () => {
  const entry = { raw: 'Walk - Pantera' };
  const candidates = [{ id: 'wrong', title: 'Walk This Way', artist: 'Run DMC' }];
  const result = classifyEntry(entry, candidates);
  assert.equal(result.status, 'review');
  assert.ok(result.score < AUTO_ACCEPT_THRESHOLD);
});

test('no search results at all -> review, with a null best and zero score', () => {
  const entry = { raw: 'Fases - Henru' };
  const result = classifyEntry(entry, []);
  assert.equal(result.status, 'review');
  assert.equal(result.best, null);
  assert.equal(result.score, 0);
  assert.deepEqual(result.alternatives, []);
});

test('alternatives are the top-3 ranked candidates, best first', () => {
  const entry = { raw: 'Look at Me! - XXXTentacion', bestGuess: 'Look At Me! - XXXTENTACION' };
  const candidates = [
    { id: 'far', title: 'Some Other Song', artist: 'Nobody Related' },
    { id: 'exact', title: 'Look At Me!', artist: 'XXXTENTACION' },
    { id: 'close', title: 'Look At Me', artist: 'XXXTENTACION' },
    { id: 'medium', title: 'Look At Us', artist: 'XXXTENTACION' },
  ];
  const result = classifyEntry(entry, candidates);
  assert.equal(result.status, 'auto');
  assert.equal(result.best.id, 'exact');
  assert.equal(result.alternatives.length, 3);
  assert.equal(result.alternatives[0].id, 'exact');
});

test('scoreCandidate does not penalise on artist when the entry has no artist half to compare', () => {
  const entry = { raw: 'Just A Title' }; // no " - ", so parseEntryQuery yields artist: ''
  const score = scoreCandidate(entry, { title: 'Just A Title', artist: 'Whoever Made It' });
  assert.equal(score, 1); // title-only match, full score
});
