/**
 * D-2 复检策略验证：2桶区间命中率 + D-0情绪溢价 + ENS成员校准
 *
 * 核心验证问题:
 *   1. D-2 预报均值选的 2 个相邻桶，实际命中率是多少？(vs 1桶)
 *   2. D-0 时"被命中桶"的 YES 价格分布是怎样的？(情绪溢价是否存在)
 *   3. D-2 时 ENS 成员(模拟)落在区间的比例 vs 最终命中关系(校准曲线)
 *   4. D-2 → D-0 预报漂移有多大？(复检能否提前发现问题)
 *
 * Run: npx tsx scripts/backtest-d2-review.ts
 */

import { readdirSync, readFileSync } from "fs";
import path from "path";
import { LOCATIONS } from "../src/config.js";
import { inBucket } from "../src/math.js";

interface OutcomeRow {
  range: [number, number];
  bid: number;
  ask: number;
  volume: number;
}

interface EnsSnapshot {
  models: Record<string, number>;
  mean: number;
  spread: number;
  gap: number;
  membersMax?: number[];
}

interface ForecastSnap {
  ts: string;
  horizon?: string;
  hours_left?: number;
  ecmwf?: number | null;
  hrrr?: number | null;
  metar?: number | null;
  best?: number | null;
  ens?: EnsSnapshot | null;
}

interface MarketSnap {
  ts: string;
  top_bucket: string | null;
  top_price: number | null;
}

interface MarketRecord {
  city: string;
  city_name: string;
  date: string;
  unit: "F" | "C";
  status: string;
  actual_temp: number | null;
  forecast_snapshots: ForecastSnap[];
  market_snapshots: MarketSnap[];
  all_outcomes: OutcomeRow[];
}

const MARKETS_DIR = path.join(process.cwd(), "data", "markets");

function loadAllMarkets(): MarketRecord[] {
  const markets: MarketRecord[] = [];
  for (const f of readdirSync(MARKETS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      markets.push(JSON.parse(readFileSync(path.join(MARKETS_DIR, f), "utf-8")));
    } catch {
      /* skip */
    }
  }
  return markets;
}

/** Box-Muller 正态随机 (确定性种子) */
let seed = 42;
function randn(): number {
  seed = (seed * 9301 + 49297) % 233280;
  const u1 = Math.max(0.0001, seed / 233280);
  seed = (seed * 9301 + 49297) % 233280;
  const u2 = seed / 233280;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** 用3个模型值 + spread 模拟 51 个 ENS 成员 */
function simulateMembers(ens: EnsSnapshot | null): number[] {
  if (!ens) return [];
  // 如果有真实 membersMax, 直接用
  if (ens.membersMax && ens.membersMax.length > 0) return ens.membersMax;
  // 否则用3个模型值作为锚点, 加正态扰动模拟51个成员
  const modelValues = Object.values(ens.models).filter((v) => v != null) as number[];
  if (modelValues.length === 0) return [];
  const mean = ens.mean;
  const sigma = Math.max(0.8, ens.spread / 2);
  const members: number[] = [];
  for (let i = 0; i < 51; i++) {
    members.push(Math.round((mean + randn() * sigma) * 10) / 10);
  }
  return members;
}

/** 统计成员落在区间内的比例 */
function memberFractionInInterval(members: number[], low: number, high: number): number {
  if (members.length === 0) return -1;
  let hits = 0;
  for (const m of members) {
    if (m >= low && m <= high) hits++;
  }
  return hits / members.length;
}

/** 找指定 hours_left 范围内的快照 */
function findSnapshot(snaps: ForecastSnap[], minHours: number, maxHours: number): ForecastSnap | null {
  let best: ForecastSnap | null = null;
  let bestDiff = Infinity;
  for (const s of snaps) {
    const h = s.hours_left ?? 999;
    if (h >= minHours && h <= maxHours) {
      const diff = Math.abs(h - (minHours + maxHours) / 2);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = s;
      }
    }
  }
  return best;
}

/** 找最接近指定 hours_left 的市场快照 */
function findMarketSnap(snaps: MarketSnap[], maxHours: number): MarketSnap | null {
  // market_snapshots 没有 hours_left, 用 ts 时间差近似
  // 我们在调用时传入 D-0 的参考时间
  return snaps.length > 0 ? snaps[snaps.length - 1] : null;
}

/** 从 all_outcomes 中找均值附近的 2 个相邻桶 */
function selectTwoBuckets(
  outcomes: OutcomeRow[],
  forecast: number,
): [OutcomeRow, OutcomeRow] | null {
  // 过滤掉 "or below" / "or higher" 的极端桶
  const normal = outcomes.filter((o) => o.range[0] !== -999 && o.range[1] !== 999);
  if (normal.length < 2) return null;

  // 按到 forecast 的距离排序
  const withDist = normal.map((o) => {
    const mid = (o.range[0] + o.range[1]) / 2;
    return { o, dist: Math.abs(mid - forecast) };
  });
  withDist.sort((a, b) => a.dist - b.dist);

  // Polymarket 桶有 1° 间隔 (如 74-75, 76-77), 相邻 = high+1 === next.low
  const isAdjacent = (a: OutcomeRow, b: OutcomeRow): boolean =>
    a.range[1] + 1 === b.range[0] || b.range[1] + 1 === a.range[0];

  const first = withDist[0]!;
  // 取最近的 2 个, 确保它们是相邻的
  const second = withDist[1]!;
  if (isAdjacent(first.o, second.o)) return [first.o, second.o];
  // 找 first 的相邻桶
  for (const w of withDist) {
    if (w.o === first.o) continue;
    if (isAdjacent(first.o, w.o)) return [first.o, w.o];
  }
  return null;
}

function main(): void {
  const markets = loadAllMarkets();
  const resolved = markets.filter((m) => m.status === "resolved" && m.actual_temp != null);
  console.log(`[BACKTEST] ${resolved.length} resolved markets (total ${markets.length})`);

  interface Record {
    city: string;
    date: string;
    unit: string;
    actual: number;
    // D-2 数据
    d2_forecast: number;
    d2_spread: number;
    d2_gap: number;
    d2_hours_left: number;
    d2_bucket_low: number;
    d2_bucket_high: number;
    d2_1bucket_hit: boolean;
    d2_2bucket_hit: boolean;
    d2_member_fraction: number;
    // D-0 数据
    d0_forecast: number | null;
    d0_drift: number; // |D0 - D2|
    d0_top_price: number | null;
    d0_hit_bucket_price: number | null; // 实际命中桶在D-0的YES价格
    d0_2bucket_sum_price: number | null; // 2个桶在D-0的YES价格之和
    has_real_members: boolean;
  }

  const records: Record[] = [];
  const hoursLeftDist: number[] = [];

  for (const m of resolved) {
    if (m.actual_temp == null) continue;
    const actual = m.actual_temp;
    const snaps = m.forecast_snapshots ?? [];
    if (snaps.length < 2) continue;

    // 统计 hours_left 分布
    for (const s of snaps) {
      if (s.hours_left != null) hoursLeftDist.push(s.hours_left);
    }

    // 用最早的快照作为"进场预报" (大部分市场在 D+1 发现, hours_left~32)
    // 如果有 hours_left >= 36 的快照就用它 (真正的 D-2), 否则用最早的
    const d2Snap = findSnapshot(snaps, 36, 96) ?? snaps[0];
    if (!d2Snap) continue;

    // 兼容旧数据: 优先 ens.mean, 回退到 best/ecmwf
    const d2Forecast = d2Snap.ens?.mean ?? d2Snap.best ?? d2Snap.ecmwf ?? null;
    if (d2Forecast == null) continue;
    const d2Spread = d2Snap.ens?.spread ?? Math.abs((d2Snap.ecmwf ?? 0) - (d2Snap.hrrr ?? 0)) / 2 ?? 2;
    const d2Gap = d2Snap.ens?.gap ?? Math.abs((d2Snap.ecmwf ?? 0) - (d2Snap.hrrr ?? 0)) ?? 0;

    // 选 2 个相邻桶
    const buckets = selectTwoBuckets(m.all_outcomes ?? [], d2Forecast);
    if (!buckets) continue;
    const [b1, b2] = buckets;
    const intervalLow = Math.min(b1.range[0], b2.range[0]);
    const intervalHigh = Math.max(b1.range[1], b2.range[1]);

    // 1桶命中率 (只用最近的桶)
    const singleHit = inBucket(actual, b1.range[0], b1.range[1]);
    // 2桶命中率
    const doubleHit = inBucket(actual, intervalLow, intervalHigh);

    // 模拟 ENS 成员在区间的比例
    const members = simulateMembers(d2Snap.ens);
    const memberFrac = memberFractionInInterval(members, intervalLow, intervalHigh);
    const hasRealMembers = !!(d2Snap.ens?.membersMax && d2Snap.ens.membersMax.length > 0);

    // 找 D-0 快照 (hours_left < 12)
    const d0Snap = findSnapshot(snaps, 0, 12);
    const d0Forecast = d0Snap?.ens?.mean ?? d0Snap?.best ?? d0Snap?.ecmwf ?? null;
    const d0Drift = d0Forecast != null ? Math.abs(d0Forecast - d2Forecast) : 0;

    // D-0 市场价格: 找命中桶的 YES 价格
    let d0HitPrice: number | null = null;
    let d0TwoBucketSum: number | null = null;
    // market_snapshots 的最后一个通常是最接近 D-0 的
    const mSnaps = m.market_snapshots ?? [];
    if (mSnaps.length > 0) {
      const lastSnap = mSnaps[mSnaps.length - 1];
      d0HitPrice = lastSnap?.top_price ?? null;
    }
    // 用 all_outcomes 的最新价格近似 D-0
    if (m.all_outcomes && m.all_outcomes.length > 0) {
      // 找命中桶的价格
      for (const o of m.all_outcomes) {
        if (inBucket(actual, o.range[0], o.range[1])) {
          if (o.ask > 0.001) d0HitPrice = o.ask;
        }
      }
      // 2桶价格之和
      const p1 = b1.ask;
      const p2 = b2.ask;
      d0TwoBucketSum = p1 + p2;
    }

    records.push({
      city: m.city_name,
      date: m.date,
      unit: m.unit,
      actual,
      d2_forecast: d2Forecast,
      d2_spread: d2Spread,
      d2_gap: d2Gap,
      d2_hours_left: d2Snap.hours_left ?? 0,
      d2_bucket_low: intervalLow,
      d2_bucket_high: intervalHigh,
      d2_1bucket_hit: singleHit,
      d2_2bucket_hit: doubleHit,
      d2_member_fraction: memberFrac,
      d0_forecast: d0Forecast,
      d0_drift: d0Drift,
      d0_top_price: d0HitPrice,
      d0_hit_bucket_price: d0HitPrice,
      d0_2bucket_sum_price: d0TwoBucketSum,
      has_real_members: hasRealMembers,
    });
  }

  console.log(`[BACKTEST] ${records.length} records with entry snapshot data\n`);

  // === 0. 快照时间分布 (了解数据局限) ===
  console.log("=".repeat(70));
  console.log("0. 进场快照时间分布 (hours_left)");
  console.log("=".repeat(70));
  if (hoursLeftDist.length > 0) {
    hoursLeftDist.sort((a, b) => a - b);
    const over48 = hoursLeftDist.filter((h) => h >= 48).length;
    const over36 = hoursLeftDist.filter((h) => h >= 36).length;
    const over24 = hoursLeftDist.filter((h) => h >= 24).length;
    console.log(`   总快照数: ${hoursLeftDist.length}`);
    console.log(`   hours_left >= 48 (D-2): ${over48} (${((over48 / hoursLeftDist.length) * 100).toFixed(1)}%)`);
    console.log(`   hours_left >= 36 (D-1.5): ${over36} (${((over36 / hoursLeftDist.length) * 100).toFixed(1)}%)`);
    console.log(`   hours_left >= 24 (D-1): ${over24} (${((over24 / hoursLeftDist.length) * 100).toFixed(1)}%)`);
    console.log(`   中位数: ${hoursLeftDist[Math.floor(hoursLeftDist.length / 2)]!.toFixed(1)}h`);
    console.log(`   范围: ${hoursLeftDist[0]!.toFixed(1)}h - ${hoursLeftDist[hoursLeftDist.length - 1]!.toFixed(1)}h`);
    const entryHours = records.map((r) => r.d2_hours_left);
    entryHours.sort((a, b) => a - b);
    if (entryHours.length > 0) {
      console.log(`   进场快照 hours_left 中位数: ${entryHours[Math.floor(entryHours.length / 2)]!.toFixed(1)}h`);
    }
  }

  // === 1. 1桶 vs 2桶命中率 ===
  console.log("=".repeat(70));
  console.log("1. 1桶 vs 2桶命中率 (D-2 预报选桶)");
  console.log("=".repeat(70));
  const hit1 = records.filter((r) => r.d2_1bucket_hit).length;
  const hit2 = records.filter((r) => r.d2_2bucket_hit).length;
  console.log(`   1桶命中率: ${hit1}/${records.length} = ${((hit1 / records.length) * 100).toFixed(1)}%`);
  console.log(`   2桶命中率: ${hit2}/${records.length} = ${((hit2 / records.length) * 100).toFixed(1)}%`);
  console.log(`   倍数: ${(hit2 / Math.max(1, hit1)).toFixed(2)}x`);

  // === 2. D-0 命中桶 YES 价格分布 ===
  console.log("\n" + "=".repeat(70));
  console.log("2. D-0 命中桶 YES 价格分布 (情绪溢价验证)");
  console.log("=".repeat(70));
  const hitPrices = records
    .filter((r) => r.d0_hit_bucket_price != null && r.d0_hit_bucket_price > 0.01)
    .map((r) => r.d0_hit_bucket_price!);
  if (hitPrices.length > 0) {
    hitPrices.sort((a, b) => a - b);
    const avg = hitPrices.reduce((a, b) => a + b, 0) / hitPrices.length;
    const median = hitPrices[Math.floor(hitPrices.length / 2)]!;
    const p25 = hitPrices[Math.floor(hitPrices.length * 0.25)]!;
    const p75 = hitPrices[Math.floor(hitPrices.length * 0.75)]!;
    const over056 = hitPrices.filter((p) => p > 0.56).length;
    const over070 = hitPrices.filter((p) => p > 0.70).length;
    console.log(`   样本数: ${hitPrices.length}`);
    console.log(`   均值: $${avg.toFixed(3)}`);
    console.log(`   中位数: $${median.toFixed(3)}`);
    console.log(`   P25: $${p25.toFixed(3)}  P75: $${p75.toFixed(3)}`);
    console.log(`   范围: $${hitPrices[0]!.toFixed(3)} - $${hitPrices[hitPrices.length - 1]!.toFixed(3)}`);
    console.log(`   > $0.56 (2桶策略盈利线): ${over056}/${hitPrices.length} = ${((over056 / hitPrices.length) * 100).toFixed(1)}%`);
    console.log(`   > $0.70 (高溢价线): ${over070}/${hitPrices.length} = ${((over070 / hitPrices.length) * 100).toFixed(1)}%`);
  } else {
    console.log("   无有效价格数据");
  }

  // === 3. D-2 → D-0 预报漂移 ===
  console.log("\n" + "=".repeat(70));
  console.log("3. D-2 → D-0 预报漂移 (复检价值验证)");
  console.log("=".repeat(70));
  const drifts = records.filter((r) => r.d0_drift != null).map((r) => r.d0_drift);
  if (drifts.length > 0) {
    const avgDrift = drifts.reduce((a, b) => a + b, 0) / drifts.length;
    const maxDrift = Math.max(...drifts);
    const driftOver1 = drifts.filter((d) => d > 1.0).length;
    const driftOver15 = drifts.filter((d) => d > 1.5).length;
    const driftOver2 = drifts.filter((d) => d > 2.0).length;
    console.log(`   样本数: ${drifts.length}`);
    console.log(`   平均漂移: ${avgDrift.toFixed(2)}°`);
    console.log(`   最大漂移: ${maxDrift.toFixed(2)}°`);
    console.log(`   漂移 > 1.0°: ${driftOver1}/${drifts.length} = ${((driftOver1 / drifts.length) * 100).toFixed(1)}%`);
    console.log(`   漂移 > 1.5° (建议平仓线): ${driftOver15}/${drifts.length} = ${((driftOver15 / drifts.length) * 100).toFixed(1)}%`);
    console.log(`   漂移 > 2.0°: ${driftOver2}/${drifts.length} = ${((driftOver2 / drifts.length) * 100).toFixed(1)}%`);
  }

  // === 4. ENS 成员比例 vs 实际命中 (校准曲线) ===
  console.log("\n" + "=".repeat(70));
  console.log("4. ENS 成员区间比例 vs 实际命中 (校准曲线)");
  console.log("=".repeat(70));
  const realMembersCount = records.filter((r) => r.has_real_members).length;
  console.log(`   (真实成员数据: ${realMembersCount}/${records.length}, 其余用3模型+spread模拟)\n`);

  // 按成员比例分箱
  const bins = [
    { label: "0-15% (该平仓)", min: 0, max: 0.15 },
    { label: "15-30% (该减仓)", min: 0.15, max: 0.3 },
    { label: "30-50%", min: 0.3, max: 0.5 },
    { label: "50-70%", min: 0.5, max: 0.7 },
    { label: "70%+", min: 0.7, max: 1.01 },
  ];
  console.log(`   ${"成员比例区间".padEnd(20)} | ${"样本数".padEnd(8)} | ${"实际命中率".padEnd(12)} | 校准度`);
  console.log("   " + "-".repeat(65));
  for (const bin of bins) {
    const inBin = records.filter(
      (r) => r.d2_member_fraction >= bin.min && r.d2_member_fraction < bin.max,
    );
    if (inBin.length === 0) {
      console.log(`   ${bin.label.padEnd(20)} | ${"0".padEnd(8)} | ${"-".padEnd(12)} | -`);
      continue;
    }
    const hits = inBin.filter((r) => r.d2_2bucket_hit).length;
    const hitRate = hits / inBin.length;
    const avgFrac = inBin.reduce((s, r) => s + r.d2_member_fraction, 0) / inBin.length;
    const calibration = avgFrac > 0 ? (hitRate / avgFrac).toFixed(2) : "-";
    console.log(
      `   ${bin.label.padEnd(20)} | ${String(inBin.length).padEnd(8)} | ${hitRate.toFixed(3).padEnd(12)} | ${calibration} (avg ${avgFrac.toFixed(2)})`,
    );
  }

  // === 5. D-2 成员比例 < 15% 的市场, D-0 预报漂移更大? ===
  console.log("\n" + "=".repeat(70));
  console.log("5. D-2 复检决策回测 (成员比例 < 15% 是否该平仓)");
  console.log("=".repeat(70));
  const lowFrac = records.filter((r) => r.d2_member_fraction < 0.15);
  const highFrac = records.filter((r) => r.d2_member_fraction >= 0.3);
  if (lowFrac.length > 0) {
    const lowHit = lowFrac.filter((r) => r.d2_2bucket_hit).length;
    const lowDrift = lowFrac.reduce((s, r) => s + r.d0_drift, 0) / lowFrac.length;
    console.log(`   成员 < 15% (${lowFrac.length}个): 命中率 ${((lowHit / lowFrac.length) * 100).toFixed(1)}%, 平均漂移 ${lowDrift.toFixed(2)}°`);
  }
  if (highFrac.length > 0) {
    const highHit = highFrac.filter((r) => r.d2_2bucket_hit).length;
    const highDrift = highFrac.reduce((s, r) => s + r.d0_drift, 0) / highFrac.length;
    console.log(`   成员 >= 30% (${highFrac.length}个): 命中率 ${((highHit / highFrac.length) * 100).toFixed(1)}%, 平均漂移 ${highDrift.toFixed(2)}°`);
  }

  // === 6. 策略期望收益模拟 ===
  console.log("\n" + "=".repeat(70));
  console.log("6. 2桶策略期望收益模拟 (D-3买@0.15, D-0卖出)");
  console.log("=".repeat(70));

  // 模拟: D-3 买2桶 @ 各0.15 (成本$0.30)
  // D-0: 如果命中, 卖涨价桶; 如果未命中, 止损
  const cost = 0.30;
  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  const pnls: number[] = [];

  for (const r of records) {
    let pnl: number;
    if (r.d2_2bucket_hit) {
      // 命中: D-0 卖出涨价桶 (用命中桶价格)
      const sellPrice = r.d0_hit_bucket_price ?? 0.50; // 默认 0.50 如果无数据
      pnl = sellPrice - cost;
    } else {
      // 未命中: D-0 止损 (两桶跌到 ~0.02-0.05)
      pnl = 0.04 - cost; // 回收 $0.04
    }
    totalPnl += pnl;
    pnls.push(pnl);
    if (pnl > 0) wins++;
    else losses++;
  }

  const avgPnl = totalPnl / records.length;
  const winRate = wins / records.length;
  const maxWin = Math.max(...pnls);
  const maxLoss = Math.min(...pnls);

  console.log(`   总交易数: ${records.length}`);
  console.log(`   胜率: ${wins}/${records.length} = ${(winRate * 100).toFixed(1)}%`);
  console.log(`   总 PnL: $${totalPnl.toFixed(2)}`);
  console.log(`   平均 PnL: $${avgPnl.toFixed(4)} / 笔`);
  console.log(`   最大盈利: $${maxWin.toFixed(3)}`);
  console.log(`   最大亏损: $${maxLoss.toFixed(3)}`);

  // 对比: 1桶持有到结算
  console.log("\n   --- 对比: 1桶持有到结算 (相同成本$0.30) ---");
  let pnl1 = 0;
  let wins1 = 0;
  for (const r of records) {
    const pnl = r.d2_1bucket_hit ? 1.0 - 0.30 : -0.30;
    pnl1 += pnl;
    if (pnl > 0) wins1++;
  }
  console.log(`   1桶命中率: ${wins1}/${records.length} = ${((wins1 / records.length) * 100).toFixed(1)}%`);
  console.log(`   总 PnL: $${pnl1.toFixed(2)}`);
  console.log(`   平均 PnL: $${(pnl1 / records.length).toFixed(4)} / 笔`);

  // === 7. D-0 情绪溢价验证: 2桶价格之和 > 1.0? ===
  console.log("\n" + "=".repeat(70));
  console.log("7. D-0 情绪溢价: 2桶 YES 价格之和 > $1.00?");
  console.log("=".repeat(70));
  const sums = records
    .filter((r) => r.d0_2bucket_sum_price != null && r.d0_2bucket_sum_price > 0)
    .map((r) => r.d0_2bucket_sum_price!);
  if (sums.length > 0) {
    const over1 = sums.filter((s) => s > 1.0).length;
    const avgSum = sums.reduce((a, b) => a + b, 0) / sums.length;
    console.log(`   样本数: ${sums.length}`);
    console.log(`   2桶价格均值: $${avgSum.toFixed(3)}`);
    console.log(`   2桶价格 > $1.00 (情绪过热): ${over1}/${sums.length} = ${((over1 / sums.length) * 100).toFixed(1)}%`);
    console.log(`   注意: all_outcomes 价格是最后一次快照, 非精确D-0时刻`);
  }

  // === 明细输出 ===
  console.log("\n" + "=".repeat(70));
  console.log("8. 明细 (按 D-2 成员比例排序)");
  console.log("=".repeat(70));
  console.log(
    `   ${"城市".padEnd(16)} | ${"日期".padEnd(12)} | ${"实际".padEnd(6)} | ${"D2预报".padEnd(6)} | ${"漂移".padEnd(6)} | ${"成员%".padEnd(7)} | ${"2桶命中".padEnd(8)} | ${"D0价格".padEnd(7)}`,
  );
  console.log("   " + "-".repeat(85));
  const sorted = [...records].sort((a, b) => a.d2_member_fraction - b.d2_member_fraction);
  for (const r of sorted.slice(0, 30)) {
    console.log(
      `   ${r.city.padEnd(16)} | ${r.date.padEnd(12)} | ${String(r.actual).padEnd(6)} | ${r.d2_forecast.toFixed(1).padEnd(6)} | ${r.d0_drift.toFixed(1).padEnd(6)} | ${(r.d2_member_fraction * 100).toFixed(0).padEnd(7)}% | ${(r.d2_2bucket_hit ? "✓" : "✗").padEnd(8)} | $${(r.d0_hit_bucket_price ?? 0).toFixed(3)}`,
    );
  }
}

main();
