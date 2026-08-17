// Shotgun — spotify-client.js (429 breaker) tests
//
// Exercises the low-level _throttledFetch() directly (no real Spotify
// token needed — see its doc comment) with a mocked global `fetch`, per the
// session's verification checklist:
//   - 429 with Retry-After: 2 pauses ~2s before the next attempt
//   - Retry-After: 30 (> the 15s hard-ban threshold) sets the persisted
//     ban and throws immediately — no waiting the full 30s out
//   - gap widens on 429, relaxes gradually on success
//
// Needs a localStorage polyfill (the ban deadline is persisted there) —
// same in-memory pattern as tests/spotify-auth.test.mjs. spotify-client.js
// imports getValidAccessToken/forceRefresh from spotify-auth.js at module
// load, but _throttledFetch() never calls them, so no token/session setup
// is needed for these tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeMemoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

globalThis.localStorage = makeMemoryStorage();

const { _throttledFetch, _resetThrottleForTests, _getGapMsForTests, isBanned, banRemainingMs, SpotifyBanError } =
  await import('../js/spotify-client.js');

function fakeResponse({ status, retryAfter } = {}) {
  const headers = new Map();
  if (retryAfter !== undefined) headers.set('Retry-After', String(retryAfter));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (headers.has(k) ? headers.get(k) : null) },
    text: async () => '',
    json: async () => ({}),
  };
}

test('a soft 429 (Retry-After: 2) pauses roughly 2s before the retry succeeds', async () => {
  globalThis.localStorage.clear();
  _resetThrottleForTests();

  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return fakeResponse({ status: 429, retryAfter: 2 });
    return fakeResponse({ status: 200 });
  };

  try {
    const started = Date.now();
    const res = await _throttledFetch('https://fake.test/x');
    const elapsed = Date.now() - started;

    assert.equal(res.status, 200);
    assert.equal(calls, 2, 'expected exactly one retry after the soft 429');
    assert.ok(elapsed >= 1900, `expected to wait ~2s, only waited ${elapsed}ms`);
    assert.ok(elapsed < 3500, `wait ran much longer than the ~2s Retry-After, took ${elapsed}ms`);
    assert.equal(isBanned(), false, 'a soft (short) 429 must never trigger a hard ban');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a hard 429 (Retry-After: 30, above the 15s threshold) bans immediately without waiting 30s out', async () => {
  globalThis.localStorage.clear();
  _resetThrottleForTests();

  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return fakeResponse({ status: 429, retryAfter: 30 });
  };

  try {
    const started = Date.now();
    await assert.rejects(() => _throttledFetch('https://fake.test/x'), SpotifyBanError);
    const elapsed = Date.now() - started;

    assert.equal(calls, 1, 'a hard ban must fail fast on the FIRST 429, not retry into a longer ban');
    assert.ok(elapsed < 1000, `hard ban should throw near-instantly, took ${elapsed}ms`);
    assert.equal(isBanned(), true, 'the ban must be recorded (and persisted) so a reload does not re-probe');
    assert.ok(banRemainingMs() > 25000, 'remaining ban time should reflect the full ~30s Retry-After');

    // A second call, even with a mocked fetch that would now succeed,
    // must never touch the network while banned — this is the "reopening
    // the app doesn't probe into a longer ban" requirement.
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return fakeResponse({ status: 200 });
    };
    await assert.rejects(() => _throttledFetch('https://fake.test/x'), SpotifyBanError);
    assert.equal(calls, 0, 'a banned client must refuse locally, never touch the network');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the persisted ban survives a fresh module-level check — reopening the app does not re-probe', async () => {
  // isBanned()/banRemainingMs() read localStorage FRESH on every call
  // (not a cached in-memory flag) specifically so this holds across a
  // reload, not just within one still-running session.
  globalThis.localStorage.clear();
  _resetThrottleForTests();

  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return fakeResponse({ status: 429, retryAfter: 20 });
  };
  try {
    await assert.rejects(() => _throttledFetch('https://fake.test/x'), SpotifyBanError);
  } finally {
    globalThis.fetch = realFetch;
  }

  // Simulate "app reopened" — nothing but the persisted localStorage state
  // carries over; a fresh isBanned() check (as spotifyFetch() does on
  // every call) must still say banned.
  assert.equal(isBanned(), true);
});

test('the gap widens on 429 and relaxes gradually on clean success', async () => {
  globalThis.localStorage.clear();
  _resetThrottleForTests();

  const gapAtStart = _getGapMsForTests();

  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return fakeResponse({ status: 429, retryAfter: 1 });
    return fakeResponse({ status: 200 });
  };

  try {
    await _throttledFetch('https://fake.test/x'); // one soft 429 then a success
    const gapAfter429 = _getGapMsForTests();
    assert.ok(gapAfter429 > gapAtStart, `gap should widen after a 429 (was ${gapAtStart}, now ${gapAfter429})`);

    // A run of clean successes should relax it back down, never below the
    // floor. 12 iterations is enough for the *0.9-per-success decay to
    // visibly drop and hit the 350ms floor without a slow test (each
    // iteration pays the real gap as wall-clock wait time).
    globalThis.fetch = async () => fakeResponse({ status: 200 });
    for (let i = 0; i < 12; i++) {
      await _throttledFetch('https://fake.test/x');
    }
    const gapAfterRecovery = _getGapMsForTests();
    assert.ok(
      gapAfterRecovery < gapAfter429,
      `gap should relax back down after sustained success (was ${gapAfter429}, now ${gapAfterRecovery})`
    );
    assert.ok(gapAfterRecovery >= 350, 'gap should never relax below the 350ms floor from the brief');
  } finally {
    globalThis.fetch = realFetch;
  }
});
