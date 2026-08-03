/* 检查真实 entry 可得性 + D0/D1 买入价现实性 (2026-08-03)
 *
 * 回答 "能买到 $0.20 entry 吗":
 *   1. 旧策略真实 entry (position.entry_price) — 实际成交价分布
 *   2. 开仓时市场最热桶 top_price — 新策略按 p 选 top1, 若模型 top1 == 市场 top,
 *      这个价格就是新策略 entry 的近似
 *   3. 模型 top1 桶 == 市场 top 桶 的一致率 — 决定 top_price 能否代表新策略 entry
 *
 * Run: npx tsx scripts/check-entry.ts
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { bucketProb } from "../src/math.js";

const DIR = path.join(process.cwd(), "data", "markets");
const BIAS_FILE = path.join(process.cwd(), "data", "bias.json");
const BIAS_MAX_C = 2.0;
const BIAS_SHRINK_N = 4;
const BIAS_MIN_N = 2;

const biasTable: Record<string, { bias: number; n: number }> = JSON.parse(
  readFileSync(BIAS_FILE, "utf-8"),
);
function biasKey(c: string, h: string, s: string) {
  return `${c}|${h}|${s.toLowerCase()}`;
}
function getBias(c: string, h: string, s: string, unit: "F" | "C"): number {
  const e = biasTable[biasKey(c, h, s)];
  if (!e || e.n < BIAS_MIN_N) return 0;
  const shrink = Math.min(1, e.n / BIAS_SHRINK_N);
  const cap = unit === "F" ? BIAS_MAX_C * 1.8 : BIAS_MAX_C;
  const capped = Math.max(-cap, Math.min(cap, e.bias));
  return Math.round(capped * shrink * 1000) / 1000;
}
function applyBias(fc: number, c: string, h: string, s: string, unit: "F" | "C"): number {
  const b = getBias(c, h, s, unit);
  return b === 0 ? fc : Math.round((fc - b) * 100) / 100;
}

interface Snap {
  ts?: string;
  horizon?: string;
  best?: number | null;
  best_source?: string | null;
}
interface MSnap {
  ts?: string;
  top_bucket: string | null;
  top_price: number | null;
}
interface Pos {
  entry_price: number;
  opened_at?: string;
  forecast_src?: string | null;
  sigma?: number | null;
}
interface Mkt {
  city: string;
  date: string;
  unit: "F" | "C";
  actual_temp: number | null;
  position: Pos | null;
  positions?: Pos[];
  all_outcomes: Array<{ range: [number, number] }>;
  forecast_snapshots?: Snap[];
  market_snapshots?: MSnap[];
}

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

// 1. 旧策略真实 entry
const entries: number[] = [];
for (const m of markets) {
  for (const p of m.positions ?? (m.position ? [m.position] : [])) {
    if (typeof p.entry_price === "number") entries.push(p.entry_price);
  }
}

// 2. 开仓时 top_price + 模型 top1 vs 市场 top 一致性
const topPricesAtOpen: number[] = [];
let modelEqMarket = 0;
let total = 0;
for (const m of markets) {
  if (m.actual_temp == null) continue;
  const pos = m.positions?.[0] ?? m.position;
  if (!pos?.opened_at) continue;
  const snap = (m.forecast_snapshots ?? []).find((s) => s.ts === pos.opened_at);
  if (!snap?.best) continue;
  const msnap = (m.market_snapshots ?? []).find((s) => s.ts === pos.opened_at);
  const horizon = snap.horizon ?? "D+0";
  const rawSrc = pos.forecast_src ?? snap.best_source ?? "best";
  const source = rawSrc === "ensemble" ? "best" : rawSrc.toLowerCase();
  const adjFc = applyBias(snap.best, m.city, horizon, source, m.unit);
  const sigma = pos.sigma ?? (m.unit === "C" ? 2.3 : 1.7);
  const cands = (m.all_outcomes ?? [])
    .map((o) => ({ range: o.range, p: bucketProb(adjFc, o.range[0], o.range[1], sigma) }))
    .sort((a, b) => b.p - a.p);
  const top1 = cands[0];
  if (!top1) continue;
  total++;
  // 市场 top_bucket 格式 "94-95F", 取第一个数字 = range[0]
  const m1 = msnap?.top_bucket?.match(/(-?\d+)/);
  const topLow = m1 ? parseInt(m1[1]!) : null;
  if (topLow != null && topLow === top1.range[0]) modelEqMarket++;
  if (msnap?.top_price != null) topPricesAtOpen.push(msnap.top_price);
}

function dist(arr: number[], label: string) {
  if (arr.length === 0) {
    console.log(`  ${label}: 无数据`);
    return;
  }
  arr.sort((a, b) => a - b);
  const n = arr.length;
  const q = (p: number) => arr[Math.floor(n * p)]!;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  console.log(
    `  ${label}: n=${n} | min ${arr[0]!.toFixed(3)} | p25 ${q(0.25).toFixed(3)} | 中位 ${q(0.5).toFixed(3)} | 均值 ${mean.toFixed(3)} | p75 ${q(0.75).toFixed(3)} | max ${arr[n - 1]!.toFixed(3)}`,
  );
  const buckets: Record<string, number> = {
    "<0.10": 0,
    "0.10-0.15": 0,
    "0.15-0.20": 0,
    "0.20-0.25": 0,
    "0.25-0.30": 0,
    "0.30-0.40": 0,
    ">=0.40": 0,
  };
  for (const v of arr) {
    if (v < 0.1) buckets["<0.10"]!++;
    else if (v < 0.15) buckets["0.10-0.15"]!++;
    else if (v < 0.2) buckets["0.15-0.20"]!++;
    else if (v < 0.25) buckets["0.20-0.25"]!++;
    else if (v < 0.3) buckets["0.25-0.30"]!++;
    else if (v < 0.4) buckets["0.30-0.40"]!++;
    else buckets[">=0.40"]!++;
  }
  console.log(
    `    分布: ${Object.entries(buckets)
      .map(([k, v]) => `${k}:${v}(${((v / n) * 100).toFixed(0)}%)`)
      .join("  ")}`,
  );
}

console.log(`===== 1. 旧策略真实买入 entry (position.entry_price) =====`);
dist(entries, "旧策略 entry");
console.log(`  (旧策略 edge 排序专挑市场低估的便宜桶, 偏低; 新策略 p 排序会更贵)`);

console.log(`\n===== 2. 开仓时市场最热桶 top_price (新策略 top1 entry 近似) =====`);
dist(topPricesAtOpen, "top_price at open");
console.log(`  (新策略按 p 选 top1 桶, 若该桶==市场最热桶, entry≈此价格)`);

console.log(`\n===== 3. 模型 top1 桶 == 市场 top 桶 一致率 =====`);
console.log(`  ${modelEqMarket} / ${total} (${((modelEqMarket / total) * 100).toFixed(0)}%) 一致`);
console.log(`  (一致率越高, 上面的 top_price 越能代表新策略真实 entry)`);
