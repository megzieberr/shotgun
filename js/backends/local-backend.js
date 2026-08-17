// Shotgun — local backend
//
// Implements the api.js facade entirely against an in-memory mock library.
// No network calls of any kind. This is the default backend while no
// Spotify auth exists, and can always be forced with ?local=1.

// --- Mock library: 40 invented songs across four mood zones ---
// Shape: { id, title, artist, duration (seconds), energy 0-1, valence 0-1,
// tempo (bpm), danceability 0-1, acousticness 0-1 }. The last two match what
// ReccoBeats actually returns (js/reccobeats.js) — added here so the mood
// filters in js/config.js (esp. Sad Gangster's "groove but NOT acoustic
// ballads" rule) have real data to exercise, even fully offline.
const LIBRARY = [
  // Chilled — indie, easy, low-energy calm mornings: soft danceability, leans acoustic.
  { id: 't01', title: 'Slow Windows', artist: 'Nora Vale', duration: 214, energy: 0.18, valence: 0.55, tempo: 78, danceability: 0.30, acousticness: 0.62 },
  { id: 't02', title: 'Porch Light', artist: 'Callum & the Quiet', duration: 231, energy: 0.22, valence: 0.60, tempo: 82, danceability: 0.34, acousticness: 0.58 },
  { id: 't03', title: 'Low Tide', artist: 'Marina Cole', duration: 198, energy: 0.15, valence: 0.48, tempo: 70, danceability: 0.26, acousticness: 0.70 },
  { id: 't04', title: 'Coffee at Six', artist: 'The Long Exhale', duration: 205, energy: 0.28, valence: 0.62, tempo: 88, danceability: 0.38, acousticness: 0.50 },
  { id: 't05', title: 'Soft Focus', artist: 'Denny Osei', duration: 240, energy: 0.20, valence: 0.50, tempo: 74, danceability: 0.28, acousticness: 0.65 },
  { id: 't06', title: 'Grey Morning Blue Sky', artist: 'Alta Vista', duration: 222, energy: 0.32, valence: 0.68, tempo: 92, danceability: 0.40, acousticness: 0.46 },
  { id: 't07', title: 'Halfway Home', artist: 'Rosalind Pace', duration: 210, energy: 0.25, valence: 0.58, tempo: 80, danceability: 0.33, acousticness: 0.55 },
  { id: 't08', title: 'Quiet Company', artist: 'Nora Vale', duration: 236, energy: 0.12, valence: 0.44, tempo: 66, danceability: 0.22, acousticness: 0.76 },
  { id: 't09', title: 'Warm Static', artist: 'The Long Exhale', duration: 219, energy: 0.30, valence: 0.65, tempo: 90, danceability: 0.37, acousticness: 0.48 },
  { id: 't10', title: 'Sunday Traffic', artist: 'Callum & the Quiet', duration: 227, energy: 0.19, valence: 0.52, tempo: 76, danceability: 0.29, acousticness: 0.60 },

  // Singalong — film/soundtrack + Taylor Swift energy: high valence, produced-pop danceability, modest acousticness.
  { id: 't11', title: 'Windows Down Forever', artist: 'Jubilee Road', duration: 201, energy: 0.62, valence: 0.88, tempo: 118, danceability: 0.58, acousticness: 0.16 },
  { id: 't12', title: 'Say It Louder', artist: 'Frankie & the Faults', duration: 189, energy: 0.58, valence: 0.92, tempo: 122, danceability: 0.55, acousticness: 0.14 },
  { id: 't13', title: 'Every Word', artist: 'Coastal Static', duration: 215, energy: 0.66, valence: 0.85, tempo: 126, danceability: 0.60, acousticness: 0.12 },
  { id: 't14', title: 'Backseat Choir', artist: 'Jubilee Road', duration: 208, energy: 0.54, valence: 0.90, tempo: 114, danceability: 0.52, acousticness: 0.22 },
  { id: 't15', title: 'One More Time Through', artist: 'The Reruns', duration: 197, energy: 0.60, valence: 0.94, tempo: 124, danceability: 0.57, acousticness: 0.15 },
  { id: 't16', title: 'Best Song On The Radio', artist: 'Frankie & the Faults', duration: 203, energy: 0.70, valence: 0.96, tempo: 128, danceability: 0.64, acousticness: 0.10 },
  { id: 't17', title: 'Sing It Wrong', artist: 'Marlowe Dune', duration: 192, energy: 0.52, valence: 0.80, tempo: 112, danceability: 0.50, acousticness: 0.25 },
  { id: 't18', title: 'Yellow Light Sprint', artist: 'Coastal Static', duration: 210, energy: 0.68, valence: 0.87, tempo: 130, danceability: 0.62, acousticness: 0.11 },
  { id: 't19', title: 'Chorus Only', artist: 'The Reruns', duration: 199, energy: 0.56, valence: 0.91, tempo: 116, danceability: 0.54, acousticness: 0.18 },
  { id: 't20', title: 'Turn It Up Please', artist: 'Marlowe Dune', duration: 206, energy: 0.64, valence: 0.83, tempo: 120, danceability: 0.59, acousticness: 0.13 },

  // Pumped Up — club music + hard rap: very high danceability, near-zero acousticness.
  { id: 't21', title: 'Redline', artist: 'VOLT', duration: 178, energy: 0.92, valence: 0.70, tempo: 148, danceability: 0.80, acousticness: 0.02 },
  { id: 't22', title: 'Ignition', artist: 'Cass Dagger', duration: 184, energy: 0.88, valence: 0.62, tempo: 142, danceability: 0.76, acousticness: 0.03 },
  { id: 't23', title: 'Full Send', artist: 'VOLT', duration: 172, energy: 0.96, valence: 0.55, tempo: 154, danceability: 0.84, acousticness: 0.01 },
  { id: 't24', title: 'Green Light Go', artist: 'Harlow Steel', duration: 190, energy: 0.85, valence: 0.75, tempo: 138, danceability: 0.72, acousticness: 0.05 },
  { id: 't25', title: 'Overdrive', artist: 'Cass Dagger', duration: 181, energy: 0.94, valence: 0.58, tempo: 150, danceability: 0.82, acousticness: 0.02 },
  { id: 't26', title: 'No Brakes', artist: 'Renn & the Rockets', duration: 176, energy: 0.90, valence: 0.68, tempo: 145, danceability: 0.78, acousticness: 0.03 },
  { id: 't27', title: 'Floor It', artist: 'Harlow Steel', duration: 187, energy: 0.82, valence: 0.72, tempo: 136, danceability: 0.70, acousticness: 0.06 },
  { id: 't28', title: 'Adrenaline Lane', artist: 'VOLT', duration: 179, energy: 0.98, valence: 0.60, tempo: 158, danceability: 0.85, acousticness: 0.01 },
  { id: 't29', title: 'Wide Open Throttle', artist: 'Renn & the Rockets', duration: 183, energy: 0.87, valence: 0.65, tempo: 140, danceability: 0.75, acousticness: 0.04 },
  { id: 't30', title: 'Last Exit', artist: 'Cass Dagger', duration: 195, energy: 0.80, valence: 0.78, tempo: 134, danceability: 0.68, acousticness: 0.07 },

  // Sad Gangster — emo rap: LOW valence but still groove (mid-high danceability), deliberately low acousticness (808s, not acoustic ballads).
  { id: 't31', title: 'Empty Passenger Seat', artist: 'Kilo Season', duration: 224, energy: 0.42, valence: 0.14, tempo: 72, danceability: 0.58, acousticness: 0.14 },
  { id: 't32', title: 'Chrome and Regret', artist: 'Novaine', duration: 231, energy: 0.48, valence: 0.20, tempo: 80, danceability: 0.62, acousticness: 0.11 },
  { id: 't33', title: 'Nobody Called Back', artist: 'Kilo Season', duration: 217, energy: 0.38, valence: 0.10, tempo: 68, danceability: 0.54, acousticness: 0.17 },
  { id: 't34', title: '3am Odometer', artist: 'Dro Ellison', duration: 240, energy: 0.55, valence: 0.24, tempo: 86, danceability: 0.66, acousticness: 0.09 },
  { id: 't35', title: 'Trap Door Heart', artist: 'Novaine', duration: 222, energy: 0.45, valence: 0.18, tempo: 76, danceability: 0.60, acousticness: 0.13 },
  { id: 't36', title: 'Cold Contract', artist: 'Sable Reyes', duration: 208, energy: 0.60, valence: 0.28, tempo: 92, danceability: 0.70, acousticness: 0.07 },
  { id: 't37', title: 'Main Character, No Crew', artist: 'Dro Ellison', duration: 229, energy: 0.35, valence: 0.08, tempo: 64, danceability: 0.50, acousticness: 0.19 },
  { id: 't38', title: 'Loyal To Nothing', artist: 'Sable Reyes', duration: 215, energy: 0.52, valence: 0.22, tempo: 84, danceability: 0.64, acousticness: 0.10 },
  { id: 't39', title: 'Tinted Windows', artist: 'Kilo Season', duration: 226, energy: 0.40, valence: 0.12, tempo: 70, danceability: 0.56, acousticness: 0.15 },
  { id: 't40', title: 'Last Text Unread', artist: 'Novaine', duration: 233, energy: 0.58, valence: 0.30, tempo: 90, danceability: 0.68, acousticness: 0.08 },
];

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deterministic-ish pseudo-random pick, no seeded RNG needed for mock data. */
function pickRandom(arr, n) {
  const pool = [...arr];
  const out = [];
  while (out.length < n && pool.length) {
    const i = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

export class LocalBackend {
  constructor() {
    this.name = 'local';
  }

  async getLibrary() {
    await delay(80);
    return clone(LIBRARY);
  }

  async searchTracks(query) {
    await delay(60);
    const q = (query || '').trim().toLowerCase();
    if (!q) return [];
    return clone(
      LIBRARY.filter(
        (t) => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q)
      )
    );
  }

  async getRecentlyPlayed(limit = 20) {
    await delay(80);
    const sample = pickRandom(LIBRARY, Math.min(limit, LIBRARY.length));
    const now = Date.now();
    return sample.map((track, i) => {
      const fullPlay = Math.random() > 0.3; // mostly plays, occasional mock skip
      const msPlayed = fullPlay
        ? track.duration * 1000
        : Math.round(track.duration * 1000 * (0.15 + Math.random() * 0.4));
      return {
        trackId: track.id,
        playedAt: new Date(now - i * 1000 * 60 * 12).toISOString(),
        msPlayed,
        track: clone(track),
      };
    });
  }

  async stockQueue(trackIds) {
    await delay(120);
    const byId = new Map(LIBRARY.map((t) => [t.id, t]));
    const tracks = trackIds.map((id) => clone(byId.get(id))).filter(Boolean);
    return {
      ok: true,
      queuedAt: new Date().toISOString(),
      tracks,
    };
  }

  async getAudioFeatures(trackIds) {
    await delay(50);
    const byId = new Map(LIBRARY.map((t) => [t.id, t]));
    const out = {};
    for (const id of trackIds) {
      const t = byId.get(id);
      if (!t) continue;
      out[id] = {
        energy: t.energy,
        valence: t.valence,
        tempo: t.tempo,
        danceability: t.danceability,
        acousticness: t.acousticness,
      };
    }
    return out;
  }
}
