/* 策略 V2 回测: 对比新旧参数配置的交易表现 (2026-08-04)
 *
 * 目标: 验证两个策略优化的效果
 *   1. 调整校准斜率 MARKET_CAL_SLOPE: 0.91 -> 0.85 (抑制模型过度自信)
 *   2. 过滤高概率交易 MAX_OURP: 新增阈值 0.90 (砍掉 90%+ 置信度的毒单)
 *
 * 方法: 对每个已结算市场, 使用不同参数重新模拟交易决策:
 *   - 策略 V1 (baseline): slope=0.91, maxOurp=1.0 (不过滤)
 *   - 策略 V2 (new):      slope=0.85, maxOurp=0.90 (过滤高概率)
 *
 * 模拟逻辑 (简化版 scan.ts 决策流程):
 *   1. 使用市场数据中的 forecast_temp, sigma, actual_temp
 *   2. 遍历所有 outcome 桶, 计算 bucketProb
 *   3. V2 过滤: p > MAX_OURP 则跳过
 *   4. 计算 calibrated probability 和 edge
 *   5. 按 p 排序, 选 top1 桶
 *   6. 用 entry_price 和 actual_temp 计算 PnL
 *
 * Run: npx tsx scripts/backtest-strategy-v2.ts
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { bucketProb, marketCalibrated, inBucket, calcEv } from "../src/math.js";
import { LOCATIONS } from "../src/config.js";

// ---------- 配置 ----------
// 策略 V1 (基线)
const V1_SLOPE = 0.91;
const V1_MAX_OURP = 1.0; // 1.0 = 不过滤

// 策略 V2 (优化)
const V2_SLOPE = 0.85;
const V2_MAX_OURP = 0.90;

// 通用参数 (与 scan.ts 保持一致)
const MIN_ASK = 0.10;
const MAX_PRICE = 0.30;
const MIN_EDGE = 0.07;
const MIN_EV = 0.10;
const MIN_HOURS = 4; // 最少提前 4 小时 (近似)
const HOURS_TO_RESOLUTION = 12; // 假设开仓时距离结算至少 12 小时

interface Outcome {
  range: [number, number];
  volume?: number;
}

interface Position {
  market_id: string;
  bucket_low: number;
  bucket_high: number;
  entry_price: number;
  p: number;
  ev: number;
  forecast_temp: number | null;
  sigma: number | null;
  opened_at: string;
  pnl: number | null;
  close_reason: string | null;
  status: string;
  resolved_hit?: boolean;
}

interface Snap {
  ts?: string;
  hours_left?: number;
  ecmwf?: number | null;
  hrrr?: number | null;
  metar?: number | null;
  best?: number | null;
  best_source?: string | null;
}

interface Market {
  city: string;
  city_name: string;
  date: string;
  unit: "F" | "C";
  actual_temp: number | null;
  status: string;
  positions?: Position[];
  position?: Position | null;
  forecast_snapshots?: Snap[];
  all_outcomes?: Outcome[];
}

interface TradeRecord {
  city_name: string;
  date: string;
  bucket: string;
  entry_price: number;
  p: number;
  calibrated_prob: number;
  edge: number;
  ev: number;
  hit: boolean;
  pnl: number;
  filtered_by_max_ourp: boolean;
  filtered_edge_negative: boolean;
}

// ---------- 加载数据 ----------
const DIR = path.join(process.cwd(), "data", "markets");
const markets: Market[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => {
    try {
      return JSON.parse(readFileSync(path.join(DIR, f), "utf-8")) as Market;
    } catch {
      return null;
    }
  })
  .filter((m): m is Market => m != null);

// 只保留已结算且有实际温度的市场
const resolvedMarkets = markets.filter(
  (m) => m.status === "resolved" && m.actual_temp != null && m.all_outcomes && m.all_outcomes.length > 0
);

console.log(`\n已结算市场: ${resolvedMarkets.length} 个`);
console.log(`总市场数: ${markets.length} 个`);

// ---------- 模拟函数 ----------

/**
 * 模拟交易决策: 根据参数配置选择交易桶
 */
function simulateStrategy(
  market: Market,
  slope: number,
  maxOurp: number
): TradeRecord | null {
  const actualTemp = market.actual_temp!;
  const outcomes = market.all_outcomes!;

  // 获取预报温度和 sigma
  const forecasts = market.forecast_snapshots || [];
  const lastForecast = forecasts
    .filter((s) => s.best != null)
    .sort((a, b) => (b.ts || "").localeCompare(a.ts || ""))[0];

  const forecast =
    lastForecast?.best ??
    (market.positions?.[0]?.forecast_temp ?? market.position?.forecast_temp ?? null);

  if (forecast == null) return null;

  const sigma = market.positions?.[0]?.sigma ?? market.position?.sigma ??
    (market.unit === "C" ? 2.3 : 1.7);

  // 遍历所有桶, 计算候选
  interface Candidate {
    outcome: Outcome;
    p: number;
    ask: number;
    bid: number;
    calibrated: number;
    edge: number;
    ev: number;
  }

  const candidates: Candidate[] = [];
  let filteredByMaxOurp = 0;
  let filteredEdgeNegative = 0;

  for (const outcome of outcomes) {
    const [tLow, tHigh] = outcome.range;

    // 使用 volume 估算 ask: 简化为桶的中间价格
    // 实际上应该使用 position.entry_price, 但这里我们重新模拟
    const p = bucketProb(forecast, tLow, tHigh, sigma);

    // 跳过无交易价格的桶
    // 简化处理: 我们无法获取真实 bid/ask, 所以用基于概率的估算
    // ask 估算: 当 p 很高时, 价格应该接近 $1.0; 当 p 很低时, 价格应该接近 $0.0
    // 但为了简单, 我们假设使用实际 position 的 entry_price (如果存在)
    const existingPos = (market.positions || market.position ? [market.position!] : [])
      .filter((pos) => pos)
      .find((pos) => pos.bucket_low === tLow && pos.bucket_high === tHigh);

    const ask = existingPos?.entry_price ?? Math.max(MIN_ASK, Math.min(MAX_PRICE, p));
    const bid = existingPos?.bid_at_entry ?? ask * 0.8; // 简化

    // V2 过滤: p > MAX_OURP 则跳过
    if (p > maxOurp) {
      filteredByMaxOurp++;
      continue;
    }

    // 计算校准概率和 edge
    const calibrated = marketCalibrated(ask, slope);
    const edge = p - calibrated;
    const ev = calcEv(p, ask);

    // 基础筛选
    if (ask < MIN_ASK || ask >= MAX_PRICE) {
      filteredEdgeNegative++;
      continue;
    }
    if (ev < MIN_EV || edge < MIN_EDGE) {
      filteredEdgeNegative++;
      continue;
    }

    candidates.push({ outcome, p, ask, bid, calibrated, edge, ev });
  }

  // 无合格候选
  if (candidates.length === 0) return null;

  // 按 p 排序 (与 scan.ts 逻辑一致)
  candidates.sort((a, b) => b.p - a.p);

  // 选 top1 (假设每次只开一个仓位)
  const best = candidates[0];

  // 计算 PnL
  const hit = inBucket(actualTemp, best.outcome.range[0], best.outcome.range[1]);
  const pnl = hit ? 1.0 - best.ask : -best.ask; // 赢 = $1.0 - 成本, 输 = -成本

  return {
    city_name: market.city_name,
    date: market.date,
    bucket: `${best.outcome.range[0]}-${best.outcome.range[1]}${market.unit}`,
    entry_price: best.ask,
    p: best.p,
    calibrated_prob: best.calibrated,
    edge: best.edge,
    ev: best.ev,
    hit,
    pnl,
    filtered_by_max_ourp: filteredByMaxOurp > 0,
    filtered_edge_negative: filteredEdgeNegative > 0,
  };
}

// ---------- 运行回测 ----------

console.log("\n" + "=".repeat(60));
console.log("策略回测: 新旧参数对比");
console.log("=".repeat(60));

const v1Results: TradeRecord[] = [];
const v2Results: TradeRecord[] = [];
const skippedMarkets: string[] = [];

for (const market of resolvedMarkets) {
  // 策略 V1
  const v1Trade = simulateStrategy(market, V1_SLOPE, V1_MAX_OURP);
  if (v1Trade) v1Results.push(v1Trade);

  // 策略 V2
  const v2Trade = simulateStrategy(market, V2_SLOPE, V2_MAX_OURP);
  if (v2Trade) v2Results.push(v2Trade);

  if (!v1Trade && !v2Trade) {
    skippedMarkets.push(`${market.city_name} ${market.date}`);
  }
}

// ---------- 统计 ----------

function calcStats(results: TradeRecord[]) {
  const n = results.length;
  const totalPnl = results.reduce((a, r) => a + r.pnl, 0);
  const totalHits = results.filter((r) => r.hit).length;
  const winRate = n > 0 ? (totalHits / n) * 100 : 0;
  const avgPnl = n > 0 ? totalPnl / n : 0;
  const skippedByMaxOurp = results.filter((r) => r.filtered_by_max_ourp).length;

  return { n, totalPnl, totalHits, winRate, avgPnl, skippedByMaxOurp };
}

const v1Stats = calcStats(v1Results);
const v2Stats = calcStats(v2Results);

const pct = (a: number, b: number) => (b > 0 ? ((a / b) * 100).toFixed(1) : "0.0");

// ---------- 生成报告 ----------

const report = `# 策略 V2 回测报告: 参数优化效果对比

生成时间: ${new Date().toISOString()}
样本: ${resolvedMarkets.length} 个已结算市场

## 参数配置

| 参数 | 策略 V1 (基线) | 策略 V2 (优化) | 说明 |
|------|---------------|---------------|------|
| MARKET_CAL_SLOPE | ${V1_SLOPE} | ${V2_SLOPE} | 校准斜率 (降低=抑制过度自信) |
| MAX_OURP | ${V1_MAX_OURP} | ${V2_MAX_OURP} | 高概率过滤阈值 (1.0=不过滤) |

## 核心对比

| 指标 | 策略 V1 (基线) | 策略 V2 (优化) | 变化 |
|------|---------------|---------------|------|
| 交易数 | ${v1Stats.n} | ${v2Stats.n} | ${v2Stats.n - v1Stats.n >= 0 ? "+" : ""}${v2Stats.n - v1Stats.n} |
| 命中数 | ${v1Stats.totalHits} | ${v2Stats.totalHits} | ${v2Stats.totalHits - v1Stats.totalHits >= 0 ? "+" : ""}${v2Stats.totalHits - v1Stats.totalHits} |
| 胜率 | ${v1Stats.winRate.toFixed(1)}% | ${v2Stats.winRate.toFixed(1)}% | ${v2Stats.winRate - v1Stats.winRate >= 0 ? "+" : ""}${(v2Stats.winRate - v1Stats.winRate).toFixed(1)}% |
| 总 PnL | $${v1Stats.totalPnl.toFixed(2)} | $${v2Stats.totalPnl.toFixed(2)} | ${v2Stats.totalPnl - v1Stats.totalPnl >= 0 ? "+" : ""}$${(v2Stats.totalPnl - v1Stats.totalPnl).toFixed(2)} |
| 均 PnL/笔 | $${v1Stats.avgPnl.toFixed(4)} | $${v2Stats.avgPnl.toFixed(4)} | ${v2Stats.avgPnl - v1Stats.avgPnl >= 0 ? "+" : ""}$${(v2Stats.avgPnl - v1Stats.avgPnl).toFixed(4)} |

## V2 过滤效果分析

- V2 因 MAX_OURP 过滤掉的高概率交易: ${v2Stats.skippedByMaxOurp} 笔
- V1 因 MAX_OURP 过滤掉的高概率交易: ${v1Stats.skippedByMaxOurp} 笔

## 逐笔对比

### 策略 V1 (基线)

| city | date | bucket | ask | p | cal.prob | edge | hit | pnl | filtered |
|------|------|--------|-----|---|----------|------|-----|-----|----------|
${v1Results
  .map(
    (r) =>
      `| ${r.city_name} | ${r.date} | ${r.bucket} | $${r.entry_price.toFixed(3)} | ${(r.p * 100).toFixed(1)}% | ${(r.calibrated_prob * 100).toFixed(1)}% | ${r.edge.toFixed(3)} | ${r.hit ? "✓" : "✗"} | $${r.pnl.toFixed(3)} | ${r.filtered_by_max_ourp ? "MAX_OURP" : r.filtered_edge_negative ? "EDGE" : ""} |`,
  )
  .join("\n")}

### 策略 V2 (优化)

| city | date | bucket | ask | p | cal.prob | edge | hit | pnl | filtered |
|------|------|--------|-----|---|----------|------|-----|-----|----------|
${v2Results
  .map(
    (r) =>
      `| ${r.city_name} | ${r.date} | ${r.bucket} | $${r.entry_price.toFixed(3)} | ${(r.p * 100).toFixed(1)}% | ${(r.calibrated_prob * 100).toFixed(1)}% | ${r.edge.toFixed(3)} | ${r.hit ? "✓" : "✗"} | $${r.pnl.toFixed(3)} | ${r.filtered_by_max_ourp ? "MAX_OURP" : r.filtered_edge_negative ? "EDGE" : ""} |`,
  )
  .join("\n")}

## 解读建议

1. **胜率提升**: 若 V2 胜率 > V1, 说明过滤高概率交易 + 降低校准斜率有效
2. **PnL 改善**: 若 V2 总 PnL > V1, 说明优化减少了亏损
3. **交易数减少**: V2 交易数应少于 V1 (因 MAX_OURP 过滤), 但质量应更高
4. **关注极端情况**: 若 V2 交易数骤减 (如 < 10笔), 说明阈值过严

## 局限性

1. **简化模拟**: 此脚本简化了真实决策流程 (无动态 bid/ask 获取, 无 LLM 门控)
2. **历史数据**: 仅使用已结算市场, 样本量有限 (${resolvedMarkets.length} 个)
3. **线性模型**: 假设固定 sigma, 未考虑 sigma 动态变化
4. **单一仓位**: 假设每次只开一个仓位, 未考虑多仓位分散

## 下一步

若 V2 参数有效:
- 可考虑进一步调整阈值 (如 MAX_OURP 降到 0.85, 或 MARKET_CAL_SLOPE 进一步降低)
- 结合 LLM 门控使用, 形成双重过滤
- 在实盘环境中观察实际表现

若 V2 参数无效:
- 分析失败案例, 确定问题根源 (校准模型 vs 过滤阈值)
- 尝试其他参数组合 (如只改 slope 或只改 MAX_OURP)
- 探索其他优化方向 (如动态止损, 仓位管理等)
`;

console.log("\n" + report);

// 写入文件
const outDir = path.join(process.cwd(), "data", "processed");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `strategy_backtest_${new Date().toISOString().slice(0, 10)}.md`);
writeFileSync(outFile, report, "utf-8");
console.log(`\n报告已写入: ${outFile}`);

// 摘要输出
console.log("\n" + "=".repeat(60));
console.log("摘要对比");
console.log("=".repeat(60));
console.log(`V1: ${v1Stats.n}笔 | 胜率 ${v1Stats.winRate.toFixed(1)}% | PnL $${v1Stats.totalPnl.toFixed(2)} | 均PnL $${v1Stats.avgPnl.toFixed(4)}`);
console.log(`V2: ${v2Stats.n}笔 | 胜率 ${v2Stats.winRate.toFixed(1)}% | PnL $${v2Stats.totalPnl.toFixed(2)} | 均PnL $${v2Stats.avgPnl.toFixed(4)}`);
if (v2Stats.totalPnl > v1Stats.totalPnl) {
  console.log(`\n✅ V2 优于 V1! 建议采用新参数配置.`);
} else {
  console.log(`\n❌ V2 未优于 V1. 建议重新评估参数选择.`);
}
