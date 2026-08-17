// Shotgun — spotify-auth.js tests
//
// Two things unit-verified here, per the session's verification checklist:
//   1. PKCE S256 code-challenge generation against the RFC 7636 §A reference
//      test vector — no browser needed, crypto.subtle + TextEncoder are
//      both Node globals.
//   2. Single-flight token refresh: 10 concurrent getValidAccessToken()
//      callers on a near-expired token must share exactly ONE network
//      refresh call, not fire ten.
//
// spotify-auth.js touches `window`/`sessionStorage` only inside
// buildAuthorizeUrl()/handleRedirectCallback()/startLogin() — none of
// which this file calls — so importing it here is safe without a DOM. It
// DOES touch bare `localStorage` inside loadTokens/saveTokens, so a
// minimal in-memory polyfill is installed on globalThis BEFORE importing,
// same pattern as feature-cache.js's real storage-adapter seam.

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

const { generateCodeChallenge, getValidAccessToken } = await import('../js/spotify-auth.js');

const TOKENS_KEY = 'shotgun.spotify.tokens.v1';

test('S256 code challenge matches the RFC 7636 §A.2 reference vector', async () => {
  // https://www.rfc-editor.org/rfc/rfc7636#appendix-A — the spec's own
  // worked example, not a value this session invented.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  const challenge = await generateCodeChallenge(verifier);
  assert.equal(challenge, expected);
});

test('getValidAccessToken: 10 concurrent callers on a near-expired token share exactly ONE refresh', async () => {
  globalThis.localStorage.clear();
  globalThis.localStorage.setItem(
    TOKENS_KEY,
    JSON.stringify({
      accessToken: 'stale-token',
      refreshToken: 'refresh-abc',
      expiresAt: Date.now() + 1000, // well inside the 5-minute proactive-refresh margin
      scope: 'x',
    })
  );

  let refreshCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    refreshCalls++;
    // Simulate real network latency so the 10 concurrent callers actually
    // overlap in time rather than accidentally serializing themselves.
    await new Promise((resolve) => setTimeout(resolve, 40));
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'fresh-token', refresh_token: 'refresh-abc', expires_in: 3600 }),
      text: async () => '',
    };
  };

  try {
    const results = await Promise.all(Array.from({ length: 10 }, () => getValidAccessToken()));
    assert.equal(refreshCalls, 1, `expected exactly 1 refresh network call, got ${refreshCalls}`);
    assert.ok(
      results.every((token) => token === 'fresh-token'),
      'every concurrent caller should resolve to the SAME refreshed token'
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('getValidAccessToken: a token with plenty of validity left never triggers a refresh', async () => {
  globalThis.localStorage.clear();
  globalThis.localStorage.setItem(
    TOKENS_KEY,
    JSON.stringify({
      accessToken: 'still-good',
      refreshToken: 'refresh-abc',
      expiresAt: Date.now() + 30 * 60 * 1000, // 30 min out, well past the 5-min margin
      scope: 'x',
    })
  );

  let refreshCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    refreshCalls++;
    throw new Error('should not have been called — token was still valid');
  };

  try {
    const token = await getValidAccessToken();
    assert.equal(token, 'still-good');
    assert.equal(refreshCalls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
