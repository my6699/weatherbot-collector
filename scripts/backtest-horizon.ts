/* 按 horizon (D+0/D+1/D+2) 分组回测: 命中率 + 预测误差 (2026-08-03)
 *
 * 回答:
 *   1. D+2 命中率多少 (vs D+0/D+1)
 *   2. 为什么 D+2 误差大 — 用 raw vs adj 误差 + sigma vs 桶宽量化
 *
 * Run: npx tsx scripts/backtest-horizon.ts
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { bucketProb, inBucket } from "../src/math.js";

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
interface Pos {
  sigma?: number | null;
  forecast_src?: string | null;
  opened_at?: string;
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

function getRawForecast(m: Mkt) {
  const pos = m.positions?.[0] ?? m.position;
  const snaps = m.forecast_snapshots ?? [];
  if (snaps.length === 0) return null;
  let snap = pos?.opened_at ? snaps.find((s) => s.ts === pos.opened_at) : undefined;
  if (!snap) snap = snaps[0];
  if (!snap || snap.best == null) return null;
  const sigma = pos?.sigma ?? (m.unit === "C" ? 2.3 : 1.7);
  const horizon = snap.horizon ?? "D+0";
  const rawSrc = pos?.forecast_src ?? snap.best_source ?? "best";
  const source = rawSrc === "ensemble" ? "best" : rawSrc.toLowerCase();
  return { fc: snap.best, sigma, horizon, source };
}

interface Row {
  horizon: string;
  unit: "F" | "C";
  rawFc: number;
  adjFc: number;
  actual: number;
  rawErr: number;
  adjErr: number;
  sigma: number;
  rawHit: boolean;
  adjHit: boolean;
  bucketWidth: number;
}

const rows: Row[] = [];
for (const m of markets) {
  if (m.actual_temp == null) continue;
  const r = getRawForecast(m);
  if (!r) continue;
  const adjFc = applyBias(r.fc, m.city, r.horizon, r.source, m.unit);
  const actual = m.actual_temp;
  const rawErr = Math.abs(r.fc - actual);
  const adjErr = Math.abs(adjFc - actual);
  const cands = (m.all_outcomes ?? [])
    .map((o) => ({
      range: o.range,
      pRaw: bucketProb(r.fc, o.range[0], o.range[1], r.sigma),
      pAdj: bucketProb(adjFc, o.range[0], o.range[1], r.sigma),
    }))
    .sort((a, b) => b.pAdj - a.pAdj);
  const topAdj = cands[0];
  const topRaw = [...cands].sort((a, b) => b.pRaw - a.pRaw)[0];
  if (!topAdj || !topRaw) continue;
  const bw = topAdj.range[1] - topAdj.range[0];
  rows.push({
    horizon: r.horizon,
    unit: m.unit,
    rawFc: r.fc,
    adjFc,
    actual,
    rawErr,
    adjErr,
    sigma: r.sigma,
    rawHit: inBucket(actual, topRaw.range[0], topRaw.range[1]),
    adjHit: inBucket(actual, topAdj.range[0], topAdj.range[1]),
    bucketWidth: bw > 100 ? NaN : bw,
  });
}

function mean(arr: number[]) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
}

console.log(`===== 按 horizon 分组 (现有逻辑 applyBias + p) =====`);
console.log(`  horizon | 样本 | 无修正命中 | 现有逻辑命中 | raw误差 | adj误差 | 平均sigma | 桶宽`);
console.log(`  ${"-".repeat(86)}`);
for (const h of ["D+0", "D+1", "D+2", "D+3"]) {
  const g = rows.filter((r) => r.horizon === h);
  if (g.length === 0) continue;
  const rawHits = g.filter((r) => r.rawHit).length;
  const adjHits = g.filter((r) => r.adjHit).length;
  const rawErr = mean(g.map((r) => r.rawErr));
  const adjErr = mean(g.map((r) => r.adjErr));
  const sig = mean(g.map((r) => r.sigma));
  const bw = mean(g.filter((r) => !Number.isNaN(r.bucketWidth)).map((r) => r.bucketWidth));
  console.log(
    `  ${h.padEnd(7)} |  ${g.length}   |   ${rawHits}/${g.length} (${((rawHits / g.length) * 100).toFixed(0).padStart(3)}%)  |   ${adjHits}/${g.length} (${((adjHits / g.length) * 100).toFixed(0).padStart(3)}%)   | ${rawErr.toFixed(2)}    | ${adjErr.toFixed(2)}    | ${sig.toFixed(2)}       | ${Number.isNaN(bw) ? "-" : bw.toFixed(1) + g[0]!.unit}`,
  );
}

// 按城市+horizon 看 D+2 哪些命中
console.log(`\n===== D+2 逐市场明细 =====`);
const d2 = rows.filter((r) => r.horizon === "D+2");
for (const r of d2.sort((a, b) => Math.abs(a.rawErr - b.rawErr))) {
  console.log(
    `  rawFc ${r.rawFc.toFixed(1)}${r.unit} -> adjFc ${r.adjFc.toFixed(1)}${r.unit} | actual ${r.actual.toFixed(1)}${r.unit} | rawErr ${r.rawErr.toFixed(1)} adjErr ${r.adjErr.toFixed(1)} | ${r.adjHit ? "✓" : "✗"}`,
  );
}

// 误差分布: 落在桶内的概率 vs sigma
console.log(`\n===== 为什么 D+2 误差大: sigma vs 桶宽 =====`);
for (const h of ["D+0", "D+1", "D+2"]) {
  const g = rows.filter((r) => r.horizon === h);
  if (g.length === 0) continue;
  const sig = mean(g.map((r) => r.sigma));
  const bw = mean(g.filter((r) => !Number.isNaN(r.bucketWidth)).map((r) => r.bucketWidth));
  const ratio = Number.isNaN(bw) ? NaN : sig / bw;
  console.log(
    `  ${h}: sigma=${sig.toFixed(2)}${g[0]!.unit} 桶宽=${Number.isNaN(bw) ? "-" : bw.toFixed(1) + g[0]!.unit} | sigma/桶宽=${Number.isNaN(ratio) ? "-" : ratio.toFixed(1)}x ${ratio > 1 ? "(误差>桶宽, 概率被分散到多桶)" : ""}`,
  );
}

// raw 误差随 horizon 增长
console.log(`\n===== 误差随 horizon 增长 (raw, 未修正) =====`);
for (const h of ["D+0", "D+1", "D+2"]) {
  const g = rows.filter((r) => r.horizon === h);
  if (g.length === 0) continue;
  const errs = g.map((r) => r.rawErr).sort((a, b) => a - b);
  const med = errs[Math.floor(errs.length / 2)]!;
  console.log(
    `  ${h}: 中位误差 ${med.toFixed(2)}${g[0]!.unit} | max ${errs[errs.length - 1]!.toFixed(2)}${g[0]!.unit} | >2°占比 ${((errs.filter((e) => e > 2).length / g.length) * 100).toFixed(0)}%`,
  );
}
