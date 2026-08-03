/* 按现有逻辑回测选桶命中率 (2026-08-03)
 *
 * "现有逻辑" = CI 里实际跑的策略:
 *   原始 forecast (snapshot.best, 未修正)
 *   -> applyBias (读 data/bias.json 真实分城市滚动 bias, 含 cap+shrink)
 *   -> bucketProb 算各桶 p
 *   -> 按 p 降序选 top1
 *   -> 命中 = inBucket(actual_temp, top1.low, top1.high)
 *
 * 关键: position.forecast_temp 是 scan.ts 里 applyBias 之后存的值 (adjForecast),
 *       直接用它再 applyBias 会双重修正。所以本脚本从 forecast_snapshots 取
 *       开仓时刻的原始 best, 重新走一遍 applyBias, 忠实复刻线上选桶。
 *
 * 对比:
 *   A. 无修正 (raw forecast, 按 p 选 top1)
 *   B. 现有逻辑 (applyBias, 按 p 选 top1)  <- 重点
 *   C. 旧策略实际买入 (position 级, edge 排序选出, 含已实现 PnL)
 *
 * 局限: all_outcomes 价格是结算后极端值, 无法复刻 MIN_ASK/edge 盘口过滤,
 *       所以命中率是"选桶准确性", 不含"是否入场"。盘口过滤只减少入场数,
 *       不改变选中的桶。
 *
 * Run: npx tsx scripts/backtest-current.ts
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { bucketProb, inBucket } from "../src/math.js";

const DIR = path.join(process.cwd(), "data", "markets");
const BIAS_FILE = path.join(process.cwd(), "data", "bias.json");
const COST = 20;

// 与 src/config.ts 一致 (手动同步, 避免触发 config 模块加载副作用)
const BIAS_MAX_C = 2.0;
const BIAS_SHRINK_N = 4;
const BIAS_MIN_N = 2;

interface Outcome {
  range: [number, number];
}
interface Snap {
  ts?: string;
  horizon?: string;
  best?: number | null;
  ecmwf?: number | null;
  hrrr?: number | null;
  best_source?: string | null;
}
interface Pos {
  bucket_low: number;
  bucket_high: number;
  entry_price: number;
  pnl: number | null;
  forecast_temp?: number | null;
  forecast_src?: string | null;
  sigma?: number | null;
  opened_at?: string;
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
  forecast_snapshots?: Snap[];
}

// ===== 加载 bias.json (真实 CI 用的修正表) =====
let biasTable: Record<string, { bias: number; n: number }> = {};
try {
  biasTable = JSON.parse(readFileSync(BIAS_FILE, "utf-8"));
} catch {
  console.warn("[WARN] data/bias.json not found, running without bias correction");
}
const biasKeys = Object.keys(biasTable).length;

function biasKey(city: string, horizon: string, source: string): string {
  return `${city}|${horizon}|${source.toLowerCase()}`;
}

/** 复刻 src/bias.ts getBias: cap (F×1.8) + shrink (n<4 收缩) + min-n 门槛。 */
function getBias(city: string, horizon: string, source: string, unit: "F" | "C"): number {
  const entry = biasTable[biasKey(city, horizon, source)];
  if (!entry || entry.n < BIAS_MIN_N) return 0;
  const shrink = Math.min(1, entry.n / BIAS_SHRINK_N);
  const cap = unit === "F" ? BIAS_MAX_C * 1.8 : BIAS_MAX_C;
  const capped = Math.max(-cap, Math.min(cap, entry.bias));
  return Math.round(capped * shrink * 1000) / 1000;
}

/** forecast - bias (与 src/bias.ts applyBias 一致, 修正方向: 拉向 actual)。 */
function applyBias(fc: number, city: string, horizon: string, source: string, unit: "F" | "C"): number {
  const b = getBias(city, horizon, source, unit);
  return b === 0 ? fc : Math.round((fc - b) * 100) / 100;
}

// ===== 加载市场 =====
const markets = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => {
    try {
      return JSON.parse(readFileSync(path.join(DIR, f), "utf-8")) as Mkt;
    } catch {
      return null;
    }
  })
  .filter((m): m is Mkt => m != null);

/** 取开仓时刻的原始 forecast (未修正) + sigma + horizon + source。
 *  必须用原始值再 applyBias, 不能用 position.forecast_temp (那是修正后的)。 */
function getRawForecast(m: Mkt): {
  fc: number;
  sigma: number;
  horizon: string;
  source: string;
} | null {
  const pos = m.positions?.[0] ?? m.position;
  const snaps = m.forecast_snapshots ?? [];
  if (snaps.length === 0) return null;
  let snap = pos?.opened_at ? snaps.find((s) => s.ts === pos.opened_at) : undefined;
  if (!snap) snap = snaps[0];
  if (!snap) return null;
  const fc = snap.best ?? snap.ecmwf ?? snap.hrrr;
  if (fc == null) return null;
  const sigma = pos?.sigma ?? (m.unit === "C" ? 2.3 : 1.7);
  const horizon = snap.horizon ?? "D+0";
  const rawSrc = pos?.forecast_src ?? snap.best_source ?? "best";
  // 复刻 scan.ts:821 bestSource === "ensemble" ? "best" : bestSource
  const source = rawSrc === "ensemble" ? "best" : rawSrc.toLowerCase();
  return { fc, sigma, horizon, source };
}

const resolved = markets.filter((m) => m.actual_temp != null && getRawForecast(m) != null);

console.log(`===== 数据 =====`);
console.log(`总 market 文件: ${markets.length}`);
console.log(`已结算 + 有原始 forecast: ${resolved.length}`);
console.log(`bias.json 条目: ${biasKeys}`);

// ===== 选 top1 桶 =====
interface Pick {
  city: string;
  city_name: string;
  date: string;
  unit: "F" | "C";
  rawFc: number;
  adjFc: number;
  biasApplied: number;
  sigma: number;
  horizon: string;
  source: string;
  bucket: [number, number];
  p: number;
  actual: number;
  hit: boolean;
}

function selectTop1(m: Mkt, useBias: boolean): Pick | null {
  const r = getRawForecast(m)!;
  const bias = useBias ? getBias(m.city, r.horizon, r.source, m.unit) : 0;
  const adjFc = useBias ? applyBias(r.fc, m.city, r.horizon, r.source, m.unit) : r.fc;
  const cands = (m.all_outcomes ?? [])
    .map((o) => ({
      range: o.range,
      p: bucketProb(adjFc, o.range[0], o.range[1], r.sigma),
    }))
    .sort((a, b) => b.p - a.p);
  const top = cands[0];
  if (!top) return null;
  return {
    city: m.city,
    city_name: m.city_name,
    date: m.date,
    unit: m.unit,
    rawFc: r.fc,
    adjFc,
    biasApplied: bias,
    sigma: r.sigma,
    horizon: r.horizon,
    source: r.source,
    bucket: top.range,
    p: top.p,
    actual: m.actual_temp!,
    hit: inBucket(m.actual_temp!, top.range[0], top.range[1]),
  };
}

const picksA = resolved.map((m) => selectTop1(m, false)).filter((p): p is Pick => p != null); // 无修正
const picksB = resolved.map((m) => selectTop1(m, true)).filter((p): p is Pick => p != null); // 现有逻辑

function rate(picks: Pick[], label: string) {
  const n = picks.length;
  const hits = picks.filter((p) => p.hit).length;
  const r = n ? hits / n : 0;
  console.log(`  ${label.padEnd(28)}: ${hits} / ${n}  (${(r * 100).toFixed(1)}%)`);
  return { n, hits, rate: r };
}

console.log(`\n===== 选桶命中率 (按 p 选 top1, 持有到结算) =====`);
const rA = rate(picksA, "A. 无修正 (raw forecast)");
const rB = rate(picksB, "B. 现有逻辑 (applyBias + p)");
console.log(`\n  分城市偏差修正提升: ${(rA.rate * 100).toFixed(1)}% -> ${(rB.rate * 100).toFixed(1)}% (${((rB.rate - rA.rate) * 100).toFixed(1)} 个百分点)`);

// ===== 旧策略实际买入对比 (position 级) =====
interface BPick {
  city_name: string;
  date: string;
  unit: "F" | "C";
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
      city_name: m.city_name,
      date: m.date,
      unit: m.unit,
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

console.log(`\n===== 旧策略实际买入 (position 级, edge 排序) =====`);
console.log(`  桶数: ${bPicks.length} | 命中: ${bHits} (${bPicks.length ? ((bHits / bPicks.length) * 100).toFixed(1) : 0}%)`);
console.log(`  已实现 PnL: $${bRealized.toFixed(2)} (含止损/forecast_changed 提前平仓)`);
console.log(`  持有到结算 PnL: $${bHold.toFixed(2)}`);
console.log(`  平均 entry: $${bAvgEntry.toFixed(3)} (盈亏平衡命中率 ${(bAvgEntry * 100).toFixed(1)}%)`);

// ===== 现有逻辑盈亏估算 (假设 entry = 旧策略均价, 持有到结算) =====
console.log(`\n===== 现有逻辑盈亏估算 (假设 entry, 持有到结算, 单桶成本 $${COST}) =====`);
console.log(`  命中率 ${(rB.rate * 100).toFixed(1)}% (盈亏平衡 = entry 价格)`);
console.log(`  ${"entry".padStart(8)} | ${"平衡点".padStart(7)} | ${"PnL".padStart(10)} | ${"vs 旧策略已实现".padStart(16)}`);
for (const entry of [0.10, 0.15, bAvgEntry, 0.20, 0.25, 0.30].filter((v, i, arr) => arr.indexOf(v) === i).sort()) {
  const win = COST * (1 / entry - 1);
  const pnl = rB.hits * win - (rB.n - rB.hits) * COST;
  const marker = Math.abs(entry - bAvgEntry) < 0.005 ? " <- 旧策略均价" : "";
  console.log(
    `  $${entry.toFixed(3).padStart(7)} | ${(entry * 100).toFixed(1).padStart(6)}% | $${pnl.toFixed(2).padStart(9)} | $${(pnl - bRealized).toFixed(2).padStart(15)}${marker}`,
  );
}

// ===== 分城市命中率 (现有逻辑) =====
console.log(`\n===== 分城市命中率 (现有逻辑 applyBias + p) =====`);
console.log(`  城市             | 样本 | 命中 | 命中率 | 平均 p`);
console.log(`  ${"-".repeat(58)}`);
const byCity = new Map<string, Pick[]>();
for (const p of picksB) {
  const arr = byCity.get(p.city_name) ?? [];
  arr.push(p);
  byCity.set(p.city_name, arr);
}
for (const [city, arr] of [...byCity.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const hits = arr.filter((p) => p.hit).length;
  const avgP = arr.reduce((s, p) => s + p.p, 0) / arr.length;
  console.log(
    `  ${city.padEnd(16)} |  ${arr.length}   |  ${hits}   | ${((hits / arr.length) * 100).toFixed(0).padStart(3)}%  | ${(avgP * 100).toFixed(0)}%`,
  );
}

// ===== 逐市场命中明细 (现有逻辑) =====
console.log(`\n===== 逐市场命中明细 (现有逻辑) =====`);
console.log(`  城市             | 日期       | horizon | src  | rawFc | bias  | adjFc | actual | top桶      | p   | 结果`);
console.log(`  ${"-".repeat(108)}`);
for (const p of picksB.sort((a, b) => a.date.localeCompare(b.date) || a.city_name.localeCompare(b.city_name))) {
  const bucketStr = p.bucket[0] === -999 ? `≤${p.bucket[1]}` : p.bucket[1] === 999 ? `≥${p.bucket[0]}` : `${p.bucket[0]}-${p.bucket[1]}`;
  console.log(
    `  ${p.city_name.padEnd(16)} | ${p.date} | ${p.horizon.padEnd(7)} | ${p.source.padEnd(4)} | ${p.rawFc.toFixed(1).padStart(5)}${p.unit} | ${(p.biasApplied >= 0 ? "+" : "")}${p.biasApplied.toFixed(1).padStart(4)} | ${p.adjFc.toFixed(1).padStart(5)}${p.unit} | ${p.actual.toFixed(1).padStart(5)}${p.unit} | ${bucketStr.padEnd(10)} | ${(p.p * 100).toFixed(0).padStart(3)}% | ${p.hit ? "✓ HIT" : "✗"}`,
  );
}

// ===== bias 修正生效情况 =====
const corrected = picksB.filter((p) => p.biasApplied !== 0);
const correctedHits = corrected.filter((p) => p.hit).length;
const noBiasSameBucket = picksB.filter((p, i) => {
  const a = picksA[i];
  return a && a.bucket[0] === p.bucket[0] && a.bucket[1] === p.bucket[1];
}).length;
console.log(`\n===== bias 修正生效分析 =====`);
console.log(`  应用 bias 的市场: ${corrected.length} / ${picksB.length} (其中命中 ${correctedHits})`);
console.log(`  bias 改变了 top1 桶: ${picksB.length - noBiasSameBucket} 个市场`);
console.log(`  (其余 ${noBiasSameBucket} 个市场 bias 未改变选桶, 命中率不受影响)`);
