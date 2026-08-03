/* 预测准确度检查: 模型预测温度 vs 真实结算温度
 *
 * 看 model 本身准不准 (不是策略回测):
 *  1. 逐市场: 预测温度 / 实际温度 / 误差 / 预测桶 / 实际桶 / 是否命中
 *  2. 温度误差统计: MAE, bias, 误差分组分布
 *  3. 桶命中率 + 命中/未命中的误差对比
 *
 * 桶命中定义: 按 bucketProb 选 p 最大的桶 (即模型最看好的桶), 看 actual 是否落该桶。
 * 这和 backtest-strategy.ts 的"无修正"策略一致, 可交叉验证 (应 = 18.3%)。
 *
 * Run: npx tsx scripts/check-accuracy.ts
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { bucketProb, inBucket } from "../src/math.js";

const DIR = path.join(process.cwd(), "data", "markets");

interface Outcome {
  range: [number, number];
}
interface Pos {
  forecast_temp?: number | null;
  sigma?: number | null;
}
interface Mkt {
  city_name: string;
  date: string;
  unit: "F" | "C";
  actual_temp: number | null;
  position: Pos | null;
  positions?: Pos[];
  all_outcomes: Outcome[];
  forecast_snapshots?: Array<{ best?: number | null }>;
}

/** 取预测温度 + sigma。优先用 position 记录的开仓时预测, 否则用 snapshot best。 */
function getForecast(m: Mkt): { fc: number; sigma: number } | null {
  const pos = m.positions?.[0] ?? m.position;
  if (pos?.forecast_temp != null && pos?.sigma != null) {
    return { fc: pos.forecast_temp, sigma: pos.sigma };
  }
  const best = m.forecast_snapshots?.find((s) => s.best != null)?.best;
  if (best != null) return { fc: best, sigma: m.unit === "C" ? 2.3 : 1.7 };
  return null;
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

const resolved = markets.filter((m) => m.actual_temp != null && getForecast(m) != null);

console.log(`===== 预测准确度检查 =====`);
console.log(`已结算 + 有预测的市场: ${resolved.length}\n`);

/* 逐市场分析 */
interface Row {
  city: string;
  date: string;
  unit: string;
  fc: number;
  actual: number;
  err: number;
  absErr: number;
  topBucket: string;
  actualBucket: string;
  hit: boolean;
}
const rows: Row[] = [];
for (const m of resolved) {
  const fs = getForecast(m)!;
  const actual = m.actual_temp!;
  const err = fs.fc - actual;
  // 按 p 选 top1 桶 (模型最看好)
  const cands = (m.all_outcomes ?? [])
    .map((o) => ({ range: o.range, p: bucketProb(fs.fc, o.range[0], o.range[1], fs.sigma) }))
    .sort((a, b) => b.p - a.p);
  const top = cands[0];
  const hit = top ? inBucket(actual, top.range[0], top.range[1]) : false;
  // actual 实际落在哪个桶
  const actualBucket = (m.all_outcomes ?? []).find((o) => inBucket(actual, o.range[0], o.range[1]));
  rows.push({
    city: m.city_name,
    date: m.date,
    unit: m.unit,
    fc: fs.fc,
    actual,
    err,
    absErr: Math.abs(err),
    topBucket: top ? fmtBucket(top.range) : "?",
    actualBucket: actualBucket ? fmtBucket(actualBucket.range) : "?",
    hit,
  });
}

/* 桶命中率 */
const hits = rows.filter((r) => r.hit).length;
console.log(`桶命中 (按预测 p 选 top1): ${hits} / ${rows.length} = ${(hits / rows.length * 100).toFixed(1)}%`);

/* 温度误差统计 */
const errs = rows.map((r) => r.err);
const absErrs = rows.map((r) => r.absErr);
const mae = absErrs.reduce((a, b) => a + b, 0) / absErrs.length;
const bias = errs.reduce((a, b) => a + b, 0) / errs.length;
console.log(`\n温度误差统计:`);
console.log(`  MAE  (平均绝对误差): ${mae.toFixed(2)}°`);
console.log(`  bias (预测-实际均值): ${bias >= 0 ? "+" : ""}${bias.toFixed(2)}° (${bias > 0 ? "预测偏高" : bias < 0 ? "预测偏低" : "无偏"})`);

/* 误差分组 */
const groups: Record<string, number> = { "≤1°C": 0, "1~2°C": 0, "2~3°C": 0, ">3°C": 0 };
for (const r of rows) {
  if (r.absErr <= 1) groups["≤1°C"]!++;
  else if (r.absErr <= 2) groups["1~2°C"]!++;
  else if (r.absErr <= 3) groups["2~3°C"]!++;
  else groups[">3°C"]!++;
}
console.log(`\n误差分布:`);
for (const [g, n] of Object.entries(groups)) {
  const bar = "█".repeat(Math.round((n / rows.length) * 20));
  console.log(`  ${g.padEnd(7)} ${String(n).padStart(2)} 个 (${(n / rows.length * 100).toFixed(0).padStart(2)}%) ${bar}`);
}

/* 命中 vs 未命中对比 */
const hitErrs = rows.filter((r) => r.hit).map((r) => r.absErr);
const missErrs = rows.filter((r) => !r.hit).map((r) => r.absErr);
console.log(`\n命中 vs 未命中的误差对比:`);
console.log(`  命中 ${hitErrs.length} 个: 平均绝对误差 ${hitErrs.length ? (hitErrs.reduce((a, b) => a + b, 0) / hitErrs.length).toFixed(2) : "-"}°`);
console.log(`  未命中 ${missErrs.length} 个: 平均绝对误差 ${missErrs.length ? (missErrs.reduce((a, b) => a + b, 0) / missErrs.length).toFixed(2) : "-"}°`);

/* 逐市场明细 (按绝对误差从大到小) */
console.log(`\n逐市场明细 (按绝对误差从大到小):`);
console.log(`  城市             | 日期       |  预测  |  实际  |  误差  | 预测桶   | 实际桶   | 命中`);
console.log(`  ${"-".repeat(78)}`);
for (const r of rows.sort((a, b) => b.absErr - a.absErr)) {
  const errStr = `${r.err >= 0 ? "+" : ""}${r.err.toFixed(1)}`.padStart(5);
  console.log(
    `  ${r.city.padEnd(16)} | ${r.date} | ${r.fc.toFixed(1).padStart(4)}${r.unit} | ${r.actual.toFixed(1).padStart(4)}${r.unit} | ${errStr}${r.unit} | ${r.topBucket.padEnd(8)} | ${r.actualBucket.padEnd(8)} | ${r.hit ? "✓" : "✗"}`,
  );
}

/* 总结 */
console.log(`\n${"=".repeat(78)}`);
console.log(`总结:`);
console.log(`  ${rows.length} 个已结算市场, 桶命中率 ${(hits / rows.length * 100).toFixed(1)}% (${hits}/${rows.length})`);
console.log(`  平均绝对误差 ${mae.toFixed(2)}°, 整体${bias > 0.2 ? "预测偏高" : bias < -0.2 ? "预测偏低" : "接近无偏"} (${bias >= 0 ? "+" : ""}${bias.toFixed(2)}°)`);
console.log(`  误差 ≤1°C 的市场: ${groups["≤1°C"]} 个 (${(groups["≤1°C"]! / rows.length * 100).toFixed(0)}%) — 这些是预测准的`);
console.log(`  误差 >3°C 的市场: ${groups[">3°C"]} 个 (${(groups[">3°C"]! / rows.length * 100).toFixed(0)}%) — 这些是预测严重偏离的`);
