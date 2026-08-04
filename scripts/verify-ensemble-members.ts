/**
 * 快速验证集成成员频次概率 (A 优化) 是否正常工作。
 * 测试: 1) getEnsembleMembersForecast 拉取 ECMWF ENS 51 成员
 *       2) bucketProbEnsemble 计算桶概率
 *       3) 与正态 CDF bucketProb 对比
 */
import { LOCATIONS } from "../src/config.js";
import { getEnsembleMembersForecast } from "../src/forecasts.js";
import { bucketProb, bucketProbEnsemble } from "../src/math.js";

async function main() {
  const citySlug = "nyc";
  const loc = LOCATIONS[citySlug]!;
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const dates = new Set([today, tomorrow.toISOString().slice(0, 10)]);

  console.log(`[VERIFY] Testing ensemble members for ${loc.name} (${loc.station})`);
  console.log(`[VERIFY] Dates: ${Array.from(dates).join(", ")}`);

  const membersByDate = await getEnsembleMembersForecast(citySlug, dates, loc);

  for (const [date, members] of Object.entries(membersByDate)) {
    console.log(`\n[VERIFY] ${date}: ${members.length} members`);
    if (members.length === 0) {
      console.log("  no members — API may have failed");
      continue;
    }

    const sorted = [...members].sort((a, b) => a - b);
    const min = sorted[0]!;
    const max = sorted[sorted.length - 1]!;
    const mean = members.reduce((a, b) => a + b, 0) / members.length;
    console.log(`  range: ${min}–${max}${loc.unit}, mean: ${mean.toFixed(1)}${loc.unit}`);
    console.log(`  p10: ${sorted[Math.floor(members.length * 0.1)]!.toFixed(1)}, p50: ${sorted[Math.floor(members.length * 0.5)]!.toFixed(1)}, p90: ${sorted[Math.floor(members.length * 0.9)]!.toFixed(1)}`);

    // 测试一个典型桶 (mean 附近 ±1°)
    const bucketLow = Math.round(mean);
    const bucketHigh = bucketLow + 1;
    const pEns = bucketProbEnsemble(members, bucketLow, bucketHigh);
    const pNorm = bucketProb(mean, bucketLow, bucketHigh, 2.0);
    console.log(`  bucket ${bucketLow}-${bucketHigh}${loc.unit}: ensemble p=${pEns.toFixed(3)} vs normal p=${pNorm.toFixed(3)} (sigma=2.0)`);

    // 测试一个尾部桶 (max 附近)
    const tailLow = Math.round(max) - 1;
    const tailHigh = Math.round(max);
    const pTailEns = bucketProbEnsemble(members, tailLow, tailHigh);
    const pTailNorm = bucketProb(mean, tailLow, tailHigh, 2.0);
    console.log(`  tail bucket ${tailLow}-${tailHigh}${loc.unit}: ensemble p=${pTailEns.toFixed(3)} vs normal p=${pTailNorm.toFixed(3)}`);
  }

  console.log("\n[VERIFY] Done.");
}

main().catch((e) => {
  console.error("[VERIFY] FAILED:", e);
  process.exit(1);
});
