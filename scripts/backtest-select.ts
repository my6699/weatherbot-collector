/* Backtest: 按 p 排序 vs 按 edge 排序 的选桶策略对比 (2026-08-03)
 *
 * 数据限制: all_outcomes 是最后一次 scan 的价格（结算后极端值），不是开仓时价格。
 * 所以历史里只有"已买桶"有开仓时价格 (position.entry_price)，其他桶没有。
 *
 * 因此本回测:
 *  - 命中率: 不需要价格，用 forecast 算每个桶的 p，按 p 选桶，用 actual_temp 判定命中（准确）。
 *  - 盈亏:   策略B(实际/按edge) 用真实 entry_price；策略A(按p) 用假设 entry + 盈亏平衡点。
 *
 * 策略A (按 p, 用户直觉): 每市场选预测概率 p 最大的桶。
 * 策略B (按 edge, 当前线上): 实际已买入的桶 (position 记录, 由 edge 排序选出)。
 *
 * Run: npx tsx scripts/backtest-select.ts
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { bucketProb, inBucket } from "../src/math.js";

const DIR = path.join(process.cwd(), "data", "markets");
const COST = 20;
const BASE_SIGMA_C = 2.3;
const BASE_SIGMA_F = 1.7;

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
  forecast_snapshots?: Array<{ best?: number | null }>;
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

// ===== 策略A: 按 p 选桶 (每市场选 p 最大的 N 桶) =====
interface APick {
  city: string;
  date: string;
  unit: string;
  actual: number;
  buckets: string[];
  hit: boolean; // 任一选中桶命中
  topP: number; // p 最大的桶的 p
  forecastTemp: number;
}
const aPicks1: APick[] = []; // 每市场 p 最大 1 桶
const aPicks3: APick[] = []; // 每市场 p 最大 3 桶

for (const m of markets) {
  if (m.actual_temp == null) continue;
  const fs = getForecastSigma(m);
  if (!fs) continue;
  const cands = (m.all_outcomes ?? [])
    .map((o) => ({
      range: o.range,
      p: bucketProb(fs.fc, o.range[0], o.range[1], fs.sigma),
    }))
    .sort((a, b) => b.p - a.p);

  const top1 = cands[0];
  const top3 = cands.slice(0, 3);
  const mk = (cands2: typeof cands): APick => ({
    city: m.city_name,
    date: m.date,
    unit: m.unit,
    actual: m.actual_temp!,
    buckets: cands2.map((c) => `${c.range[0]}-${c.range[1]}`),
    hit: cands2.some((c) => inBucket(m.actual_temp!, c.range[0], c.range[1])),
    topP: cands2[0]?.p ?? 0,
    forecastTemp: fs.fc,
  });
  if (top1) aPicks1.push(mk([top1]));
  if (top3.length) aPicks3.push(mk(top3));
}

// ===== 策略B: 实际买入桶 (按 edge 选的) =====
interface BPick {
  city: string;
  date: string;
  unit: string;
  bucket: string;
  entry: number;
  hit: boolean;
  pnlRealized: number; // 已实现 pnl (含止损/forecast_changed)
  pnlHoldToSettle: number; // 持有到结算 pnl
}
const bPicks: BPick[] = [];
for (const m of markets) {
  if (m.actual_temp == null) continue;
  const positions = m.positions ?? (m.position ? [m.position] : []);
  for (const p of positions) {
    if (p.bucket_low == null || p.bucket_high == null) continue;
    const hit = inBucket(m.actual_temp, p.bucket_low, p.bucket_high);
    const entry = p.entry_price;
    const pnlHold = hit
      ? Math.round(COST * (1 / entry - 1) * 100) / 100
      : -COST;
    bPicks.push({
      city: m.city_name,
      date: m.date,
      unit: m.unit,
      bucket: `${p.bucket_low}-${p.bucket_high}`,
      entry,
      hit,
      pnlRealized: p.pnl ?? 0,
      pnlHoldToSettle: pnlHold,
    });
  }
}

// ===== 汇总 =====
function hitRate(picks: APick[] | BPick[], label: string) {
  const n = picks.length;
  const hits = picks.filter((p) => p.hit).length;
  console.log(`  ${label}: ${hits} / ${n}  (${n ? ((hits / n) * 100).toFixed(1) : 0}%)`);
  return { n, hits, rate: n ? hits / n : 0 };
}

console.log(`===== 数据 =====`);
console.log(`已结算 market (有 actual_temp): ${markets.filter((m) => m.actual_temp != null).length}`);
console.log(`有 forecast 的 market: ${aPicks1.length}`);

console.log(`\n===== 命中率对比 =====`);
const a1 = hitRate(aPicks1, "策略A 每市场选 p 最大 1 桶");
const a3 = hitRate(aPicks3, "策略A 每市场选 p 最大 3 桶(任一命中)");
const b = hitRate(bPicks, "策略B 实际买入桶(按edge, position级)");

console.log(`\n===== 策略B 真实盈亏 (position 级) =====`);
const bRealized = bPicks.reduce((s, p) => s + p.pnlRealized, 0);
const bHold = bPicks.reduce((s, p) => s + p.pnlHoldToSettle, 0);
const bAvgEntry = bPicks.length ? bPicks.reduce((s, p) => s + p.entry, 0) / bPicks.length : 0;
console.log(`  桶数:           ${bPicks.length}`);
console.log(`  已实现 PnL:     $${bRealized.toFixed(2)}  (含止损/forecast_changed)`);
console.log(`  持有到结算 PnL: $${bHold.toFixed(2)}`);
console.log(`  平均 entry:     $${bAvgEntry.toFixed(3)}`);

console.log(`\n===== 策略A 理论盈亏 (假设 entry, 持有到结算) =====`);
console.log(`  A1: 每市场买1桶, 命中赚 win=cost*(1/entry-1), 未中亏 cost`);
console.log(`  A3: 每市场买3桶, 命中市场=1桶赢win+2桶全损(净 win-2*cost), 未中市场=3桶全损(-3*cost)`);
for (const entry of [0.2, 0.25, 0.3, 0.35, 0.4]) {
  const win = COST * (1 / entry - 1);
  // A1: 单桶成本 cost, 命中赢 win, 未中亏 cost
  const pnl1 = a1.hits * win - (a1.n - a1.hits) * COST;
  const be1 = COST / (win + COST); // A1 盈亏平衡命中率
  // A3: 每市场3桶成本 3*cost, 命中市场净 (win - 2*cost), 未中市场净 -3*cost
  const pnl3 = a1.hits * 0 + a3.hits * (win - 2 * COST) - (a3.n - a3.hits) * 3 * COST;
  // A3 盈亏平衡命中率 p*: p*(win-2c) + (1-p)*(-3c) = 0 → p = 3c / (win + c)
  const be3 = (3 * COST) / (win + COST);
  console.log(
    `  entry $${entry.toFixed(2)}: A1 PnL $${pnl1.toFixed(2)} (平衡点 ${(be1 * 100).toFixed(1)}%) | A3 PnL $${pnl3.toFixed(2)} (平衡点 ${(be3 * 100).toFixed(1)}%)`,
  );
}

// 策略A1 配合 edge 排序的低 entry 优势: 用策略B 平均 entry 估算 (bAvgEntry 已在上面计算)
if (bAvgEntry > 0) {
  const win = COST * (1 / bAvgEntry - 1);
  const pnl1LowEntry = a1.hits * win - (a1.n - a1.hits) * COST;
  const be = COST / (win + COST);
  console.log(
    `\n  [A1 + 低 entry] 若按 p 选桶但用策略B 平均 entry $${bAvgEntry.toFixed(3)}: A1 PnL $${pnl1LowEntry.toFixed(2)} (平衡点 ${(be * 100).toFixed(1)}%, 实际命中 ${(a1.rate * 100).toFixed(1)}%)`,
  );
}

console.log(`\n===== 策略A 命中明细 (每市场 p 最大 1 桶) =====`);
for (const p of aPicks1) {
  console.log(
    `  ${p.city.padEnd(14)} ${p.date} fc ${p.forecastTemp}${p.unit} actual ${p.actual}${p.unit} | top ${p.buckets[0]} (p ${(p.topP * 100).toFixed(0)}%) ${p.hit ? "✓ HIT" : "✗ miss"}`,
  );
}

console.log(`\n===== 策略B 命中明细 (实际买入) =====`);
for (const p of bPicks.filter((p) => p.hit)) {
  console.log(
    `  ${p.city.padEnd(14)} ${p.date} ${p.bucket.padEnd(8)} entry $${p.entry.toFixed(3)} hold +$${(COST * (1 / p.entry - 1)).toFixed(2)}`,
  );
}

console.log(`\n===== 逐市场对比 (前 20) =====`);
let shown = 0;
for (const m of markets) {
  if (m.actual_temp == null || shown >= 20) continue;
  const fs = getForecastSigma(m);
  if (!fs) continue;
  const cands = (m.all_outcomes ?? [])
    .map((o) => ({ range: o.range, p: bucketProb(fs.fc, o.range[0], o.range[1], fs.sigma) }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 3);
  const actuals = m.positions ?? (m.position ? [m.position] : []);
  shown++;
  console.log(`  ${m.city_name.padEnd(14)} ${m.date} actual ${m.actual_temp}${m.unit} fc ${fs.fc}${m.unit}:`);
  console.log(
    `    A(按p):  ${cands.map((c) => `${c.range[0]}-${c.range[1]}(p${(c.p * 100).toFixed(0)})${inBucket(m.actual_temp!, c.range[0], c.range[1]) ? "✓" : "✗"}`).join("  ")}`,
  );
  console.log(
    `    B(实际): ${actuals.map((p) => `${p.bucket_low}-${p.bucket_high}${inBucket(m.actual_temp!, p.bucket_low, p.bucket_high) ? "✓" : "✗"}`).join("  ") || "—"}`,
  );
}
