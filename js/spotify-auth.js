// Shotgun — Spotify Authorization Code with PKCE
//
// No client secret exists anywhere in this app, by design (see the app
// brief) — PKCE (Proof Key for Code Exchange) is the OAuth flow made for a
// public client that can't keep a secret. This file owns:
//   - code_verifier + S256 code_challenge generation (crypto.subtle)
//   - building the authorize URL, with a `state` param checked on return
//   - the redirect-back handler: exchange code -> tokens, then scrub the
//     query string (history.replaceState) so a reload never re-exchanges a
//     spent (single-use) code
//   - token storage in localStorage + single-flight, proactive refresh
//
// Reference design: her brother's DecklingAir (server/spotify.js,
// getToken()/refreshAccessToken()) — same single-flight
// refresh-inflight-promise pattern, ported client-side. His version signs
// the refresh request with a client secret (server-side Basic auth); this
// one can't, since no secret exists — PKCE's code_verifier stands in for it
// at the authorization-code exchange, and the refresh request just sends
// client_id in the body instead of an Authorization header.

import {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_SCOPES,
  SPOTIFY_AUTH_ENDPOINT,
  SPOTIFY_TOKEN_ENDPOINT,
  getSpotifyRedirectUri,
} from './config.js';

const TOKENS_KEY = 'shotgun.spotify.tokens.v1';
const VERIFIER_KEY = 'shotgun.spotify.pkceVerifier.v1';
const STATE_KEY = 'shotgun.spotify.oauthState.v1';

// Proactively refresh when less than this much validity remains, per the
// build brief — keeps normal usage from ever hitting a 401 in the first place.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// PKCE primitives
// ---------------------------------------------------------------------------

function randomHexString(length) {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ('0' + b.toString(16)).slice(-2))
    .join('')
    .slice(0, length);
}

function base64UrlEncode(buffer) {
  let str = '';
  const bytes = new Uint8Array(buffer);
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * S256 code_challenge for a given code_verifier (RFC 7636 §4.2:
 * BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))). Exported standalone so it
 * can be unit-verified against the RFC's own test vector without touching
 * window/localStorage.
 * @param {string} verifier
 * @returns {Promise<string>}
 */
export async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(digest);
}

function generateCodeVerifier() {
  // RFC 7636 §4.1: 43-128 chars from [A-Za-z0-9-._~]. Hex output is a
  // strict subset of that alphabet, so no extra filtering is needed.
  return randomHexString(96);
}

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

function loadTokens() {
  try {
    const raw = localStorage.getItem(TOKENS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn('Shotgun: could not read stored Spotify tokens', err);
    return null;
  }
}

function saveTokens(tokens) {
  try {
    localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
  } catch (err) {
    console.warn('Shotgun: could not persist Spotify tokens', err);
  }
}

export function clearTokens() {
  try {
    localStorage.removeItem(TOKENS_KEY);
  } catch (err) {
    console.warn('Shotgun: could not clear stored Spotify tokens', err);
  }
}

/** True if a (possibly expired-but-refreshable) Spotify session exists. */
export function hasSession() {
  const t = loadTokens();
  return !!(t && t.refreshToken);
}

export function logout() {
  clearTokens();
}

// ---------------------------------------------------------------------------
// Authorize URL + redirect handling
// ---------------------------------------------------------------------------

/** @returns {Promise<string>} a fully-formed accounts.spotify.com/authorize URL. */
export async function buildAuthorizeUrl() {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const state = randomHexString(32);

  // sessionStorage, not localStorage: this pair is only needed to survive
  // the redirect round-trip, never across a later session.
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: SPOTIFY_SCOPES.join(' '),
    redirect_uri: getSpotifyRedirectUri(),
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });

  return `${SPOTIFY_AUTH_ENDPOINT}?${params.toString()}`;
}

/** Navigates the browser to Spotify's login/consent screen. */
export function startLogin() {
  buildAuthorizeUrl()
    .then((url) => {
      window.location.assign(url);
    })
    .catch((err) => {
      console.error('Shotgun: could not build the Spotify authorize URL', err);
    });
}

function scrubQueryString() {
  const url = new URL(window.location.href);
  url.search = '';
  window.history.replaceState({}, document.title, url.toString());
}

async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: getSpotifyRedirectUri(),
    client_id: SPOTIFY_CLIENT_ID,
    code_verifier: verifier,
  });

  const res = await fetch(SPOTIFY_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Spotify token exchange failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  saveTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token, // PKCE's authorization_code grant does return one
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope || '',
  });
}

/**
 * Call once on every app boot, BEFORE anything reads api.hasSpotifyAuth().
 * If the current URL carries a Spotify redirect (`?code=...&state=...`),
 * verifies `state` against what was stashed before redirecting, exchanges
 * the code for tokens, then always scrubs the query string via
 * history.replaceState — even on failure — so a reload never re-exchanges a
 * spent code and the PWA's URL stays clean.
 * @returns {Promise<'authenticated'|'error'|'none'>}
 */
export async function handleRedirectCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const authError = params.get('error');

  if (!code && !authError) return 'none';

  const expectedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);

  scrubQueryString();

  if (authError) {
    console.warn('Shotgun: Spotify authorization returned an error:', authError);
    return 'error';
  }
  if (!state || state !== expectedState) {
    console.warn('Shotgun: Spotify redirect state mismatch — ignoring (possible stale/duplicate callback)');
    return 'error';
  }
  if (!verifier) {
    console.warn('Shotgun: no PKCE verifier found for this redirect — cannot exchange code');
    return 'error';
  }

  try {
    await exchangeCode(code, verifier);
    return 'authenticated';
  } catch (exchangeErr) {
    console.error('Shotgun: Spotify code exchange failed', exchangeErr);
    return 'error';
  }
}

// ---------------------------------------------------------------------------
// Refresh: single-flight, proactive
// ---------------------------------------------------------------------------

let refreshInflight = null;

async function refreshAccessToken() {
  const tokens = loadTokens();
  if (!tokens || !tokens.refreshToken) {
    throw new Error('Shotgun: no Spotify refresh token available — log in again.');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: SPOTIFY_CLIENT_ID, // PKCE refresh: client_id in the body, no client secret / Basic auth
  });

  const res = await fetch(SPOTIFY_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Spotify token refresh failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  const updated = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || tokens.refreshToken, // Spotify doesn't always rotate it
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope || tokens.scope || '',
  };
  saveTokens(updated);
  return updated.accessToken;
}

/**
 * @returns {Promise<string>} a valid access token. Refreshes proactively
 *   (single-flight — every concurrent caller shares the ONE in-flight
 *   refresh promise, never a burst of refresh calls) once less than
 *   REFRESH_MARGIN_MS of validity remains.
 */
export async function getValidAccessToken() {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Shotgun: not logged in to Spotify.');

  if (Date.now() >= tokens.expiresAt - REFRESH_MARGIN_MS) {
    if (refreshInflight) return refreshInflight;
    refreshInflight = refreshAccessToken().finally(() => {
      refreshInflight = null;
    });
    return refreshInflight;
  }
  return tokens.accessToken;
}

/**
 * Force a refresh regardless of expiry — used by spotify-client.js as the
 * one-shot recovery after a surprise 401 slips past the proactive check.
 * Still single-flight: joins an already-inflight refresh rather than
 * starting a second one.
 */
export async function forceRefresh() {
  if (refreshInflight) return refreshInflight;
  refreshInflight = refreshAccessToken().finally(() => {
    refreshInflight = null;
  });
  return refreshInflight;
}
