/* 综合回测: 分城市偏差分析 + 新选桶策略(p排序+偏差修正) vs 旧策略(edge排序)
 *
 * 三部分:
 *  1. 分城市偏差分析: 每城市 (forecast - actual) 的均值/MAE, 找出系统性偏差
 *  2. 偏差修正命中率对比: 无修正 vs 全局+0.4°C vs 分城市修正
 *  3. 新策略盈亏估算: 分城市修正 + 按 p 选 top1, 假设 entry 估算盈亏, 对比旧策略
 *
 * 数据限制: all_outcomes 价格是结算后极端值, 不能用于 entry 估算。
 *  - 命中率: 不需要价格, 用 forecast 算 p, 按 p 选桶, 用 actual 判定 (准确)
 *  - 盈亏:   旧策略用真实 entry_price; 新策略用假设 entry (参考旧策略平均 entry)
 *
 * 偏差方向约定: bias = forecast - actual
 *  - bias > 0: 预测偏高, 修正 = fc - bias (下调)
 *  - bias < 0: 预测偏低 (actual 偏高), 修正 = fc - bias = fc + |bias| (上调)
 *
 * Run: npx tsx scripts/backtest-strategy.ts
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { bucketProb, inBucket } from "../src/math.js";

const DIR = path.join(process.cwd(), "data", "markets");
const COST = 20;
const BASE_SIGMA_C = 2.3;
const BASE_SIGMA_F = 1.7;
const GLOBAL_BIAS_CORRECTION = 0.4; // project_memory 里待验证的 +0.4°C

interface Outcome {
  range: [number, number];
}
interface Pos {
  bucket_low: number;
  bucket_high: number;
  entry_price: number;
  pnl: number | null;
  forecast_temp?: number | null;
  sigma?: number | null;
  status: string;
  close_reason: string | null;
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
  forecast_snapshots?: Array<{ best?: number | null; ecmwf?: number | null }>;
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

/** 取市场的预测温度和 sigma。优先用 position 记录的, 没有则用 snapshot 的 best。 */
function getForecastSigma(m: Mkt): { fc: number; sigma: number } | null {
  const pos = m.positions?.[0] ?? m.position;
  if (pos && pos.forecast_temp != null && pos.sigma != null) {
    return { fc: pos.forecast_temp, sigma: pos.sigma };
  }
  const best = m.forecast_snapshots?.find((s) => s.best != null)?.best;
  if (best != null) {
    return { fc: best, sigma: m.unit === "C" ? BASE_SIGMA_C : BASE_SIGMA_F };
  }
  return null;
}

// 只用有 actual_temp 且能取到 forecast 的市场
const resolved = markets.filter((m) => {
  if (m.actual_temp == null) return false;
  return getForecastSigma(m) != null;
});

console.log(`===== 数据 =====`);
console.log(`总 market 文件: ${markets.length}`);
console.log(`已结算 + 有 forecast: ${resolved.length}`);

/* ================================================================== */
/* 1. 分城市偏差分析                                                   */
/* ================================================================== */
console.log(`\n${"=".repeat(70)}`);
console.log("  1. 分城市偏差分析 (bias = forecast - actual)");
console.log(`${"=".repeat(70)}`);
console.log(
  `  bias > 0 = 预测偏高(需下调) | bias < 0 = 预测偏低(需上调, 即 actual 偏高)`,
);

interface CityStat {
  city: string;
  unit: string;
  n: number;
  bias: number; // mean signed error
  mae: number;
  samples: { date: string; fc: number; actual: number; err: number }[];
}
const cityStats: CityStat[] = [];
const globalErr: number[] = [];

for (const m of resolved) {
  const fs = getForecastSigma(m)!;
  const err = fs.fc - m.actual_temp!;
  globalErr.push(err);
}

const byCity = new Map<string, Mkt[]>();
for (const m of resolved) {
  const arr = byCity.get(m.city_name) ?? [];
  arr.push(m);
  byCity.set(m.city_name, arr);
}

for (const [city, arr] of [...byCity.entries()].sort()) {
  const errs = arr.map((m) => {
    const fs = getForecastSigma(m)!;
    return fs.fc - m.actual_temp!;
  });
  const bias = errs.reduce((a, b) => a + b, 0) / errs.length;
  const mae = errs.map(Math.abs).reduce((a, b) => a + b, 0) / errs.length;
  cityStats.push({
    city,
    unit: arr[0]!.unit,
    n: arr.length,
    bias: Math.round(bias * 100) / 100,
    mae: Math.round(mae * 100) / 100,
    samples: arr.map((m) => {
      const fs = getForecastSigma(m)!;
      return { date: m.date, fc: fs.fc, actual: m.actual_temp!, err: fs.fc - m.actual_temp! };
    }),
  });
}

console.log(`\n  城市             | 单位 | 样本 |  bias  |  MAE   | 偏向`);
console.log(`  ${"-".repeat(64)}`);
for (const c of cityStats.sort((a, b) => a.bias - b.bias)) {
  const dir = c.bias > 0.3 ? "预测偏高↓" : c.bias < -0.3 ? "预测偏低↑" : "接近准";
  console.log(
    `  ${c.city.padEnd(16)} |  ${c.unit}  |  ${c.n}   | ${c.bias >= 0 ? "+" : ""}${c.bias.toFixed(2).padStart(5)} | ${c.mae.toFixed(2).padStart(5)} | ${dir}`,
  );
}

const globalBias = globalErr.reduce((a, b) => a + b, 0) / globalErr.length;
const globalMae = globalErr.map(Math.abs).reduce((a, b) => a + b, 0) / globalErr.length;
console.log(`  ${"-".repeat(64)}`);
console.log(
  `  ${"全局".padEnd(16)} |      |  ${globalErr.length}  | ${globalBias >= 0 ? "+" : ""}${globalBias.toFixed(2).padStart(5)} | ${globalMae.toFixed(2).padStart(5)} |`,
);

// 偏差分组统计
const lowBias = cityStats.filter((c) => c.bias < -0.3);
const highBias = cityStats.filter((c) => c.bias > 0.3);
const neutral = cityStats.filter((c) => c.bias >= -0.3 && c.bias <= 0.3);
console.log(`\n  偏低城市(actual偏高, 需上调): ${lowBias.length} 个 — ${lowBias.map((c) => `${c.city}(${c.bias >= 0 ? "+" : ""}${c.bias.toFixed(1)})`).join(", ")}`);
console.log(`  偏高城市(actual偏低, 需下调): ${highBias.length} 个 — ${highBias.map((c) => `${c.city}(${c.bias >= 0 ? "+" : ""}${c.bias.toFixed(1)})`).join(", ")}`);
console.log(`  接近准确: ${neutral.length} 个`);

/* ================================================================== */
/* 2. 偏差修正命中率对比                                              */
/* ================================================================== */
console.log(`\n${"=".repeat(70)}`);
console.log("  2. 偏差修正命中率对比 (按 p 选 top1 桶)");
console.log(`${"=".repeat(70)}`);

interface HitResult {
  label: string;
  n: number;
  hits: number;
  rate: number;
}
function evalStrategy(label: string, adjFcFn: (m: Mkt, fs: { fc: number; sigma: number }) => number): HitResult {
  let hits = 0;
  let n = 0;
  for (const m of resolved) {
    const fs = getForecastSigma(m)!;
    const adjFc = adjFcFn(m, fs);
    const cands = (m.all_outcomes ?? [])
      .map((o) => ({
        range: o.range,
        p: bucketProb(adjFc, o.range[0], o.range[1], fs.sigma),
      }))
      .sort((a, b) => b.p - a.p);
    const top = cands[0];
    if (!top) continue;
    n += 1;
    if (inBucket(m.actual_temp!, top.range[0], top.range[1])) hits += 1;
  }
  const rate = n ? hits / n : 0;
  console.log(`  ${label.padEnd(28)}: ${hits} / ${n}  (${(rate * 100).toFixed(1)}%)`);
  return { label, n, hits, rate };
}

const r1 = evalStrategy("无修正", (_m, fs) => fs.fc);
const r2 = evalStrategy(`全局 +${GLOBAL_BIAS_CORRECTION}°C`, (_m, fs) => fs.fc + GLOBAL_BIAS_CORRECTION);
// 分城市修正 (in-sample, 注: 会高估, 仅 3 样本/城市)
const cityBiasMap = new Map<string, number>();
for (const c of cityStats) cityBiasMap.set(c.city, c.bias);
const r3 = evalStrategy("分城市修正 (in-sample)", (m, fs) => fs.fc - (cityBiasMap.get(m.city_name) ?? 0));

// 分城市修正的 leave-one-out (更严谨, 但每城市仅3样本, 仅供参考)
function evalLOO(): HitResult {
  let hits = 0;
  let n = 0;
  for (const m of resolved) {
    const fs = getForecastSigma(m)!;
    // 用同城市其他样本算 bias
    const sameCity = resolved.filter((x) => x.city_name === m.city_name && x.date !== m.date);
    if (sameCity.length === 0) continue;
    const errs = sameCity.map((x) => getForecastSigma(x)!.fc - x.actual_temp!);
    const bias = errs.reduce((a, b) => a + b, 0) / errs.length;
    const adjFc = fs.fc - bias;
    const cands = (m.all_outcomes ?? [])
      .map((o) => ({ range: o.range, p: bucketProb(adjFc, o.range[0], o.range[1], fs.sigma) }))
      .sort((a, b) => b.p - a.p);
    const top = cands[0];
    if (!top) continue;
    n += 1;
    if (inBucket(m.actual_temp!, top.range[0], top.range[1])) hits += 1;
  }
  const rate = n ? hits / n : 0;
  console.log(`  ${"分城市修正 (leave-one-out)".padEnd(28)}: ${hits} / ${n}  (${(rate * 100).toFixed(1)}%)`);
  return { label: "loo", n, hits, rate };
}
const r4 = evalLOO();

console.log(`\n  解读:`);
console.log(`  - 无修正 ${(r1.rate * 100).toFixed(1)}% → 全局+0.4°C ${(r2.rate * 100).toFixed(1)}% (提升 ${((r2.rate - r1.rate) * 100).toFixed(1)}个百分点)`);
console.log(`  - 无修正 ${(r1.rate * 100).toFixed(1)}% → 分城市修正 ${(r3.rate * 100).toFixed(1)}% (in-sample, 提升 ${((r3.rate - r1.rate) * 100).toFixed(1)}个百分点)`);
console.log(`  - leave-one-out ${(r4.rate * 100).toFixed(1)}% 更接近真实泛化效果 (in-sample 会高估)`);

/* ================================================================== */
/* 3. 新策略盈亏估算 + 旧策略对比                                     */
/* ================================================================== */
console.log(`\n${"=".repeat(70)}`);
console.log("  3. 新策略盈亏估算 (按 p 选 top1, 假设 entry) vs 旧策略(实际 edge 买入)");
console.log(`${"=".repeat(70)}`);

// 旧策略: 实际买入的 position (edge 排序选出)
interface BPick {
  city: string;
  date: string;
  bucket: string;
  entry: number;
  hit: boolean;
  pnlRealized: number;
  pnlHold: number;
}
const bPicks: BPick[] = [];
for (const m of resolved) {
  const positions = m.positions ?? (m.position ? [m.position] : []);
  for (const p of positions) {
    if (p.bucket_low == null || p.bucket_high == null) continue;
    const hit = inBucket(m.actual_temp!, p.bucket_low, p.bucket_high);
    const pnlHold = hit ? Math.round(COST * (1 / p.entry_price - 1) * 100) / 100 : -COST;
    bPicks.push({
      city: m.city_name,
      date: m.date,
      bucket: `${p.bucket_low}-${p.bucket_high}`,
      entry: p.entry_price,
      hit,
      pnlRealized: p.pnl ?? 0,
      pnlHold,
    });
  }
}
const bHits = bPicks.filter((p) => p.hit).length;
const bRealized = bPicks.reduce((s, p) => s + p.pnlRealized, 0);
const bHold = bPicks.reduce((s, p) => s + p.pnlHold, 0);
const bAvgEntry = bPicks.length ? bPicks.reduce((s, p) => s + p.entry, 0) / bPicks.length : 0;

console.log(`\n  --- 旧策略 (edge 排序, 实际买入) ---`);
console.log(`  桶数: ${bPicks.length} | 命中: ${bHits} (${(bHits / bPicks.length * 100).toFixed(1)}%)`);
console.log(`  已实现 PnL: $${bRealized.toFixed(2)} (含止损/forecast_changed)`);
console.log(`  持有到结算 PnL: $${bHold.toFixed(2)}`);
console.log(`  平均 entry: $${bAvgEntry.toFixed(3)} (盈亏平衡点 ${(bAvgEntry * 100).toFixed(1)}%)`);

// 新策略: 分城市修正 + 按 p 选 top1, 用假设 entry 估算盈亏
// 选最优修正方案 (in-sample 分城市修正) 作为新策略代表
const newStratHits = r3.hits;
const newStratN = r3.n;
const newStratRate = r3.rate;

console.log(`\n  --- 新策略 (分城市修正 + 按 p 选 top1) ---`);
console.log(`  桶数: ${newStratN} | 命中: ${newStratHits} (${(newStratRate * 100).toFixed(1)}%)`);
console.log(`  (盈亏用假设 entry 估算, 因历史无开仓时价格)`);

// 假设 entry 盈亏: 用旧策略平均 entry 作为参考
console.log(`\n  假设 entry 盈亏 (持有到结算, 单桶成本 $${COST}):`);
console.log(`  ${"entry".padStart(8)} | ${"平衡点".padStart(8)} | ${"新策略PnL".padStart(12)} | ${"旧策略同entry".padStart(14)}`);
for (const entry of [0.10, 0.15, bAvgEntry, 0.20, 0.25, 0.30].filter((v, i, arr) => arr.indexOf(v) === i).sort()) {
  const win = COST * (1 / entry - 1);
  const be = entry; // 单桶盈亏平衡命中率 = entry
  const newPnl = newStratHits * win - (newStratN - newStratHits) * COST;
  // 旧策略若用同 entry (用旧策略实际命中数)
  const oldPnl = bHits * win - (bPicks.length - bHits) * COST;
  const marker = Math.abs(entry - bAvgEntry) < 0.005 ? " ←旧策略实际均价" : "";
  console.log(
    `  $${entry.toFixed(3).padStart(7)} | ${(be * 100).toFixed(1).padStart(7)}% | $${newPnl.toFixed(2).padStart(11)} | $${oldPnl.toFixed(2).padStart(13)}${marker}`,
  );
}

/* ================================================================== */
/* 4. 新策略逐市场命中明细                                            */
/* ================================================================== */
console.log(`\n${"=".repeat(70)}`);
console.log("  4. 新策略逐市场命中明细 (分城市修正 + 按 p 选 top1)");
console.log(`${"=".repeat(70)}`);
console.log(`  城市             | 日期       |  fc   | 修正  | actual | top桶      | p   | 结果`);
console.log(`  ${"-".repeat(80)}`);
let newHits = 0;
let newTotal = 0;
for (const m of resolved) {
  const fs = getForecastSigma(m)!;
  const bias = cityBiasMap.get(m.city_name) ?? 0;
  const adjFc = fs.fc - bias;
  const cands = (m.all_outcomes ?? [])
    .map((o) => ({ range: o.range, p: bucketProb(adjFc, o.range[0], o.range[1], fs.sigma) }))
    .sort((a, b) => b.p - a.p);
  const top = cands[0];
  if (!top) continue;
  newTotal += 1;
  const hit = inBucket(m.actual_temp!, top.range[0], top.range[1]);
  if (hit) newHits += 1;
  const bucketStr = top.range[0] === -999 ? `≤${top.range[1]}` : top.range[1] === 999 ? `≥${top.range[0]}` : `${top.range[0]}-${top.range[1]}`;
  console.log(
    `  ${m.city_name.padEnd(16)} | ${m.date} | ${fs.fc.toFixed(1).padStart(4)}${m.unit} | ${(bias >= 0 ? "+" : "")}${bias.toFixed(1).padStart(4)} | ${m.actual_temp!.toFixed(1).padStart(5)}${m.unit} | ${bucketStr.padEnd(10)} | ${(top.p * 100).toFixed(0).padStart(3)}% | ${hit ? "✓ HIT" : "✗"}`,
  );
}
console.log(`  ${"-".repeat(80)}`);
console.log(`  新策略命中: ${newHits} / ${newTotal} (${(newHits / newTotal * 100).toFixed(1)}%)`);

/* ================================================================== */
/* 5. 总结                                                            */
/* ================================================================== */
console.log(`\n${"=".repeat(70)}`);
console.log("  5. 总结");
console.log(`${"=".repeat(70)}`);
console.log(`  旧策略 (edge 排序):`);
console.log(`    命中率 ${bHits}/${bPicks.length} = ${(bHits / bPicks.length * 100).toFixed(1)}%  (盈亏平衡点 ${(bAvgEntry * 100).toFixed(1)}%)`);
console.log(`    已实现 PnL $${bRealized.toFixed(2)} | 持有到结算 PnL $${bHold.toFixed(2)}`);
console.log(`  新策略 (分城市修正 + p 排序):`);
console.log(`    命中率 ${newStratHits}/${newStratN} = ${(newStratRate * 100).toFixed(1)}%`);
console.log(`    若 entry $${bAvgEntry.toFixed(3)} (旧策略均价): PnL $${(newStratHits * (COST * (1 / bAvgEntry - 1)) - (newStratN - newStratHits) * COST).toFixed(2)}`);
console.log(`\n  偏差分析:`);
console.log(`    全局偏差 ${globalBias >= 0 ? "+" : ""}${globalBias.toFixed(2)}°C (预测${globalBias > 0 ? "偏高" : "偏低"})`);
console.log(`    全局+0.4°C 修正后命中率: ${(r2.rate * 100).toFixed(1)}% (vs 无修正 ${(r1.rate * 100).toFixed(1)}%)`);
console.log(`    分城市修正后命中率: ${(r3.rate * 100).toFixed(1)}% (in-sample) / ${(r4.rate * 100).toFixed(1)}% (leave-one-out)`);
console.log(`    偏低城市(actual偏高): ${lowBias.length} 个, 偏高城市: ${highBias.length} 个`);
