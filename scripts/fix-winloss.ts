/* One-shot migration (2026-08-03): recompute state.wins/losses from the true
 * settlement source (actual_temp in each market file). The old resolved-branch
 * only counted positions still OPEN at resolution time, so state showed 0 wins
 * while the true hit rate was ~11% (4/35). This recounts ALL positions that have
 * an actual_temp, judged by inBucket(actual, low, high).
 *
 * Idempotent: resets wins/losses to the true count on every run.
 * Only writes state.json — does NOT touch market files (avoids git conflicts
 * with the Actions collector). Run: npx tsx scripts/fix-winloss.ts
 */
import { loadAllMarkets, loadState, saveState } from "../src/storage.js";
import { inBucket } from "../src/math.js";

const state = loadState();
const markets = loadAllMarkets();

let wins = 0;
let losses = 0;
let counted = 0;

for (const mkt of markets) {
  if (mkt.actual_temp == null) continue;
  const positions = mkt.positions ?? (mkt.position ? [mkt.position] : []);
  for (const p of positions) {
    if (p.bucket_low == null || p.bucket_high == null) continue;
    if (inBucket(mkt.actual_temp, p.bucket_low, p.bucket_high)) wins += 1;
    else losses += 1;
    counted += 1;
  }
}

const before = { w: state.wins, l: state.losses };
state.wins = wins;
state.losses = losses;
saveState(state);

const total = wins + losses;
console.log(
  `Recounted ${counted} settled positions -> W ${wins} / L ${losses}` +
    ` (hit rate ${total ? ((wins / total) * 100).toFixed(1) : 0}%)`,
);
console.log(`state.json wins/losses: ${before.w}/${before.l} -> ${wins}/${losses} (balance $${state.balance.toFixed(2)} unchanged).`);
