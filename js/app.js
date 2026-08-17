// Shotgun — UI controller
//
// Talks only to js/api.js (never a backend directly) and js/flow-order.js.
// This session runs entirely on mock data — every "stock the queue" tap
// below calls the same facade methods a real Spotify backend will answer
// in session 2.

import * as api from './api.js';
import * as spotifyAuth from './spotify-auth.js';
import * as seedResolver from './seed-resolver.js';
import { buildQueue, averageFeatures } from './flow-order.js';
import {
  MOOD_PRESETS,
  MOOD_ORDER,
  MOOD_SEEDS,
  DEFAULT_DRIVE_MINUTES,
  DRIVE_LENGTH_OPTIONS,
  songsForMinutes,
} from './config.js';

const SETTINGS_KEY = 'shotgun.settings.defaultMinutes';

// QA-only: `?slowscan=<ms>` adds an artificial per-chunk delay to the
// library scan so the progress strip can be demoed/verified without a real
// 200-track library. Never set outside manual testing.
const SLOWSCAN_MS = Number(new URLSearchParams(window.location.search).get('slowscan')) || 0;

const ICONS = {
  chilled:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 9c1.5-1.5 3-1.5 4.5 0s3 1.5 4.5 0 3-1.5 4.5 0 3 1.5 4.5 0"/><path d="M3 15c1.5-1.5 3-1.5 4.5 0s3 1.5 4.5 0 3-1.5 4.5 0 3 1.5 4.5 0"/></svg>',
  feelGood:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v4"/><path d="M8 22h8"/></svg>',
  pumped:
    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>',
  sadGangster:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8h4l1.5 2h9L18 8h4"/><circle cx="6.5" cy="13" r="3.5"/><circle cx="17.5" cy="13" r="3.5"/><path d="M10 13h4"/></svg>',
  headBumping:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12l3-8 3 16 3-16 3 16 3-16 3 8"/></svg>',
  afrikaansRap:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-7.58 7-12.5A7 7 0 0 0 5 9.5C5 14.42 12 22 12 22z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
};

// ---------- State ----------

let library = [];
// The pool buildQueue is actually allowed to draw from: `library` merged
// with resolved audio features, tracks that never resolved dropped (the
// foreman review rule — see api.js's resolveCandidatePool/
// keepTracksWithFeatures doc comments for why an unresolved track can't be
// allowed anywhere near buildQueue).
let candidatePool = [];
let driveMinutes = loadDefaultMinutes();
let selectedSeed = null;

// The first library scan (~200 tracks through ReccoBeats) takes minutes and
// was previously silent — she hit the dead-end live (tiles looked ready,
// taps just toasted "no songs yet"). This tracks scan-in-progress state so
// the home screen can show real progress instead of going quiet.
let scanState = { active: false, done: 0, total: 0 };

// ---------- Boot ----------

init();

async function init() {
  wireStaticControls();
  startClock();
  renderMoodTiles();
  renderLengthChips(document.getElementById('length-chips'), driveMinutes, onHomeLengthChange);
  renderLengthChips(document.getElementById('settings-length-chips'), driveMinutes, onSettingsLengthChange);
  updateDriveHint();

  // Always apply whatever's already resolved from a previous session, even
  // before the redirect/library work below — a resolved seed should affect
  // the very first drive of THIS session too, not just ones after a fresh
  // resolution pass.
  seedResolver.applyResolvedSeedsToConfig();

  // MUST run before the first api.* call: a Spotify redirect can save fresh
  // tokens here, and api.js's backend selection is re-checked per call (not
  // cached from page-load), so getLibrary() right below already sees the
  // real auth state on the very same page load that returns from Spotify.
  try {
    const redirectResult = await spotifyAuth.handleRedirectCallback();
    if (redirectResult === 'authenticated') showToast('Connected to Spotify.');
    else if (redirectResult === 'error') showToast('Could not connect to Spotify — please try again.');
  } catch (err) {
    console.error('Shotgun: Spotify redirect handling failed', err);
  }

  await refreshLibrary();
  renderSpotifyAccountPanel();

  // Fire-and-forget: the once-ever seed resolution pass. Gated on real
  // Spotify auth (there's no point burning search calls against the local
  // mock library, which doesn't carry her real seed songs) AND on never
  // having run before (hasResolvedOnce persists across sessions). Runs
  // silently in the background — no progress UI per the brief, only the
  // library scan gets one — and offers the review UI once when it's done.
  if (api.hasSpotifyAuth() && !seedResolver.hasResolvedOnce()) {
    seedResolver
      .resolveAllMoodSeeds()
      .then((result) => {
        seedResolver.applyResolvedSeedsToConfig();
        maybeOfferReviewBanner(result.pending);
      })
      .catch((err) => console.error('Shotgun: seed resolution pass failed', err));
  }
}

/** (Re)loads the library from whichever backend is active and resolves it
 * into a buildQueue-safe candidate pool. Called on boot, after login, and
 * after logout (the backend — and therefore the library — changes each time). */
async function refreshLibrary() {
  scanState = { active: true, done: 0, total: 0 };
  renderScanStrip();
  try {
    library = await api.getLibrary();
    scanState.total = library.length;
    renderScanStrip();

    candidatePool = await api.resolveCandidatePool(library, {
      onProgress: (done, total) => {
        scanState = { active: true, done, total };
        renderScanStrip();
      },
      chunkDelayMs: SLOWSCAN_MS,
    });

    if (library.length && !candidatePool.length) {
      showToast('Songs are loaded, but none have known audio features yet — try again shortly.');
    }
  } catch (err) {
    console.error('Shotgun: failed to load library', err);
    showToast('Could not load the song library.');
    library = [];
    candidatePool = [];
  } finally {
    scanState.active = false;
    renderScanStrip();
  }
}

// ---------- Scan progress strip ----------

function renderScanStrip() {
  const strip = document.getElementById('scan-strip');
  const grid = document.getElementById('mood-grid');
  if (!scanState.active || scanState.total === 0) {
    strip.classList.remove('is-visible');
    grid.classList.remove('is-warming');
    return;
  }
  document.getElementById('scan-strip-text').textContent =
    `Getting to know your library… ${scanState.done} of ${scanState.total}`;
  document.getElementById('scan-strip-fill').style.width =
    `${Math.min(100, Math.round((scanState.done / scanState.total) * 100))}%`;
  strip.classList.add('is-visible');
  grid.classList.add('is-warming');
}

function isScanning() {
  return scanState.active;
}

function scanToast() {
  const count = scanState.total ? `${scanState.done} of ${scanState.total}` : 'a few';
  showToast(`Still getting to know your library — ${count} songs so far. Try again in a moment.`, 3000);
}

// ---------- Static control wiring ----------

function wireStaticControls() {
  document.getElementById('btn-open-settings').addEventListener('click', () => {
    showView('view-settings');
    renderSpotifyAccountPanel();
  });
  document.getElementById('btn-close-settings').addEventListener('click', () => showView('view-home'));
  document.getElementById('btn-plan-another').addEventListener('click', () => showView('view-home'));
  document.getElementById('btn-just-play').addEventListener('click', () => {
    if (isScanning()) return scanToast();
    startJustPlayDrive();
  });
  document.getElementById('btn-stock-seed').addEventListener('click', () => {
    if (isScanning()) return scanToast();
    if (selectedSeed) startSeedDrive(selectedSeed);
  });

  document.getElementById('btn-review-seeds').addEventListener('click', () => {
    showView('view-review');
    renderReviewQueue();
  });
  document.getElementById('btn-close-review').addEventListener('click', () => showView('view-settings'));
  document.getElementById('btn-review-now').addEventListener('click', () => {
    document.getElementById('seed-review-banner').classList.remove('is-visible');
    showView('view-review');
    renderReviewQueue();
  });
  document.getElementById('btn-review-dismiss').addEventListener('click', () => {
    document.getElementById('seed-review-banner').classList.remove('is-visible');
  });

  document.getElementById('btn-connect-spotify').addEventListener('click', () => {
    spotifyAuth.startLogin();
  });
  document.getElementById('btn-spotify-logout').addEventListener('click', async () => {
    spotifyAuth.logout();
    showToast('Logged out of Spotify. Local data stays put.');
    renderSpotifyAccountPanel();
    await refreshLibrary();
  });

  const seedInput = document.getElementById('seed-input');
  const seedResults = document.getElementById('seed-results');
  seedInput.addEventListener('input', async () => {
    const q = seedInput.value.trim();
    if (q.length < 2) {
      seedResults.classList.remove('is-open');
      seedResults.innerHTML = '';
      return;
    }
    const matches = await api.searchTracks(q);
    renderSeedResults(matches.slice(0, 6));
  });

  document.getElementById('seed-clear').addEventListener('click', clearSeed);
}

// ---------- Clock ----------

function startClock() {
  const el = document.getElementById('clock');
  const tick = () => {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    el.textContent = `${hh}:${mm}`;
  };
  tick();
  setInterval(tick, 15000);
}

// ---------- Mood tiles ----------

function renderMoodTiles() {
  const grid = document.getElementById('mood-grid');
  grid.innerHTML = '';
  for (const id of MOOD_ORDER) {
    const preset = MOOD_PRESETS[id];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mood-tile';
    btn.style.setProperty('--tile-accent', `var(${preset.accent})`);
    btn.setAttribute('aria-label', `${preset.label} — ${preset.descriptor}`);
    btn.innerHTML = `
      <span class="mood-icon">${ICONS[preset.icon]}</span>
      <span class="mood-label">${preset.label}</span>
      <span class="mood-descriptor">${preset.descriptor}</span>
      <span class="tile-underline" aria-hidden="true"></span>
    `;
    btn.addEventListener('click', () => {
      if (isScanning()) return scanToast();
      startMoodDrive(id);
    });
    grid.appendChild(btn);
  }
}

// ---------- Drive-length chips ----------

function renderLengthChips(container, selectedMinutes, onSelect) {
  container.innerHTML = '';
  for (const minutes of DRIVE_LENGTH_OPTIONS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (minutes === selectedMinutes ? ' is-selected' : '');
    chip.textContent = `${minutes}`;
    chip.setAttribute('aria-pressed', String(minutes === selectedMinutes));
    chip.addEventListener('click', () => onSelect(minutes, container));
    container.appendChild(chip);
  }
}

function onHomeLengthChange(minutes) {
  driveMinutes = minutes;
  persistDefaultMinutes(minutes);
  renderLengthChips(document.getElementById('length-chips'), driveMinutes, onHomeLengthChange);
  renderLengthChips(document.getElementById('settings-length-chips'), driveMinutes, onSettingsLengthChange);
  updateDriveHint();
}

function onSettingsLengthChange(minutes) {
  onHomeLengthChange(minutes);
  showToast(`Default drive length set to ${minutes} min.`);
}

function updateDriveHint() {
  const n = songsForMinutes(driveMinutes);
  document.getElementById('drive-hint').innerHTML =
    `~<b>${n}</b> song${n === 1 ? '' : 's'} for a ${driveMinutes}-minute drive`;
}

function loadDefaultMinutes() {
  const raw = localStorage.getItem(SETTINGS_KEY);
  const n = Number(raw);
  return DRIVE_LENGTH_OPTIONS.includes(n) ? n : DEFAULT_DRIVE_MINUTES;
}

function persistDefaultMinutes(minutes) {
  try {
    localStorage.setItem(SETTINGS_KEY, String(minutes));
  } catch (err) {
    // localStorage can throw in private-browsing edge cases; non-fatal here.
    console.warn('Shotgun: could not persist default drive length', err);
  }
}

// ---------- Seed search ----------

function renderSeedResults(matches) {
  const box = document.getElementById('seed-results');
  if (!matches.length) {
    box.innerHTML = '<div class="seed-result-row" style="cursor:default;">No matches in the library.</div>';
    box.classList.add('is-open');
    return;
  }
  box.innerHTML = '';
  for (const track of matches) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'seed-result-row';
    row.innerHTML = `
      <span>
        <span class="seed-result-title">${escapeHtml(track.title)}</span><br/>
        <span class="seed-result-artist">${escapeHtml(track.artist)}</span>
      </span>
      <span class="seed-result-energy">${isNum(track.energy) ? `E ${track.energy.toFixed(2)}` : ''}</span>
    `;
    row.addEventListener('click', () => pickSeed(track));
    box.appendChild(row);
  }
  box.classList.add('is-open');
}

function pickSeed(track) {
  selectedSeed = track;
  document.getElementById('seed-input').value = '';
  document.getElementById('seed-results').classList.remove('is-open');
  document.getElementById('seed-results').innerHTML = '';
  document.getElementById('seed-picked-title').textContent = `${track.title} — ${track.artist}`;
  document.getElementById('seed-picked').classList.add('is-visible');
  document.getElementById('btn-stock-seed').style.display = 'flex';
}

function clearSeed() {
  selectedSeed = null;
  document.getElementById('seed-picked').classList.remove('is-visible');
  document.getElementById('btn-stock-seed').style.display = 'none';
}

// ---------- Seed-song review UI ----------
//
// Reachable from Settings ("Review seed songs") any time, and auto-offered
// ONCE via a home-screen banner right after the first resolution pass
// finishes with pending items (maybeOfferReviewBanner). One card at a time,
// big touch targets, Accept / Skip / pick-an-alternative.

/** Shown once, right after the first-ever resolution pass, only if it left
 * anything for her to check. hasOfferedReview() makes this a true one-time
 * offer — dismissing (or reviewing) never brings it back; Settings' "Review
 * seed songs" button stays available regardless. */
function maybeOfferReviewBanner(pending) {
  if (!pending || !pending.length || seedResolver.hasOfferedReview()) return;
  document.getElementById('seed-review-banner-text').textContent =
    `${pending.length} seed song${pending.length === 1 ? '' : 's'} need a quick check.`;
  document.getElementById('seed-review-banner').classList.add('is-visible');
  seedResolver.markReviewOffered();
}

function renderReviewQueue() {
  const pending = seedResolver.getPendingReviewItems();
  const progressEl = document.getElementById('review-progress');
  const cardEl = document.getElementById('review-card');
  const emptyEl = document.getElementById('review-empty');

  if (!pending.length) {
    progressEl.textContent = '';
    cardEl.style.display = 'none';
    cardEl.innerHTML = '';
    emptyEl.style.display = 'block';
    return;
  }

  emptyEl.style.display = 'none';
  cardEl.style.display = 'block';

  const item = pending[0];
  progressEl.textContent = `${pending.length} song${pending.length === 1 ? '' : 's'} to check`;

  const moodLabel = (MOOD_PRESETS[item.moodKey] && MOOD_PRESETS[item.moodKey].label) || item.moodKey;
  const best = item.best;
  const otherAlternatives = (item.alternatives || []).filter((alt) => !best || alt.id !== best.id);

  cardEl.innerHTML = `
    <p class="review-mood-tag">${escapeHtml(moodLabel)}</p>
    <p class="review-prompt">Is this the one?</p>
    ${
      best
        ? `<div class="review-song">
             <div class="review-song-title">${escapeHtml(best.title)}</div>
             <div class="review-song-artist">${escapeHtml(best.artist)}</div>
           </div>`
        : `<div class="review-song review-song-none">
             <div class="review-song-title">No confident match found</div>
             <div class="review-song-artist">${escapeHtml(item.query)}</div>
           </div>`
    }
    <p class="review-source">From her list: “${escapeHtml(item.entry.raw)}”</p>
    <div class="review-actions">
      <button class="btn btn-secondary" id="review-skip-btn" type="button">Skip</button>
      ${best ? '<button class="btn btn-primary" id="review-accept-btn" type="button">Accept</button>' : ''}
    </div>
    ${
      otherAlternatives.length
        ? `<div class="review-alt-list">
            ${otherAlternatives
              .map(
                (alt, i) => `
              <button class="review-alt-row" type="button" data-alt-index="${i}">
                <span class="review-alt-title">${escapeHtml(alt.title)}</span>
                <span class="review-alt-artist">${escapeHtml(alt.artist)}</span>
              </button>`
              )
              .join('')}
          </div>`
        : ''
    }
  `;

  document.getElementById('review-skip-btn').addEventListener('click', () => {
    seedResolver.skipReviewItem(item.id);
    renderReviewQueue();
  });

  const acceptBtn = document.getElementById('review-accept-btn');
  if (acceptBtn) {
    acceptBtn.addEventListener('click', () => {
      seedResolver.acceptReviewItem(item.id, best);
      seedResolver.applyResolvedSeedsToConfig();
      renderReviewQueue();
    });
  }

  cardEl.querySelectorAll('.review-alt-row').forEach((row) => {
    row.addEventListener('click', () => {
      const chosen = otherAlternatives[Number(row.dataset.altIndex)];
      seedResolver.acceptReviewItem(item.id, chosen);
      seedResolver.applyResolvedSeedsToConfig();
      renderReviewQueue();
    });
  });
}

// ---------- Drive builders ----------
//
// All three drive kinds route through flow-order.js's buildQueue — the real
// selection + flow-ordering algorithm — rather than picking tracks here.
// This file's job is just: work out the anchor + filters for the situation,
// then hand off.

/**
 * A mood's anchor is its static `target` vector UNLESS MOOD_SEEDS has real
 * seed track ids for that mood — then the average of THOSE seed tracks'
 * own features overrides it. MOOD_SEEDS starts empty every page load and is
 * populated from localStorage by seed-resolver.js's
 * applyResolvedSeedsToConfig() (called on boot, and again after every
 * review-card accept/skip) — see js/config.js and js/seed-resolver.js.
 */
function resolveMoodAnchor(moodId, preset) {
  const seedIds = MOOD_SEEDS[moodId] || [];
  if (seedIds.length) {
    const seedTracks = candidatePool.filter((t) => seedIds.includes(t.id));
    if (seedTracks.length) return averageFeatures(seedTracks);
  }
  return preset.target;
}

async function startMoodDrive(moodId) {
  const preset = MOOD_PRESETS[moodId];
  const n = songsForMinutes(driveMinutes);
  const anchor = resolveMoodAnchor(moodId, preset);

  const ordered = buildQueue(candidatePool, {
    anchor,
    n,
    filters: preset.filters,
    familiarityWeighted: preset.familiarityWeighted,
    arc: preset.arc,
    varietySeed: `${moodId}-${Date.now()}`,
  });

  await runStockingFlow(ordered, {
    kind: 'mood',
    label: preset.label,
    accentVar: preset.accent,
    subtitle: `Building your ${preset.label} drive · ${driveMinutes} min · ${ordered.length} songs`,
  });
}

async function startSeedDrive(seedTrack) {
  const n = songsForMinutes(driveMinutes);

  // The picked seed might be a bare search result with no features yet
  // (e.g. a real Spotify search hit) — resolve its own features through the
  // same cache -> backend -> ReccoBeats path everything else uses so the
  // anchor buildQueue walks from is a real vector, not an empty one.
  let anchorTrack = seedTrack;
  try {
    const featuresById = await api.getAudioFeatures([seedTrack.id]);
    const resolved = featuresById[seedTrack.id];
    if (resolved) anchorTrack = { ...seedTrack, ...resolved };
  } catch (err) {
    console.warn('Shotgun: could not resolve the seed track’s own audio features', err);
  }

  const ordered = buildQueue(candidatePool, {
    anchor: anchorTrack,
    n,
    // Only actually forces a lead-in slot if the seed is part of
    // candidatePool (e.g. picked from her own library); a seed found via
    // Spotify search that isn't in the pool still anchors the drive via
    // `anchor` above, it just isn't guaranteed the literal first slot.
    mustInclude: [seedTrack.id],
    varietySeed: `seed-${seedTrack.id}-${Date.now()}`,
  });

  await runStockingFlow(ordered, {
    kind: 'seed',
    label: `“${seedTrack.title}”`,
    accentVar: '--teal',
    subtitle: `Anchored to “${seedTrack.title}” · ${driveMinutes} min · ${ordered.length} songs`,
  });
}

async function startJustPlayDrive() {
  // TODO (session 4): replace with the learned time-of-day profile from
  // Supabase. For now this is an honest stub — no mood filter, anchor
  // defaults to the library's own centroid (a "balanced mix"), still
  // flow-ordered and still varies drive to drive.
  showToast('Taste learning arrives in a later build — using a balanced mix for now.');

  const n = songsForMinutes(driveMinutes);
  const ordered = buildQueue(candidatePool, {
    n,
    varietySeed: `justplay-${Date.now()}`,
  });

  await runStockingFlow(ordered, {
    kind: 'justPlay',
    label: 'Just Play',
    accentVar: '--amber',
    subtitle: `Building a balanced mix · ${driveMinutes} min · ${ordered.length} songs`,
  });
}

// ---------- Stocking + confirm ----------

async function runStockingFlow(orderedTracks, context) {
  if (!orderedTracks.length) {
    showToast('No songs with known audio features to build a drive from yet.');
    return;
  }

  document.getElementById('stocking-sub').textContent = context.subtitle;
  showView('view-stocking');

  const minAnimation = new Promise((resolve) => setTimeout(resolve, 1400));
  const stockCall = api.stockQueue(orderedTracks.map((t) => t.id));

  try {
    await Promise.all([minAnimation, stockCall]);
  } catch (err) {
    console.error('Shotgun: stockQueue failed', err);
    if (err && err.code === 'NO_ACTIVE_DEVICE') {
      showToast('Open Spotify and tap play/pause once to wake a device, then try again.', 4400);
    } else if (err && err.name === 'SpotifyBanError') {
      showToast(err.message, 4400);
    } else {
      showToast('Could not stock the queue.');
    }
    showView('view-home');
    return;
  }

  // Render from the already-resolved track objects buildQueue produced
  // (full title/artist/duration/energy), not the backend's stockQueue
  // return value — the real Spotify backend's queue POST has no response
  // body to reconstruct display data from (204 No Content per track); the
  // backend call above only needs to confirm success/failure.
  renderConfirm(orderedTracks, context);
  showView('view-confirm');
}

function renderConfirm(tracks, context) {
  const totalSeconds = tracks.reduce((sum, t) => sum + t.duration, 0);
  const totalMin = Math.round(totalSeconds / 60);
  document.getElementById('confirm-meta').textContent =
    `${context.label} · ${tracks.length} songs · ~${totalMin} min`;

  const list = document.getElementById('track-list');
  list.innerHTML = '';
  tracks.forEach((t, i) => {
    const litBars = Math.max(1, Math.round(t.energy * 5));
    const bars = Array.from({ length: 5 }, (_, b) =>
      `<span class="e-bar ${b < litBars ? 'is-lit' : ''}" style="height:${6 + b * 3}px;"></span>`
    ).join('');
    const mins = Math.floor(t.duration / 60);
    const secs = String(t.duration % 60).padStart(2, '0');

    const row = document.createElement('div');
    row.className = 'track-row';
    row.style.setProperty('--track-accent', `var(${context.accentVar})`);
    row.innerHTML = `
      <span class="track-index">${i + 1}</span>
      <span class="track-info">
        <div class="track-title">${escapeHtml(t.title)}</div>
        <div class="track-artist">${escapeHtml(t.artist)}</div>
      </span>
      <span class="track-energy" aria-label="Energy ${t.energy.toFixed(2)}">${bars}</span>
      <span class="track-duration">${mins}:${secs}</span>
    `;
    list.appendChild(row);
  });
}

// ---------- Spotify account panel (Settings) ----------

async function renderSpotifyAccountPanel() {
  const nameEl = document.getElementById('spotify-account-name');
  const hintEl = document.getElementById('spotify-account-hint');
  const pillEl = document.getElementById('spotify-status-pill');
  const connectBtn = document.getElementById('btn-connect-spotify');
  const logoutBtn = document.getElementById('btn-spotify-logout');
  const aboutEl = document.getElementById('about-line');

  const authed = api.hasSpotifyAuth();
  logoutBtn.disabled = !authed;
  connectBtn.disabled = false;
  if (aboutEl) aboutEl.textContent = `Shotgun · ${api.activeBackendName()} data`;

  if (!authed) {
    nameEl.textContent = 'Spotify';
    hintEl.textContent = 'Not connected yet';
    pillEl.textContent = 'Not connected';
    pillEl.classList.remove('is-connected');
    connectBtn.textContent = 'Connect Spotify';
    return;
  }

  pillEl.textContent = 'Connected';
  pillEl.classList.add('is-connected');
  connectBtn.textContent = 'Reconnect Spotify';
  nameEl.textContent = 'Spotify';
  hintEl.textContent = 'Connected';

  try {
    const name = await api.getConnectedDisplayName();
    if (name) {
      nameEl.textContent = name;
      hintEl.textContent = 'Connected';
    } else {
      hintEl.textContent = 'Connected (name unavailable)';
    }
  } catch (err) {
    console.warn('Shotgun: could not load the Spotify display name', err);
    hintEl.textContent = 'Connected (could not load your name right now)';
  }
}

// ---------- View + toast helpers ----------

function isNum(v) {
  return typeof v === 'number' && !Number.isNaN(v);
}

function showView(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('is-active'));
  document.getElementById(id).classList.add('is-active');
}

let toastTimer = null;
function showToast(message, ms = 2800) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), ms);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------- Service worker ----------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Shotgun: service worker registration failed', err);
    });
  });
}
