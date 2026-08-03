/* 验证分城市偏差修正对严重偏离市场(误差>3°)的效果
 *
 * 对 absErr>3° 的市场, 对比修正前后:
 *  1. 预测温度和误差 (能拉回多少)
 *  2. bias 原始值 vs 有效值 (cap 截断了吗)
 *  3. 桶概率分布 top5 (分布重心怎么移动)
 *  4. top1 桶和命中变化
 *
 * 关键: BIAS_MAX_C=2.0 (F城市×1.8=3.6) 会截断大偏差, 看 cap 是否限制救回效果。
 * Run: npx tsx scripts/verify-bias-fix.ts
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { bucketProb, inBucket } from "../src/math.js";
import { loadBiasTable, biasKey } from "../src/bias.js";
import { BIAS_MIN_N, BIAS_SHRINK_N, BIAS_MAX_C } from "../src/config.js";

const DIR = path.join(process.cwd(), "data", "markets");

interface Outcome {
  range: [number, number];
}
interface Pos {
  forecast_temp?: number | null;
  sigma?: number | null;
  forecast_src?: string | null;
  opened_at?: string;
}
interface Mkt {
  city: string;
  city_name: string;
  date: string;
  unit: "F" | "C";
  actual_temp: number | null;
  position: Pos | null;
  positions?: Pos[];
  all_outcomes: Outcome[];
  forecast_snapshots?: Array<{ best?: number | null; horizon?: string | null }>;
}

function getForecast(m: Mkt): { fc: number; sigma: number; src: string } | null {
  const pos = m.positions?.[0] ?? m.position;
  if (pos?.forecast_temp != null && pos?.sigma != null) {
    return { fc: pos.forecast_temp, sigma: pos.sigma, src: pos.forecast_src ?? "best" };
  }
  const snap = m.forecast_snapshots?.find((s) => s.best != null);
  if (snap?.best != null) return { fc: snap.best, sigma: m.unit === "C" ? 2.3 : 1.7, src: "best" };
  return null;
}

function getHorizon(m: Mkt): string {
  const snap = m.forecast_snapshots?.find((s) => s.horizon != null);
  if (snap?.horizon) return snap.horizon;
  const pos = m.positions?.[0] ?? m.position;
  if (pos?.opened_at) {
    const d0 = Date.parse(m.date + "T00:00:00Z");
    const d1 = Date.parse(pos.opened_at.slice(0, 10) + "T00:00:00Z");
    const days = Math.round((d0 - d1) / 86400000);
    return `D+${Math.max(0, days)}`;
  }
  return "D+0";
}

/** 有效 bias (复制 getBias 逻辑, 不受 BIAS_ENABLED gate)。
 *  bias = mean(forecast - actual), 修正 = fc - bias (拉向 actual)。 */
function effectiveBias(
  city: string,
  horizon: string,
  source: string,
  unit: "F" | "C",
): { raw: number; effective: number; n: number; capped: boolean } {
  const src = source === "ensemble" ? "best" : source ?? "best";
  const entry = loadBiasTable()[biasKey(city, horizon, src)];
  if (!entry) return { raw: 0, effective: 0, n: 0, capped: false };
  if (entry.n < BIAS_MIN_N) return { raw: entry.bias, effective: 0, n: entry.n, capped: false };
  const shrink = Math.min(1, entry.n / BIAS_SHRINK_N);
  const cap = unit === "F" ? BIAS_MAX_C * 1.8 : BIAS_MAX_C;
  const capped = Math.max(-cap, Math.min(cap, entry.bias));
  return {
    raw: entry.bias,
    effective: Math.round(capped * shrink * 1000) / 1000,
    n: entry.n,
    capped: Math.abs(entry.bias) > cap,
  };
}

function fmtBucket(r: [number, number]): string {
  if (r[0] === -999) return `≤${r[1]}`;
  if (r[1] === 999) return `≥${r[0]}`;
  return `${r[0]}-${r[1]}`;
}

const markets = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => {
    try {
      return JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as Mkt;
    } catch {
      return null;
    }
  })
  .filter((m): m is Mkt => m != null);

// 筛选 absErr > 3 的严重偏离市场
const severe: Mkt[] = [];
for (const m of markets) {
  if (m.actual_temp == null) continue;
  const fs = getForecast(m);
  if (!fs) continue;
  if (Math.abs(fs.fc - m.actual_temp) > 3) severe.push(m);
}

console.log(`===== 分城市偏差修正验证 (误差>3°的严重偏离市场) =====`);
console.log(`严重偏离市场数: ${severe.length}\n`);

let beforeHits = 0;
let afterHits = 0;
let totalImprove = 0;

for (const m of severe) {
  const fs = getForecast(m)!;
  const actual = m.actual_temp!;
  const horizon = getHorizon(m);
  const { raw, effective, n, capped } = effectiveBias(m.city, horizon, fs.src, m.unit);
  // 修正: fc - bias (和修复后的 applyBias 一致)
  const adjFc = Math.round((fs.fc - effective) * 100) / 100;
  const errBefore = fs.fc - actual;
  const errAfter = adjFc - actual;
  totalImprove += Math.abs(errBefore) - Math.abs(errAfter);

  // 桶分布
  const buckets = (m.all_outcomes ?? []).map((o) => {
    const pBefore = bucketProb(fs.fc, o.range[0], o.range[1], fs.sigma);
    const pAfter = bucketProb(adjFc, o.range[0], o.range[1], fs.sigma);
    const isActual = inBucket(actual, o.range[0], o.range[1]);
    return { range: o.range, pBefore, pAfter, isActual };
  });

  const topBefore = [...buckets].sort((a, b) => b.pBefore - a.pBefore)[0];
  const topAfter = [...buckets].sort((a, b) => b.pAfter - a.pAfter)[0];
  const hitBefore = topBefore?.isActual ?? false;
  const hitAfter = topAfter?.isActual ?? false;
  if (hitBefore) beforeHits++;
  if (hitAfter) afterHits++;

  const capVal = m.unit === "F" ? BIAS_MAX_C * 1.8 : BIAS_MAX_C;
  const actualBucket = buckets.find((b) => b.isActual);

  console.log(`${"─".repeat(72)}`);
  console.log(`${m.city_name} ${m.date} (${horizon}, ${m.unit}, bias n=${n})`);
  console.log(
    `  预测: ${fs.fc.toFixed(1)}${m.unit} → 修正后 ${adjFc.toFixed(1)}${m.unit} | 实际 ${actual.toFixed(1)}${m.unit}`,
  );
  console.log(
    `  误差: ${errBefore >= 0 ? "+" : ""}${errBefore.toFixed(1)}° → ${errAfter >= 0 ? "+" : ""}${errAfter.toFixed(1)}° (改善 ${(Math.abs(errBefore) - Math.abs(errAfter)).toFixed(1)}°)`,
  );
  console.log(
    `  bias: 原始 ${raw >= 0 ? "+" : ""}${raw.toFixed(2)}° → 有效 ${effective >= 0 ? "+" : ""}${effective.toFixed(2)}° (cap ${capVal.toFixed(1)}°)${capped ? " ⚠被cap截断" : ""}`,
  );
  console.log(
    `  top1桶: ${topBefore ? fmtBucket(topBefore.range) : "?"} (p ${(topBefore!.pBefore * 100).toFixed(0)}%) → ${topAfter ? fmtBucket(topAfter.range) : "?"} (p ${(topAfter!.pAfter * 100).toFixed(0)}%) | 实际桶 ${actualBucket ? fmtBucket(actualBucket.range) : "?"}`,
  );
  let verdict = `${hitBefore ? "✓" : "✗"} → ${hitAfter ? "✓" : "✗"}`;
  if (hitAfter && !hitBefore) verdict += " 🎯修正救回";
  else if (!hitAfter && hitBefore) verdict += " ⚠修正弄丢";
  else if (!hitAfter && Math.abs(errAfter) <= 1) verdict += " (误差已≤1°, 桶宽内未命中)";
  console.log(`  命中: ${verdict}`);

  // 桶分布 top 5 (按修正后 p)
  const top5 = [...buckets].sort((a, b) => b.pAfter - a.pAfter).slice(0, 5);
  console.log(`  桶分布 (top5 by 修正后p):`);
  console.log(`    ${"桶".padEnd(8)} | ${"原始p".padStart(6)} | ${"修正p".padStart(6)} | 变化`);
  for (const b of top5) {
    const delta = b.pAfter - b.pBefore;
    const arrow = delta > 0.01 ? "↑" : delta < -0.01 ? "↓" : " ";
    const mark = b.isActual ? " ←实际" : "";
    console.log(
      `    ${fmtBucket(b.range).padEnd(8)} | ${(b.pBefore * 100).toFixed(0).padStart(5)}% | ${(b.pAfter * 100).toFixed(0).padStart(5)}% | ${arrow} ${mark}`,
    );
  }
  console.log();
}

console.log(`${"═".repeat(72)}`);
console.log(`汇总:`);
console.log(`  修正前命中 ${beforeHits}/${severe.length} → 修正后命中 ${afterHits}/${severe.length} (救回 ${afterHits - beforeHits} 个)`);
console.log(`  平均误差改善: ${(totalImprove / severe.length).toFixed(2)}° (从 ${(severe.map(m => Math.abs(getForecast(m)!.fc - m.actual_temp!)).reduce((a, b) => a + b, 0) / severe.length).toFixed(2)}° 降到 ${((severe.map(m => Math.abs(getForecast(m)!.fc - m.actual_temp!)).reduce((a, b) => a + b, 0) - totalImprove) / severe.length).toFixed(2)}°)`);
const cappedCount = severe.filter(m => {
  const fs = getForecast(m)!;
  const h = getHorizon(m);
  return effectiveBias(m.city, h, fs.src, m.unit).capped;
}).length;
console.log(`  被 cap 截断的市场: ${cappedCount}/${severe.length} (BIAS_MAX_C=${BIAS_MAX_C}° 限制了修正幅度)`);
if (cappedCount > 0) {
  console.log(`  ⚠ ${cappedCount} 个市场偏差超过 cap, 修正不能完全到位。考虑提高 BIAS_MAX_C 或接受部分修正。`);
}
