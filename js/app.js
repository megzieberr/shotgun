// Shotgun — UI controller
//
// Talks only to js/api.js (never a backend directly) and js/flow-order.js.
// This session runs entirely on mock data — every "stock the queue" tap
// below calls the same facade methods a real Spotify backend will answer
// in session 2.

import * as api from './api.js';
import { orderForFlow } from './flow-order.js';
import {
  MOOD_PRESETS,
  MOOD_ORDER,
  DEFAULT_DRIVE_MINUTES,
  DRIVE_LENGTH_OPTIONS,
  songsForMinutes,
} from './config.js';

const SETTINGS_KEY = 'shotgun.settings.defaultMinutes';

const ICONS = {
  chilled:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 9c1.5-1.5 3-1.5 4.5 0s3 1.5 4.5 0 3-1.5 4.5 0 3 1.5 4.5 0"/><path d="M3 15c1.5-1.5 3-1.5 4.5 0s3 1.5 4.5 0 3-1.5 4.5 0 3 1.5 4.5 0"/></svg>',
  singalong:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v4"/><path d="M8 22h8"/></svg>',
  pumped:
    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>',
  sadGangster:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8h4l1.5 2h9L18 8h4"/><circle cx="6.5" cy="13" r="3.5"/><circle cx="17.5" cy="13" r="3.5"/><path d="M10 13h4"/></svg>',
};

// ---------- State ----------

let library = [];
let driveMinutes = loadDefaultMinutes();
let selectedSeed = null;

// ---------- Boot ----------

init();

async function init() {
  wireStaticControls();
  startClock();
  renderMoodTiles();
  renderLengthChips(document.getElementById('length-chips'), driveMinutes, onHomeLengthChange);
  renderLengthChips(document.getElementById('settings-length-chips'), driveMinutes, onSettingsLengthChange);
  updateDriveHint();

  try {
    library = await api.getLibrary();
  } catch (err) {
    console.error('Shotgun: failed to load library', err);
    showToast('Could not load the song library.');
  }
}

// ---------- Static control wiring ----------

function wireStaticControls() {
  document.getElementById('btn-open-settings').addEventListener('click', () => showView('view-settings'));
  document.getElementById('btn-close-settings').addEventListener('click', () => showView('view-home'));
  document.getElementById('btn-plan-another').addEventListener('click', () => showView('view-home'));
  document.getElementById('btn-just-play').addEventListener('click', startJustPlayDrive);
  document.getElementById('btn-stock-seed').addEventListener('click', () => {
    if (selectedSeed) startSeedDrive(selectedSeed);
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
    btn.addEventListener('click', () => startMoodDrive(id));
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
      <span class="seed-result-energy">E ${track.energy.toFixed(2)}</span>
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

// ---------- Drive builders ----------

function inRange(value, [min, max]) {
  return value >= min && value <= max;
}

/** Nearest-neighbour pick by distance to an energy/valence centre point. */
function pickByDistance(pool, center, n) {
  const scored = pool
    .map((t) => ({ t, d: Math.hypot(t.energy - center.energy, t.valence - center.valence) }))
    .sort((a, b) => a.d - b.d);
  return scored.slice(0, Math.min(n, pool.length)).map((s) => s.t);
}

async function startMoodDrive(moodId) {
  const preset = MOOD_PRESETS[moodId];
  const n = songsForMinutes(driveMinutes);
  const center = {
    energy: (preset.energy[0] + preset.energy[1]) / 2,
    valence: (preset.valence[0] + preset.valence[1]) / 2,
  };

  const inBand = library.filter((t) => inRange(t.energy, preset.energy) && inRange(t.valence, preset.valence));
  let selection;
  if (inBand.length >= n) {
    selection = pickByDistance(inBand, center, n);
  } else {
    // Not enough songs strictly inside the mood band for a long drive —
    // widen to the whole library, nearest to the band centre first.
    selection = pickByDistance(library, center, n);
  }

  const ordered = orderForFlow(selection, center);
  await runStockingFlow(ordered, {
    kind: 'mood',
    label: preset.label,
    accentVar: preset.accent,
    subtitle: `Building your ${preset.label} drive · ${driveMinutes} min · ${ordered.length} songs`,
  });
}

async function startSeedDrive(seedTrack) {
  const n = songsForMinutes(driveMinutes);
  const rest = library.filter((t) => t.id !== seedTrack.id);
  const nearest = pickByDistance(rest, seedTrack, n - 1);
  const selection = [seedTrack, ...nearest];

  const ordered = orderForFlow(selection, seedTrack);
  await runStockingFlow(ordered, {
    kind: 'seed',
    label: `“${seedTrack.title}”`,
    accentVar: '--teal',
    subtitle: `Anchored to “${seedTrack.title}” · ${driveMinutes} min · ${ordered.length} songs`,
  });
}

async function startJustPlayDrive() {
  // TODO (session 4): replace with the learned time-of-day profile from
  // Supabase. For now this is an honest stub — a balanced mix, evenly
  // spread across the whole library rather than one mood band.
  showToast('Taste learning arrives in a later build — using a balanced mix for now.');

  const n = songsForMinutes(driveMinutes);
  const shuffled = [...library].sort(() => Math.random() - 0.5);
  const selection = shuffled.slice(0, Math.min(n, shuffled.length));

  const ordered = orderForFlow(selection, null);
  await runStockingFlow(ordered, {
    kind: 'justPlay',
    label: 'Just Play',
    accentVar: '--amber',
    subtitle: `Building a balanced mix · ${driveMinutes} min · ${ordered.length} songs`,
  });
}

// ---------- Stocking + confirm ----------

async function runStockingFlow(orderedTracks, context) {
  document.getElementById('stocking-sub').textContent = context.subtitle;
  showView('view-stocking');

  const minAnimation = new Promise((resolve) => setTimeout(resolve, 1400));
  const stockCall = api.stockQueue(orderedTracks.map((t) => t.id));

  let result;
  try {
    [, result] = await Promise.all([minAnimation, stockCall]);
  } catch (err) {
    console.error('Shotgun: stockQueue failed', err);
    showToast('Could not stock the queue.');
    showView('view-home');
    return;
  }

  renderConfirm(result.tracks, context);
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

// ---------- View + toast helpers ----------

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
