/* LOO 留一交叉验证回测 (2026-08-03)
 *
 * backtest-optimize.ts 用 data/bias.json (含全部市场) -> in-sample 命中 50%, PnL $202 (乐观).
 * 本脚本对每个市场 m 用【排除 m】重新计算的 bias 表预测, 模拟实盘: bias 表不含待预测市场.
 *
 * bias 计算复刻 src/bias.ts (BIAS_MIN_N=2, BIAS_MAX_C=2.0, BIAS_SHRINK_N=4, BIAS_FORGET_N=12):
 *   - 每个 (city|horizon|source) 收集 (forecast - actual) 样本, 按 date 排序取最近 FORGET_N 个
 *   - 样本数 < MIN_N -> bias=0; 否则 bias = clamp(mean, ±cap) * min(1, n/SHRINK_N)
 *   - applyBias: forecast - bias
 *
 * 简化: actual 用 m.actual_temp (与 backtest-optimize.ts 一致, 保证同口径对比);
 *       src/bias.ts 优先用 metarMaxInUnit, 此处未引入 (差别 <0.5°C, 对 bias 均值影响小).
 *
 * 真实 entry 仍取 market_snapshots.top_price (模型 top1 上界), 报告一致子集.
 *
 * Run: npx tsx scripts/backtest-loo.ts
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { bucketProb, inBucket } from "../src/math.js";
import { metarMaxInUnit } from "../src/metar-archive.js";

const DIR = path.join(process.cwd(), "data", "markets");
const COST = 20;
const BIAS_MAX_C = 2.0;
const BIAS_SHRINK_N = 4;
const BIAS_MIN_N = 2;
const BIAS_FORGET_N = 12;

interface Snap {
  ts?: string;
  horizon?: string;
  best?: number | null;
  ecmwf?: number | null;
  hrrr?: number | null;
  best_source?: string | null;
}
interface MSnap {
  ts?: string;
  top_bucket: string | null;
  top_price: number | null;
}
interface Pos {
  sigma?: number | null;
  forecast_src?: string | null;
  opened_at?: string;
}
interface Mkt {
  city: string;
  city_name: string;
  date: string;
  unit: "F" | "C";
  station?: string;
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

const resolved = markets.filter((m) => m.actual_temp != null);

// ---- 收集所有 bias 样本 (复刻 bias.ts refreshBias) ----
interface BiasSample {
  key: string;
  error: number;
  mktIdx: number;
  date: string;
}
const allSamples: BiasSample[] = [];
resolved.forEach((m, idx) => {
  // bias 用真实最高温 (与 src/bias.ts 同口径), 命中判断仍用 actual_temp (桶代表值)
  const biasActual = metarMaxInUnit(m.station ?? "", m.date, m.unit) ?? m.actual_temp!;
  for (const snap of m.forecast_snapshots ?? []) {
    const horizon = snap.horizon ?? "D+0";
    const srcs: [string, number | null | undefined][] = [
      ["best", snap.best],
      ["ecmwf", snap.ecmwf],
      ["hrrr", snap.hrrr],
    ];
    for (const [src, v] of srcs) {
      if (v == null) continue;
      allSamples.push({
        key: `${m.city}|${horizon}|${src.toLowerCase()}`,
        error: v - biasActual,
        mktIdx: idx,
        date: m.date,
      });
    }
  }
});
const fullSeries: Record<string, BiasSample[]> = {};
for (const s of allSamples) (fullSeries[s.key] ??= []).push(s);
for (const k of Object.keys(fullSeries)) fullSeries[k]!.sort((a, b) => a.date.localeCompare(b.date));

/** LOO bias 表: 排除 excludeIdx 市场, 每个 key 取最近 FORGET_N 个样本算 bias. */
function biasTable(excludeIdx: number): Record<string, { bias: number; n: number }> {
  const table: Record<string, { bias: number; n: number }> = {};
  for (const [key, arr] of Object.entries(fullSeries)) {
    const kept = arr.filter((s) => s.mktIdx !== excludeIdx);
    const win = kept.slice(-BIAS_FORGET_N);
    if (win.length < BIAS_MIN_N) continue;
    const bias = win.reduce((a, b) => a + b.error, 0) / win.length;
    table[key] = { bias: Math.round(bias * 1000) / 1000, n: win.length };
  }
  return table;
}
function getBias(
  table: Record<string, { bias: number; n: number }>,
  city: string,
  horizon: string,
  source: string,
  unit: "F" | "C",
): { bias: number; n: number } {
  const e = table[`${city}|${horizon}|${source.toLowerCase()}`];
  if (!e || e.n < BIAS_MIN_N) return { bias: 0, n: 0 };
  const shrink = Math.min(1, e.n / BIAS_SHRINK_N);
  const cap = unit === "F" ? BIAS_MAX_C * 1.8 : BIAS_MAX_C;
  const capped = Math.max(-cap, Math.min(cap, e.bias));
  return { bias: Math.round(capped * shrink * 1000) / 1000, n: e.n };
}

interface Pick {
  city: string;
  city_name: string;
  date: string;
  horizon: string;
  unit: "F" | "C";
  adjFc: number;
  sigma: number;
  biasN: number;
  biasUsed: number;
  actual: number;
  top1: [number, number];
  top1Hit: boolean;
  realEntry: number;
  isTopMatch: boolean;
}

/** 用给定 bias 表预测单个市场. 返回 null 表示无有效快照/盘口. */
function buildPick(m: Mkt, table: Record<string, { bias: number; n: number }>): Pick | null {
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
  const { bias, n: biasN } = getBias(table, m.city, horizon, source, m.unit);
  const adjFc = bias === 0 ? snap.best : Math.round((snap.best - bias) * 100) / 100;
  const cands = (m.all_outcomes ?? [])
    .map((o) => ({ range: o.range, p: bucketProb(adjFc, o.range[0], o.range[1], sigma) }))
    .sort((a, b) => b.p - a.p);
  if (cands.length === 0) return null;
  const top1 = cands[0]!;
  const snapTs = snap.ts;
  const msnap = (m.market_snapshots ?? []).find((s) => s.ts === snapTs);
  if (!msnap || msnap.top_price == null) return null;
  const mLow = msnap.top_bucket?.match(/(-?\d+)/);
  const marketTopLow = mLow ? parseInt(mLow[1]!) : null;
  const isTopMatch = marketTopLow != null && marketTopLow === top1.range[0];
  return {
    city: m.city,
    city_name: m.city_name,
    date: m.date,
    horizon,
    unit: m.unit,
    adjFc,
    sigma,
    biasN,
    biasUsed: bias,
    actual: m.actual_temp!,
    top1: top1.range,
    top1Hit: inBucket(m.actual_temp!, top1.range[0], top1.range[1]),
    realEntry: msnap.top_price,
    isTopMatch,
  };
}
function buildPicks(table: Record<string, { bias: number; n: number }>): Pick[] {
  return resolved.map((m) => buildPick(m, table)).filter((p): p is Pick => p != null);
}

function pnl(hit: boolean, cost: number, entry: number): number {
  return hit ? cost * (1 / entry - 1) : -cost;
}
function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}
function mean(arr: number[]): number {
  return arr.length ? sum(arr) / arr.length : 0;
}
function stats(picks: Pick[]) {
  const n = picks.length;
  const hits = picks.filter((p) => p.top1Hit).length;
  const p = sum(picks.map((x) => pnl(x.top1Hit, COST, x.realEntry)));
  return { n, hits, rate: n ? (hits / n) * 100 : 0, pnl: p };
}
function fmt(s: { n: number; hits: number; rate: number; pnl: number }) {
  return `样本${s.n} 命中${s.hits}(${s.rate.toFixed(1)}%) PnL$${s.pnl.toFixed(0)}`;
}

// 无 bias (adjFc=snap.best, 不修正) — 用空 bias 表
const nonePicks = buildPicks({});
// in-sample (全量 bias 表, excludeIdx=-1 不排除任何)
const insamplePicks = buildPicks(biasTable(-1));
// LOO (每个市场用排除自己的 bias 表)
const looPicks: Pick[] = resolved
  .map((m, idx) => buildPick(m, biasTable(idx)))
  .filter((p): p is Pick => p != null);

console.log(`===== LOO 留一交叉验证 =====`);
console.log(`  bias 参数: MIN_N=${BIAS_MIN_N} MAX_C=${BIAS_MAX_C} SHRINK_N=${BIAS_SHRINK_N} FORGET_N=${BIAS_FORGET_N}`);
console.log(`  resolved 市场数: ${resolved.length} | LOO 有效样本: ${looPicks.length}`);

console.log(`\n===== 三档 bias 对比 (单桶 top1, 真实 entry 上界, 保守) =====`);
const noneS = stats(nonePicks);
const inS = stats(insamplePicks);
const looS = stats(looPicks);
console.log(`  无 bias 修正:    ${fmt(noneS)}  (adjFc=snap.best, 纯 ensemble)`);
console.log(`  in-sample bias:  ${fmt(inS)}  (含待预测市场, 乐观上界)`);
console.log(`  LOO bias:        ${fmt(looS)}  (排除待预测市场, 实盘预期)`);
const looActive = looPicks.filter((p) => p.biasUsed !== 0).length;
console.log(`  LOO 下 bias 实际生效: ${looActive}/${looPicks.length} (${looPicks.length ? ((looActive / looPicks.length) * 100).toFixed(0) : 0}%) 样本 bias!=0`);

console.log(`\n===== LOO 一致子集 (模型 top1==市场 top, entry 准确, 最可信) =====`);
const looMatch = looPicks.filter((p) => p.isTopMatch);
const looMismatch = looPicks.filter((p) => !p.isTopMatch);
console.log(`  一致子集:   ${fmt(stats(looMatch))}`);
console.log(`  不一致子集: ${fmt(stats(looMismatch))}  (entry 仍为上界, 真实 PnL>=此值)`);

// LOO 各优化
console.log(`\n===== LOO 优化对比 (真实 entry 上界) =====`);
const looBase = looS.pnl;
const blacklist = new Set(["tokyo", "toronto"]);
const bl = looPicks.filter((p) => !blacklist.has(p.city));
console.log(`  基线(LOO):           ${fmt(looS)}`);
console.log(`  +黑名单Tokyo/Toronto: ${fmt(stats(bl))}  (Δ $${(stats(bl).pnl - looBase).toFixed(0)})`);
const wPnl = sum(looPicks.map((p) => pnl(p.top1Hit, p.horizon === "D+0" ? COST * 1.5 : COST, p.realEntry)));
console.log(`  +horizon加权:        样本${looPicks.length} PnL$${wPnl.toFixed(0)}  (Δ $${(wPnl - looBase).toFixed(0)})`);
const tiers = [
  { label: "p>=0.30 重仓", min: 0.3, cost: 40 },
  { label: "p 0.20-0.30 标准", min: 0.2, cost: 20 },
  { label: "p<0.20 轻仓", min: 0, cost: 10 },
];
const tierPicks = looPicks.map((p) => {
  const prob = bucketProb(p.adjFc, p.top1[0], p.top1[1], p.sigma);
  const tier = tiers.find((t) => prob >= t.min)!;
  return { ...p, cost: tier.cost, tier: tier.label };
});
const tierPnl = sum(tierPicks.map((p) => pnl(p.top1Hit, p.cost, p.realEntry)));
console.log(`  +p分级仓位:         样本${looPicks.length} PnL$${tierPnl.toFixed(0)}  (Δ $${(tierPnl - looBase).toFixed(0)})`);
for (const t of tiers) {
  const g = tierPicks.filter((p) => p.tier === t.label);
  console.log(`    ${t.label}($${t.cost}): ${g.length}笔 命中${g.filter((p) => p.top1Hit).length}(${g.length ? ((g.filter((p) => p.top1Hit).length / g.length) * 100).toFixed(0) : 0}%) entry均$${mean(g.map((p) => p.realEntry)).toFixed(3)} PnL$${sum(g.map((p) => pnl(p.top1Hit, p.cost, p.realEntry))).toFixed(0)}`);
}
const comboPnl = sum(
  bl.map((p) => {
    const cost = p.horizon === "D+0" ? COST * 1.5 : COST;
    return pnl(p.top1Hit, cost, p.realEntry);
  }),
);
console.log(`  组合(黑名单+horizon): ${fmt({ n: bl.length, hits: bl.filter((p) => p.top1Hit).length, rate: bl.length ? (bl.filter((p) => p.top1Hit).length / bl.length) * 100 : 0, pnl: comboPnl })}  (Δ $${(comboPnl - looBase).toFixed(0)})`);

// LOO MAX_PRICE 实测
console.log(`\n===== LOO MAX_PRICE 实测 (按 realEntry 上界分档) =====`);
for (const cap of [0.25, 0.3, 0.35, 0.45, 0.6]) {
  const g = looPicks.filter((p) => p.realEntry <= cap);
  console.log(`  MAX_PRICE<=${cap.toFixed(2)}: ${fmt(stats(g))}`);
}
console.log(`  全量(无上限):       ${fmt(looS)}`);

// LOO 逐城市命中率
console.log(`\n===== LOO 逐城市命中率 (找拖后腿城市) =====`);
const byCity: Record<string, { hits: number; n: number; pnl: number }> = {};
for (const p of looPicks) {
  const c = (byCity[p.city] ??= { hits: 0, n: 0, pnl: 0 });
  c.n++;
  if (p.top1Hit) c.hits++;
  c.pnl += pnl(p.top1Hit, COST, p.realEntry);
}
const cityRows = Object.entries(byCity).map(([city, v]) => ({ city, ...v, rate: v.n ? (v.hits / v.n) * 100 : 0 }));
cityRows.sort((a, b) => a.pnl - b.pnl);
for (const r of cityRows) {
  console.log(`  ${r.city.padEnd(12)} ${r.n}笔 命中${r.hits}(${r.rate.toFixed(0)}%) PnL$${r.pnl.toFixed(0)}`);
}

// 诊断: 对比 data/bias.json 与本脚本重算的 in-sample bias 表 (定位 50% vs 23% 差异)
console.log(`\n===== 诊断: bias.json vs 重算 in-sample bias 对比 =====`);
const biasJson = JSON.parse(readFileSync(path.join(process.cwd(), "data", "bias.json"), "utf-8")) as Record<
  string,
  { bias: number; n: number }
>;
const recompute = biasTable(-1);
const jsonKeys = Object.keys(biasJson);
const reKeys = Object.keys(recompute);
console.log(`  bias.json keys: ${jsonKeys.length}, 重算 keys: ${reKeys.length}`);
const diffs: Array<{ key: string; jb: number; rb: number; jn: number; rn: number }> = [];
for (const k of new Set([...jsonKeys, ...reKeys])) {
  const j = biasJson[k]?.bias;
  const r = recompute[k]?.bias;
  if (j !== r) diffs.push({ key: k, jb: j ?? NaN, rb: r ?? NaN, jn: biasJson[k]?.n ?? 0, rn: recompute[k]?.n ?? 0 });
}
console.log(`  bias 值不同的 key: ${diffs.length}`);
diffs
  .slice(0, 25)
  .forEach((d) =>
    console.log(`    ${d.key.padEnd(28)} json bias=${String(d.jb).padStart(6)} n=${String(d.jn).padStart(3)}  | 重算 bias=${String(d.rb).padStart(6)} n=${String(d.rn).padStart(3)}`),
  );
