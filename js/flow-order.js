// Shotgun — flow ordering
//
// TODO (session 3): replace this with the real algorithm. It should weigh
// energy + valence + tempo together (not just energy), avoid stacking two
// songs from the same artist back to back, and taste-weight candidates once
// Supabase scores exist. Keep the call seam below stable — app.js only ever
// calls `orderForFlow(tracks, seed)` and expects an array back in the same
// shape it received, just reordered.

/**
 * Trivial placeholder ordering: greedy nearest-neighbour walk by energy
 * distance from a seed value, so consecutive songs never jump too hard in
 * intensity. Good enough to prove the seam works; not a real flow algorithm.
 *
 * @param {Array<{id:string, energy:number}>} tracks
 * @param {{energy:number}|null} seed - anchor point; defaults to the
 *   average energy of `tracks` when omitted (e.g. mood-button picks with no
 *   single seed song).
 * @returns {Array} the same track objects, reordered
 */
export function orderForFlow(tracks, seed = null) {
  if (!Array.isArray(tracks) || tracks.length <= 1) return [...tracks];

  const pool = [...tracks];
  const anchorEnergy = seed && typeof seed.energy === 'number'
    ? seed.energy
    : average(pool.map((t) => t.energy));

  const ordered = [];
  let cursor = anchorEnergy;

  while (pool.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const dist = Math.abs(pool[i].energy - cursor);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    const [next] = pool.splice(bestIdx, 1);
    ordered.push(next);
    cursor = next.energy;
  }

  return ordered;
}

function average(nums) {
  if (!nums.length) return 0.5;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
