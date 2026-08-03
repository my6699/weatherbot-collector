/* 优化回测: 资金管理 + 选桶方案对比 (2026-08-03)
 *
 * 基于现有逻辑 (applyBias + p 排序), 验证几个优化的 PnL 影响:
 *   1. 城市黑名单 (排除 Tokyo/Toronto 0% 命中率城市)
 *   2. horizon 仓位加权 (D+0 重仓, D+1 轻仓)
 *   3. 单桶 vs 多桶 (top1 vs top1+2+3)
 *   4. bias 置信度 (n>=8 vs n<8 命中率)
 *   5. entry 上限收紧 (MAX_PRICE 0.45 vs 0.25 的理论效果)
 *
 * 假设 entry = $0.15 (接近旧策略均价 0.158, 在 MIN_ASK 0.10 ~ MAX_PRICE 0.25 之间)
 * 实际 entry 因盘口而异, 这里用统一值做相对对比.
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
const ENTRY = 0.15; // 假设 entry
const COST = 20; // 单桶成本

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
}

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
  });
}

function pnl(hit: boolean, cost: number, entry: number): number {
  return hit ? cost * (1 / entry - 1) : -cost;
}
function sum(arr: number[]) {
  return arr.reduce((a, b) => a + b, 0);
}

console.log(`===== 基线: 现有逻辑, 单桶 top1, entry $${ENTRY}, 成本 $${COST} =====`);
const baseHits = picks.filter((p) => p.top1Hit).length;
const basePnl = sum(picks.map((p) => pnl(p.top1Hit, COST, ENTRY)));
console.log(`  样本 ${picks.length} | 命中 ${baseHits} (${((baseHits / picks.length) * 100).toFixed(1)}%) | PnL $${basePnl.toFixed(0)}`);

// 1. 城市黑名单
console.log(`\n===== 优化1: 城市黑名单 (排除命中率 0% 的 Tokyo/Toronto) =====`);
const blacklist = new Set(["tokyo", "toronto"]);
const blPicks = picks.filter((p) => !blacklist.has(p.city));
const blHits = blPicks.filter((p) => p.top1Hit).length;
const blPnl = sum(blPicks.map((p) => pnl(p.top1Hit, COST, ENTRY)));
console.log(`  样本 ${blPicks.length} (排除 ${picks.length - blPicks.length}) | 命中 ${blHits} (${((blHits / blPicks.length) * 100).toFixed(1)}%) | PnL $${blPnl.toFixed(0)}`);
console.log(`  vs 基线: PnL ${blPnl - basePnl >= 0 ? "+" : ""}$${(blPnl - basePnl).toFixed(0)} (省下黑名单城市的亏损)`);

// 2. horizon 仓位加权
console.log(`\n===== 优化2: horizon 仓位加权 (D+0 重仓 1.5x, D+1 标准 1.0x) =====`);
const wPnl = sum(
  picks.map((p) => {
    const cost = p.horizon === "D+0" ? COST * 1.5 : COST;
    return pnl(p.top1Hit, cost, ENTRY);
  }),
);
const d0Picks = picks.filter((p) => p.horizon === "D+0");
const d1Picks = picks.filter((p) => p.horizon === "D+1");
console.log(`  D+0: ${d0Picks.length}笔 命中${d0Picks.filter((p) => p.top1Hit).length} (${((d0Picks.filter((p) => p.top1Hit).length / d0Picks.length) * 100).toFixed(0)}%) 仓位 1.5x`);
console.log(`  D+1: ${d1Picks.length}笔 命中${d1Picks.filter((p) => p.top1Hit).length} (${((d1Picks.filter((p) => p.top1Hit).length / d1Picks.length) * 100).toFixed(0)}%) 仓位 1.0x`);
console.log(`  加权后 PnL: $${wPnl.toFixed(0)} | vs 基线 $${basePnl.toFixed(0)}: ${wPnl - basePnl >= 0 ? "+" : ""}$${(wPnl - basePnl).toFixed(0)}`);

// 3. 单桶 vs 多桶
console.log(`\n===== 优化3: 单桶 top1 vs 多桶 top3 (成本 3x) =====`);
const s1Pnl = sum(picks.map((p) => pnl(p.top1Hit, COST, ENTRY)));
// 买3桶成本3*COST, 命中只回收1桶(COST/ENTRY), 另2桶归零
const s3Pnl = sum(picks.map((p) => (p.top3HitAny ? COST / ENTRY - 3 * COST : -3 * COST)));
const s3Hits = picks.filter((p) => p.top3HitAny).length;
console.log(`  单桶 top1: 命中 ${baseHits}/${picks.length} (${((baseHits / picks.length) * 100).toFixed(1)}%) | PnL $${s1Pnl.toFixed(0)}`);
console.log(`  多桶 top3: 命中 ${s3Hits}/${picks.length} (${((s3Hits / picks.length) * 100).toFixed(1)}%) | PnL $${s3Pnl.toFixed(0)} (成本3x, 命中只回收1桶)`);
console.log(`  结论: ${s3Pnl > s1Pnl ? "多桶优" : "单桶优"} (差 $${(s3Pnl - s1Pnl).toFixed(0)})`);

// 4. bias 置信度
console.log(`\n===== 优化4: bias 置信度分组 (n>=8 高置信 vs n<8 低置信) =====`);
const hiN = picks.filter((p) => p.biasN >= 8);
const loN = picks.filter((p) => p.biasN < 8);
console.log(`  高置信 (bias n>=8): ${hiN.length}笔 命中${hiN.filter((p) => p.top1Hit).length} (${hiN.length ? ((hiN.filter((p) => p.top1Hit).length / hiN.length) * 100).toFixed(1) : 0}%)`);
console.log(`  低置信 (bias n<8):  ${loN.length}笔 命中${loN.filter((p) => p.top1Hit).length} (${loN.length ? ((loN.filter((p) => p.top1Hit).length / loN.length) * 100).toFixed(0) : 0}%)`);
console.log(`  建议: ${hiN.length && loN.length && hiN.filter((p) => p.top1Hit).length / hiN.length > loN.filter((p) => p.top1Hit).length / loN.length ? "低置信城市降仓位或暂停" : "置信度差异不明显"}`);

// 5. 组合优化
console.log(`\n===== 优化5: 组合 (黑名单 + horizon加权 + 单桶) =====`);
const combo = picks.filter((p) => !blacklist.has(p.city));
const comboPnl = sum(
  combo.map((p) => {
    const cost = p.horizon === "D+0" ? COST * 1.5 : COST;
    return pnl(p.top1Hit, cost, ENTRY);
  }),
);
const comboHits = combo.filter((p) => p.top1Hit).length;
console.log(`  样本 ${combo.length} | 命中 ${comboHits} (${((comboHits / combo.length) * 100).toFixed(1)}%) | PnL $${comboPnl.toFixed(0)}`);
console.log(`  vs 基线 PnL $${basePnl.toFixed(0)}: ${comboPnl - basePnl >= 0 ? "+" : ""}$${(comboPnl - basePnl).toFixed(0)} (${(((comboPnl - basePnl) / Math.abs(basePnl)) * 100).toFixed(0)}%)`);

// 6. p 分级仓位 (替代固定 $20, 让高 p 桶下重注)
// 注: 固定 entry 假设下 Kelly 公式会触顶失去分级作用, 改用 p 分级更直观
console.log(`\n===== 优化6: p 分级仓位 (高 p 大仓, 低 p 小仓, 替代固定 $${COST}) =====`);
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
const tierPnl = sum(tierPicks.map((p) => pnl(p.top1Hit, p.cost, ENTRY)));
for (const t of tiers) {
  const g = tierPicks.filter((p) => p.tier === t.label);
  const hits = g.filter((p) => p.top1Hit).length;
  console.log(`  ${t.label} ($${t.cost}): ${g.length}笔 命中${hits} (${g.length ? ((hits / g.length) * 100).toFixed(0) : 0}%)`);
}
console.log(`  分级仓位 PnL: $${tierPnl.toFixed(0)} | vs 固定 $${COST} PnL $${basePnl.toFixed(0)}: ${tierPnl - basePnl >= 0 ? "+" : ""}$${(tierPnl - basePnl).toFixed(0)}`);

// 7. MAX_PRICE 收紧理论效果
console.log(`\n===== 优化7: MAX_PRICE 收紧 (按 top1 p 估算市场定价, 过滤高价桶) =====`);
console.log(`  (注: 无法用 all_outcomes 准确回测, 给理论分析)`);
console.log(`  命中率 50% (in-sample) / 28% (LOO)`);
console.log(`  - MAX_PRICE=0.45: 盈亏平衡 45%, 需命中率>45%才赚 (只有 in-sample 50% 勉强过)`);
console.log(`  - MAX_PRICE=0.25: 盈亏平衡 25%, LOO 28% 仍正期望, 安全垫 3 个百分点`);
console.log(`  - MAX_PRICE=0.20: 盈亏平衡 20%, LOO 28% 安全垫 8 个百分点, 但入场数减少`);
console.log(`  建议: MAX_PRICE 0.45 -> 0.25, 配合 MIN_EDGE 过滤, 砍掉贵且低 edge 的桶`);
