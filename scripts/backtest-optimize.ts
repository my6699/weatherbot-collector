/* 优化回测: 资金管理 + 选桶方案对比 (2026-08-03)
 *
 * 关键修正 (2026-08-03): 原版写死 ENTRY=0.15 (接近旧策略均价), 但新策略按 p
 * 选 top1 热桶, 真实 entry 远高于此 (market_snapshots.top_price 中位 $0.435,
 * 最低 $0.215). 用 $0.15 算出的 PnL 严重虚高. 现改为从 market_snapshots 取
 * 开仓时点的 top_price 作为模型 top1 桶的 entry.
 *
 * 数据局限: market_snapshots 只存市场最热桶 (top_bucket) 的价格, 没存每个桶
 * 的 ask. 因此 top_price 是模型 top1 桶 entry 的【上界】(模型 top1 价 <=
 * 市场最热价). 全样本 PnL 用上界 entry 是保守下界; 模型 top1 == 市场 top
 * 的一致子集 entry 准确, PnL 最可信. 两者都报告.
 *
 * Run: npx tsx scripts/backtest-optimize.ts
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { bucketProb, inBucket } from "../src/math.js";

const DIR = path.join(process.cwd(), "data", "markets");
const BIAS_FILE = path.join(process.cwd(), "data", "bias.json");
const BIAS_MAX_C = 2.0;
const BIAS_SHRINK_N = 4;
const BIAS_MIN_N = 2;
const COST = 20; // 单桶成本
const ENTRY_OLD = 0.15; // 旧假设, 仅用于对比展示

const biasTable: Record<string, { bias: number; n: number }> = JSON.parse(
  readFileSync(BIAS_FILE, "utf-8"),
);
function biasKey(c: string, h: string, s: string) {
  return `${c}|${h}|${s.toLowerCase()}`;
}
function getBias(c: string, h: string, s: string, unit: "F" | "C"): { bias: number; n: number } {
  const e = biasTable[biasKey(c, h, s)];
  if (!e || e.n < BIAS_MIN_N) return { bias: 0, n: 0 };
  const shrink = Math.min(1, e.n / BIAS_SHRINK_N);
  const cap = unit === "F" ? BIAS_MAX_C * 1.8 : BIAS_MAX_C;
  const capped = Math.max(-cap, Math.min(cap, e.bias));
  return { bias: Math.round(capped * shrink * 1000) / 1000, n: e.n };
}
function applyBias(fc: number, c: string, h: string, s: string, unit: "F" | "C"): number {
  const { bias } = getBias(c, h, s, unit);
  return bias === 0 ? fc : Math.round((fc - bias) * 100) / 100;
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

interface Pick {
  city: string;
  city_name: string;
  date: string;
  horizon: string;
  unit: "F" | "C";
  adjFc: number;
  sigma: number;
  biasN: number;
  actual: number;
  top1: [number, number];
  top1Hit: boolean;
  top3: Array<{ range: [number, number]; p: number }>;
  top3HitAny: boolean;
  realEntry: number; // market_snapshots.top_price (开仓时点), 模型 top1 entry 上界
  isTopMatch: boolean; // 模型 top1 == 市场 top (此子集 realEntry 准确)
}

let noQuote = 0;
const picks: Pick[] = [];
for (const m of markets) {
  if (m.actual_temp == null) continue;
  const pos = m.positions?.[0] ?? m.position;
  const snaps = m.forecast_snapshots ?? [];
  if (snaps.length === 0) continue;
  let snap = pos?.opened_at ? snaps.find((s) => s.ts === pos.opened_at) : undefined;
  if (!snap) snap = snaps[0];
  if (!snap || snap.best == null) continue;
  const sigma = pos?.sigma ?? (m.unit === "C" ? 2.3 : 1.7);
  const horizon = snap.horizon ?? "D+0";
  const rawSrc = pos?.forecast_src ?? snap.best_source ?? "best";
  const source = rawSrc === "ensemble" ? "best" : rawSrc.toLowerCase();
  const { n: biasN } = getBias(m.city, horizon, source, m.unit);
  const adjFc = applyBias(snap.best, m.city, horizon, source, m.unit);
  const cands = (m.all_outcomes ?? [])
    .map((o) => ({ range: o.range, p: bucketProb(adjFc, o.range[0], o.range[1], sigma) }))
    .sort((a, b) => b.p - a.p);
  if (cands.length === 0) continue;
  const top1 = cands[0]!;
  // 真实 entry: 开仓时点 market_snapshot 的 top_price (市场最热桶价 = 模型 top1 上界)
  const snapTs = snap.ts;
  const msnap = (m.market_snapshots ?? []).find((s) => s.ts === snapTs);
  if (!msnap || msnap.top_price == null) {
    noQuote++;
    continue;
  }
  const mLow = msnap.top_bucket?.match(/(-?\d+)/);
  const marketTopLow = mLow ? parseInt(mLow[1]!) : null;
  const isTopMatch = marketTopLow != null && marketTopLow === top1.range[0];
  const top3 = cands.slice(0, 3);
  picks.push({
    city: m.city,
    city_name: m.city_name,
    date: m.date,
    horizon,
    unit: m.unit,
    adjFc,
    sigma,
    biasN,
    actual: m.actual_temp,
    top1: top1.range,
    top1Hit: inBucket(m.actual_temp, top1.range[0], top1.range[1]),
    top3,
    top3HitAny: top3.some((t) => inBucket(m.actual_temp, t.range[0], t.range[1])),
    realEntry: msnap.top_price,
    isTopMatch,
  });
}

function pnl(hit: boolean, cost: number, entry: number): number {
  return hit ? cost * (1 / entry - 1) : -cost;
}
function sum(arr: number[]) {
  return arr.reduce((a, b) => a + b, 0);
}
function mean(arr: number[]): number {
  return arr.length ? sum(arr) / arr.length : 0;
}
function dist(arr: number[], label: string) {
  arr.sort((a, b) => a - b);
  const n = arr.length;
  if (n === 0) {
    console.log(`  ${label}: 无数据`);
    return;
  }
  const q = (p: number) => arr[Math.floor(n * p)]!;
  const b: Record<string, number> = {
    "<0.20": 0,
    "0.20-0.25": 0,
    "0.25-0.30": 0,
    "0.30-0.40": 0,
    "0.40-0.50": 0,
    ">=0.50": 0,
  };
  for (const v of arr) {
    if (v < 0.2) b["<0.20"]!++;
    else if (v < 0.25) b["0.20-0.25"]!++;
    else if (v < 0.3) b["0.25-0.30"]!++;
    else if (v < 0.4) b["0.30-0.40"]!++;
    else if (v < 0.5) b["0.40-0.50"]!++;
    else b[">=0.50"]!++;
  }
  console.log(
    `  ${label}: n=${n} | min ${arr[0]!.toFixed(3)} | p25 ${q(0.25).toFixed(3)} | 中位 ${q(0.5).toFixed(3)} | 均值 ${mean(arr).toFixed(3)} | p75 ${q(0.75).toFixed(3)} | max ${arr[n - 1]!.toFixed(3)}`,
  );
  console.log(
    `    分布: ${Object.entries(b).map(([k, v]) => `${k}:${v}(${((v / n) * 100).toFixed(0)}%)`).join("  ")}`,
  );
}

console.log(`===== 真实 entry 来源说明 =====`);
console.log(`  market_snapshots.top_price (开仓时点市场最热桶价) = 模型 top1 桶 entry【上界】`);
console.log(`  模型 top1 价 <= 市场最热价, 故全样本 PnL 为保守下界, 真实 PnL >= 此值`);
console.log(`  无盘口跳过: ${noQuote} 个市场`);

console.log(`\n===== entry 分布 + 模型/市场 top 一致率 =====`);
dist(picks.map((p) => p.realEntry), "realEntry (top_price 上界)");
const matchN = picks.filter((p) => p.isTopMatch).length;
console.log(
  `  模型 top1 == 市场 top: ${matchN}/${picks.length} (${picks.length ? ((matchN / picks.length) * 100).toFixed(0) : 0}%)  <- 此子集 entry 准确, PnL 最可信`,
);

const baseHits = picks.filter((p) => p.top1Hit).length;
const basePnl = sum(picks.map((p) => pnl(p.top1Hit, COST, p.realEntry)));
const basePnlOld = sum(picks.map((p) => pnl(p.top1Hit, COST, ENTRY_OLD)));
console.log(`\n===== 基线: 单桶 top1, 真实 entry (上界, 保守) =====`);
console.log(
  `  样本 ${picks.length} | 命中 ${baseHits} (${picks.length ? ((baseHits / picks.length) * 100).toFixed(1) : 0}%) | PnL $${basePnl.toFixed(0)} (entry 上界)`,
);
console.log(
  `  对比: 旧假设 entry=$${ENTRY_OLD} 时 PnL $${basePnlOld.toFixed(0)}  <- ${basePnlOld > basePnl ? "虚高" : "偏低"} $${Math.abs(basePnlOld - basePnl).toFixed(0)}`,
);

// 一致子集 (entry 准确, 最可信) vs 不一致子集 (entry 仍为上界)
const matchPicks = picks.filter((p) => p.isTopMatch);
const mismatchPicks = picks.filter((p) => !p.isTopMatch);
const matchHits = matchPicks.filter((p) => p.top1Hit).length;
const matchPnl = sum(matchPicks.map((p) => pnl(p.top1Hit, COST, p.realEntry)));
const mismatchHits = mismatchPicks.filter((p) => p.top1Hit).length;
const mismatchPnl = sum(mismatchPicks.map((p) => pnl(p.top1Hit, COST, p.realEntry)));
console.log(`\n===== 一致子集: 模型 top1 == 市场 top (entry 准确, 最可信) =====`);
console.log(
  `  样本 ${matchPicks.length} | 命中 ${matchHits} (${matchPicks.length ? ((matchHits / matchPicks.length) * 100).toFixed(1) : 0}%) | PnL $${matchPnl.toFixed(0)}`,
);
dist(matchPicks.map((p) => p.realEntry), "一致子集 entry");
console.log(`  不一致子集 (entry 仍为上界, 实际 entry 更低 -> 真实 PnL 更高):`);
console.log(
  `    样本 ${mismatchPicks.length} | 命中 ${mismatchHits} (${mismatchPicks.length ? ((mismatchHits / mismatchPicks.length) * 100).toFixed(1) : 0}%) | PnL(上界) $${mismatchPnl.toFixed(0)}`,
);

// 1. 城市黑名单
console.log(`\n===== 优化1: 城市黑名单 (排除 Tokyo/Toronto, 真实 entry) =====`);
const blacklist = new Set(["tokyo", "toronto"]);
const blPicks = picks.filter((p) => !blacklist.has(p.city));
const blHits = blPicks.filter((p) => p.top1Hit).length;
const blPnl = sum(blPicks.map((p) => pnl(p.top1Hit, COST, p.realEntry)));
console.log(
  `  样本 ${blPicks.length} (排除 ${picks.length - blPicks.length}) | 命中 ${blHits} (${blPicks.length ? ((blHits / blPicks.length) * 100).toFixed(1) : 0}%) | PnL $${blPnl.toFixed(0)}`,
);
console.log(`  vs 基线: PnL ${blPnl - basePnl >= 0 ? "+" : ""}$${(blPnl - basePnl).toFixed(0)}`);

// 2. horizon 仓位加权
console.log(`\n===== 优化2: horizon 仓位加权 (D+0 重仓 1.5x, D+1 标准 1.0x, 真实 entry) =====`);
const wPnl = sum(
  picks.map((p) => {
    const cost = p.horizon === "D+0" ? COST * 1.5 : COST;
    return pnl(p.top1Hit, cost, p.realEntry);
  }),
);
const d0Picks = picks.filter((p) => p.horizon === "D+0");
const d1Picks = picks.filter((p) => p.horizon === "D+1");
console.log(
  `  D+0: ${d0Picks.length}笔 命中${d0Picks.filter((p) => p.top1Hit).length} (${d0Picks.length ? ((d0Picks.filter((p) => p.top1Hit).length / d0Picks.length) * 100).toFixed(0) : 0}%) 仓位1.5x | entry均$${mean(d0Picks.map((p) => p.realEntry)).toFixed(3)}`,
);
console.log(
  `  D+1: ${d1Picks.length}笔 命中${d1Picks.filter((p) => p.top1Hit).length} (${d1Picks.length ? ((d1Picks.filter((p) => p.top1Hit).length / d1Picks.length) * 100).toFixed(0) : 0}%) 仓位1.0x | entry均$${mean(d1Picks.map((p) => p.realEntry)).toFixed(3)}`,
);
console.log(`  加权后 PnL: $${wPnl.toFixed(0)} | vs 基线 $${basePnl.toFixed(0)}: ${wPnl - basePnl >= 0 ? "+" : ""}$${(wPnl - basePnl).toFixed(0)}`);

// 3. 单桶 vs 多桶
console.log(`\n===== 优化3: 单桶 top1 vs 多桶 top3 (真实 entry; 多桶回收桶 entry 用 top_price 上界近似) =====`);
const s1Pnl = sum(picks.map((p) => pnl(p.top1Hit, COST, p.realEntry)));
// 多桶: 买3桶成本3*COST, 命中只回收1桶; 回收桶 entry 用 top_price 上界 (实际命中桶可能更便宜)
const s3Pnl = sum(picks.map((p) => (p.top3HitAny ? COST / p.realEntry - 3 * COST : -3 * COST)));
const s3Hits = picks.filter((p) => p.top3HitAny).length;
console.log(
  `  单桶 top1: 命中 ${baseHits}/${picks.length} (${picks.length ? ((baseHits / picks.length) * 100).toFixed(1) : 0}%) | PnL $${s1Pnl.toFixed(0)}`,
);
console.log(
  `  多桶 top3: 命中 ${s3Hits}/${picks.length} (${picks.length ? ((s3Hits / picks.length) * 100).toFixed(1) : 0}%) | PnL $${s3Pnl.toFixed(0)} (成本3x, 回收桶 entry 用上界)`,
);
console.log(`  结论: ${s3Pnl > s1Pnl ? "多桶优" : "单桶优"} (差 $${(s3Pnl - s1Pnl).toFixed(0)})`);

// 4. bias 置信度
console.log(`\n===== 优化4: bias 置信度分组 (n>=8 高置信 vs n<8 低置信, 真实 entry) =====`);
const hiN = picks.filter((p) => p.biasN >= 8);
const loN = picks.filter((p) => p.biasN < 8);
const hiHits = hiN.filter((p) => p.top1Hit).length;
const loHits = loN.filter((p) => p.top1Hit).length;
console.log(
  `  高置信 (n>=8): ${hiN.length}笔 命中${hiHits} (${hiN.length ? ((hiHits / hiN.length) * 100).toFixed(1) : 0}%) | entry均$${mean(hiN.map((p) => p.realEntry)).toFixed(3)} | PnL $${sum(hiN.map((p) => pnl(p.top1Hit, COST, p.realEntry))).toFixed(0)}`,
);
console.log(
  `  低置信 (n<8):  ${loN.length}笔 命中${loHits} (${loN.length ? ((loHits / loN.length) * 100).toFixed(0) : 0}%) | entry均$${mean(loN.map((p) => p.realEntry)).toFixed(3)} | PnL $${sum(loN.map((p) => pnl(p.top1Hit, COST, p.realEntry))).toFixed(0)}`,
);

// 5. 组合
console.log(`\n===== 优化5: 组合 (黑名单 + horizon加权 + 单桶, 真实 entry) =====`);
const combo = picks.filter((p) => !blacklist.has(p.city));
const comboPnl = sum(
  combo.map((p) => {
    const cost = p.horizon === "D+0" ? COST * 1.5 : COST;
    return pnl(p.top1Hit, cost, p.realEntry);
  }),
);
const comboHits = combo.filter((p) => p.top1Hit).length;
console.log(
  `  样本 ${combo.length} | 命中 ${comboHits} (${combo.length ? ((comboHits / combo.length) * 100).toFixed(1) : 0}%) | PnL $${comboPnl.toFixed(0)}`,
);
console.log(`  vs 基线 PnL $${basePnl.toFixed(0)}: ${comboPnl - basePnl >= 0 ? "+" : ""}$${(comboPnl - basePnl).toFixed(0)}`);

// 6. p 分级仓位
console.log(`\n===== 优化6: p 分级仓位 (高 p 大仓, 低 p 小仓, 真实 entry) =====`);
const tiers = [
  { label: "p>=0.30 重仓", min: 0.3, cost: 40 },
  { label: "p 0.20-0.30 标准", min: 0.2, cost: 20 },
  { label: "p<0.20 轻仓", min: 0, cost: 10 },
];
const tierPicks = picks.map((p) => {
  const prob = bucketProb(p.adjFc, p.top1[0], p.top1[1], p.sigma);
  const tier = tiers.find((t) => prob >= t.min)!;
  return { ...p, prob, cost: tier.cost, tier: tier.label };
});
const tierPnl = sum(tierPicks.map((p) => pnl(p.top1Hit, p.cost, p.realEntry)));
for (const t of tiers) {
  const g = tierPicks.filter((p) => p.tier === t.label);
  const hits = g.filter((p) => p.top1Hit).length;
  const gPnl = sum(g.map((p) => pnl(p.top1Hit, p.cost, p.realEntry)));
  console.log(
    `  ${t.label} ($${t.cost}): ${g.length}笔 命中${hits} (${g.length ? ((hits / g.length) * 100).toFixed(0) : 0}%) | entry均$${mean(g.map((p) => p.realEntry)).toFixed(3)} | PnL $${gPnl.toFixed(0)}`,
  );
}
console.log(`  分级仓位 PnL: $${tierPnl.toFixed(0)} | vs 固定 $${COST} PnL $${basePnl.toFixed(0)}: ${tierPnl - basePnl >= 0 ? "+" : ""}$${(tierPnl - basePnl).toFixed(0)}`);

// 7. MAX_PRICE 实测 (按 realEntry 上界分档)
console.log(`\n===== 优化7: MAX_PRICE 实测 (按 realEntry 上界分档, 看真实可入场样本) =====`);
console.log(`  (entry 上界; 实际模型 top1 价 <= 上界, 真实可入场样本数 >= 此处统计)`);
for (const cap of [0.25, 0.3, 0.35, 0.45, 0.6]) {
  const g = picks.filter((p) => p.realEntry <= cap);
  const hits = g.filter((p) => p.top1Hit).length;
  const gPnl = sum(g.map((x) => pnl(x.top1Hit, COST, x.realEntry)));
  console.log(
    `  MAX_PRICE<=${cap.toFixed(2)}: 样本${g.length}(${picks.length ? ((g.length / picks.length) * 100).toFixed(0) : 0}%) 命中${hits}(${g.length ? ((hits / g.length) * 100).toFixed(0) : 0}%) PnL$${gPnl.toFixed(0)}`,
  );
}
console.log(
  `  全量 (无上限): 样本${picks.length} 命中${baseHits}(${picks.length ? ((baseHits / picks.length) * 100).toFixed(0) : 0}%) PnL$${basePnl.toFixed(0)}`,
);
