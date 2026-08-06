/**
 * D-3 / D-2 选桶成功率验证
 *
 * 用历史已结算市场回测: 在 D-3 / D-2 时刻用当时的模型数据 (优先 ENS 成员频次,
 * 无成员时用 bias 修正后的正态 CDF), 模拟 scan.ts 的双桶选桶逻辑选最优相邻桶对,
 * 检查最终实际温度是否落在区间内。
 *
 * 输出:
 *   1. 数据可用性: D-3 / D-2 快照覆盖 (说明 D-3 为什么无法验证)
 *   2. 双桶区间命中率 vs 单桶命中率 (D-2)
 *   3. 有真实 ENS members 的样本单独统计 (ENS 频次选桶)
 *   4. 按区间概率分箱的校准度 (预测 pPair vs 实际命中)
 *
 * Run: npx tsx scripts/backtest-d3-d2-bucket-hit.ts
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { LOCATIONS } from "../src/config.js";
import { applyBias } from "../src/bias.js";
import { bucketProb, bucketProbEnsemble, inBucket } from "../src/math.js";
import { getSigma } from "../src/storage.js";

// 与生产一致: CI 里 BIAS_ENABLED=true。验证脚本也开启 bias 修正。
process.env.WEATHERBOT_BIAS_ENABLED = "true";

interface OutcomeRow {
  range: [number, number];
  bid: number;
  ask: number;
  volume: number;
}
interface EnsSnap {
  mean: number;
  spread: number;
  gap: number;
  membersMax?: number[];
}
interface ForecastSnap {
  ts?: string;
  horizon?: string;
  hours_left?: number;
  ecmwf?: number | null;
  hrrr?: number | null;
  metar?: number | null;
  best?: number | null;
  best_source?: string | null;
  ens?: EnsSnap | null;
}
interface Mkt {
  city: string;
  city_name: string;
  date: string;
  unit: "F" | "C";
  status: string;
  actual_temp: number | null;
  forecast_snapshots?: ForecastSnap[];
  all_outcomes?: OutcomeRow[];
}

const DIR = path.join(process.cwd(), "data", "markets");

function loadAllMarkets(): Mkt[] {
  const out: Mkt[] = [];
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as Mkt);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** 找 hours_left 落在 [minH, maxH] 且最接近中点的快照 */
function findSnap(snaps: ForecastSnap[], minH: number, maxH: number): ForecastSnap | null {
  let best: ForecastSnap | null = null;
  let bestDiff = Infinity;
  const mid = (minH + maxH) / 2;
  for (const s of snaps) {
    const h = s.hours_left ?? 999;
    if (h >= minH && h <= maxH) {
      const d = Math.abs(h - mid);
      if (d < bestDiff) {
        bestDiff = d;
        best = s;
      }
    }
  }
  return best;
}

/** 模拟 scan.ts 选桶: 返回 { 单桶(最高p), 双桶(最高区间概率相邻对), 各自p } */
function selectBuckets(
  m: Mkt,
  snap: ForecastSnap,
): {
  single: OutcomeRow;
  singleP: number;
  pair: [OutcomeRow, OutcomeRow] | null;
  pairP: number;
  hasMembers: boolean;
} | null {
  const outcomes = (m.all_outcomes ?? []).filter((o) => o.range[0] !== -999 && o.range[1] !== 999);
  if (outcomes.length < 2) return null;

  const membersMax = snap.ens?.membersMax;
  const hasMembers = !!membersMax && membersMax.length > 0;
  const citySlug = m.city;
  const unit = m.unit;
  const horizon = snap.horizon ?? "D+0";

  // sigma 与生产一致: baseSigma * horizonScale; ens.spread>0 时取 max(spread, base*0.5)
  const hours = snap.hours_left ?? 0;
  const baseSigma = getSigma(citySlug, "ecmwf");
  const horizonScale = 1 + Math.max(0, hours - 6) / 48;
  let sigma = baseSigma * horizonScale;
  if (snap.ens && snap.ens.spread > 0) {
    sigma = Math.max(snap.ens.spread, baseSigma * 0.5);
  }
  sigma = Math.round(sigma * 1000) / 1000;

  // bias 修正后的预报 (仅正态 CDF 路径用; ENS 成员路径直接用成员)
  const bestSource = snap.best_source ?? "best";
  const biasSource = bestSource === "ensemble" ? "best" : bestSource;
  const adjForecast = applyBias(snap.best ?? snap.ens?.mean ?? snap.ecmwf ?? NaN, citySlug, horizon, biasSource);
  if (!Number.isFinite(adjForecast)) return null;

  // 单桶: 最高 p
  let single: OutcomeRow = outcomes[0]!;
  let singleP = -1;
  for (const o of outcomes) {
    const p = hasMembers
      ? bucketProbEnsemble(membersMax!, o.range[0], o.range[1])
      : bucketProb(adjForecast, o.range[0], o.range[1], sigma);
    if (p > singleP) {
      singleP = p;
      single = o;
    }
  }

  // 双桶: 最高区间概率的相邻对 (与 scan.ts 双桶选桶一致)
  let pair: [OutcomeRow, OutcomeRow] | null = null;
  let pairP = -1;
  for (let ai = 0; ai < outcomes.length; ai++) {
    for (let bi = ai + 1; bi < outcomes.length; bi++) {
      const a = outcomes[ai]!;
      const b = outcomes[bi]!;
      const adjacent = a.range[1] + 1 === b.range[0] || b.range[1] + 1 === a.range[0];
      if (!adjacent) continue;
      const low = Math.min(a.range[0], b.range[0]);
      const high = Math.max(a.range[1], b.range[1]);
      const pPair = hasMembers
        ? bucketProbEnsemble(membersMax!, low, high)
        : bucketProb(adjForecast, low, high, sigma);
      if (pPair > pairP) {
        pairP = pPair;
        pair = [a, b];
      }
    }
  }
  if (pairP < 0) return null;

  return { single, singleP, pair, pairP, hasMembers };
}

interface Row {
  city: string;
  date: string;
  unit: string;
  actual: number;
  hoursLeft: number;
  hasMembers: boolean;
  singleBucket: string;
  singleP: number;
  singleHit: boolean;
  pairInterval: string;
  pairP: number;
  pairHit: boolean;
}

function bucketStr(r: OutcomeRow, unit: string): string {
  return `${r.range[0]}-${r.range[1]}${unit}`;
}

function main(): void {
  const markets = loadAllMarkets();
  const resolved = markets.filter((m) => m.status === "resolved" && m.actual_temp != null);
  console.log(`[BACKTEST] 已结算市场: ${resolved.length} / 总 ${markets.length}\n`);

  // === 0. 数据可用性 ===
  console.log("=".repeat(72));
  console.log("0. D-3 / D-2 快照覆盖 (数据可用性)");
  console.log("=".repeat(72));
  let d3Count = 0;
  let d2Count = 0;
  for (const m of resolved) {
    const snaps = m.forecast_snapshots ?? [];
    if (findSnap(snaps, 72, 80)) d3Count++;
    if (findSnap(snaps, 44, 60)) d2Count++;
  }
  console.log(`   已结算市场有 D-3 快照 (72-80h): ${d3Count}`);
  console.log(`   已结算市场有 D-2 快照 (44-60h): ${d2Count}`);
  console.log(`   说明: Polymarket 温度市场约结算前 44-56h 才上架, MAX_HOURS=80 是 08-04 才放宽,`);
  console.log(`   历史数据 D-2 有样本, D-3 无样本 → D-3 成功率只能等 08-07 市场上架后验证。\n`);

  // === D-2 选桶回测 ===
  const rows: Row[] = [];
  for (const m of resolved) {
    if (m.actual_temp == null) continue;
    const snaps = m.forecast_snapshots ?? [];
    const snap = findSnap(snaps, 44, 60) ?? findSnap(snaps, 36, 72);
    if (!snap) continue;
    const sel = selectBuckets(m, snap);
    if (!sel) continue;
    const actual = m.actual_temp;
    const pairLow = sel.pair ? Math.min(sel.pair[0].range[0], sel.pair[1].range[0]) : NaN;
    const pairHigh = sel.pair ? Math.max(sel.pair[0].range[1], sel.pair[1].range[1]) : NaN;
    rows.push({
      city: m.city_name,
      date: m.date,
      unit: m.unit,
      actual,
      hoursLeft: snap.hours_left ?? 0,
      hasMembers: sel.hasMembers,
      singleBucket: bucketStr(sel.single, m.unit),
      singleP: sel.singleP,
      singleHit: inBucket(actual, sel.single.range[0], sel.single.range[1]),
      pairInterval: `${pairLow}-${pairHigh}${m.unit}`,
      pairP: sel.pairP,
      pairHit: inBucket(actual, pairLow, pairHigh),
    });
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`1. D-2 选桶成功率 (快照 hours_left 中位数 ${rows.length ? rows.map((r) => r.hoursLeft).sort((a, b) => a - b)[Math.floor(rows.length / 2)]!.toFixed(1) : "-"}h)`);
  console.log("=".repeat(72));
  console.log(`   样本: ${rows.length} 个市场\n`);

  // 全样本
  const sHit = rows.filter((r) => r.singleHit).length;
  const pHit = rows.filter((r) => r.pairHit).length;
  console.log(`   [全部 ${rows.length}] 单桶命中: ${sHit} (${((sHit / rows.length) * 100).toFixed(1)}%)`);
  console.log(`   [全部 ${rows.length}] 双桶区间命中: ${pHit} (${((pHit / rows.length) * 100).toFixed(1)}%)  倍数 ${(pHit / Math.max(1, sHit)).toFixed(2)}x`);

  // 有真实 members 子集
  const memRows = rows.filter((r) => r.hasMembers);
  if (memRows.length) {
    const msHit = memRows.filter((r) => r.singleHit).length;
    const mpHit = memRows.filter((r) => r.pairHit).length;
    console.log(`\n   [ENS成员 ${memRows.length}] 单桶命中: ${msHit} (${((msHit / memRows.length) * 100).toFixed(1)}%)`);
    console.log(`   [ENS成员 ${memRows.length}] 双桶区间命中: ${mpHit} (${((mpHit / memRows.length) * 100).toFixed(1)}%)`);
  }

  // 无成员 (正态 CDF + bias) 子集
  const cdfRows = rows.filter((r) => !r.hasMembers);
  if (cdfRows.length) {
    const csHit = cdfRows.filter((r) => r.singleHit).length;
    const cpHit = cdfRows.filter((r) => r.pairHit).length;
    console.log(`\n   [正态CDF ${cdfRows.length}] 单桶命中: ${csHit} (${((csHit / cdfRows.length) * 100).toFixed(1)}%)`);
    console.log(`   [正态CDF ${cdfRows.length}] 双桶区间命中: ${cpHit} (${((cpHit / cdfRows.length) * 100).toFixed(1)}%)`);
  }

  // === 2. 按区间概率分箱校准 ===
  console.log(`\n${"=".repeat(72)}`);
  console.log("2. 双桶区间概率 vs 实际命中 (校准度)");
  console.log("=".repeat(72));
  const bins = [
    { label: "<0.30", min: -0.01, max: 0.3 },
    { label: "0.30-0.45", min: 0.3, max: 0.45 },
    { label: "0.45-0.60", min: 0.45, max: 0.6 },
    { label: "0.60-0.75", min: 0.6, max: 0.75 },
    { label: ">=0.75", min: 0.75, max: 1.01 },
  ];
  console.log(`   ${"区间概率".padEnd(12)} | ${"样本".padEnd(6)} | ${"命中".padEnd(6)} | ${"命中率".padEnd(8)} | 平均预测`);
  console.log("   " + "-".repeat(62));
  for (const b of bins) {
    const inB = rows.filter((r) => r.pairP >= b.min && r.pairP < b.max);
    if (!inB.length) continue;
    const hit = inB.filter((r) => r.pairHit).length;
    const avgP = inB.reduce((s, r) => s + r.pairP, 0) / inB.length;
    console.log(
      `   ${b.label.padEnd(12)} | ${String(inB.length).padEnd(6)} | ${String(hit).padEnd(6)} | ${((hit / inB.length) * 100).toFixed(1).padEnd(7)}% | ${avgP.toFixed(2)}`,
    );
  }

  // === 3. 单桶 vs 双桶 命中对比 (预测漂移视角) ===
  console.log(`\n${"=".repeat(72)}`);
  console.log("3. 双桶命中但单桶未命中 (区间策略的增量价值)");
  console.log("=".repeat(72));
  const onlyPair = rows.filter((r) => r.pairHit && !r.singleHit).length;
  const onlySingle = rows.filter((r) => r.singleHit && !r.pairHit).length;
  const both = rows.filter((r) => r.pairHit && r.singleHit).length;
  const none = rows.filter((r) => !r.pairHit && !r.singleHit).length;
  console.log(`   双桶赢单桶输: ${onlyPair} | 单桶赢双桶输: ${onlySingle} | 都赢: ${both} | 都输: ${none}`);

  // === 4. 明细 ===
  console.log(`\n${"=".repeat(72)}`);
  console.log("4. 明细 (按 hours_left 排序)");
  console.log("=".repeat(72));
  console.log(`   ${"城市".padEnd(14)} | ${"日期".padEnd(11)} | ${"H".padEnd(4)} | ${"ENS".padEnd(4)} | ${"实际".padEnd(5)} | ${"单桶".padEnd(9)} | ${"区间".padEnd(9)} | ${"区间P".padEnd(6)} | 命中`);
  console.log("   " + "-".repeat(82));
  for (const r of [...rows].sort((a, b) => a.hoursLeft - b.hoursLeft)) {
    const mark = r.pairHit ? "✓✓" : r.singleHit ? "✓" : "✗";
    console.log(
      `   ${r.city.padEnd(14)} | ${r.date.padEnd(11)} | ${String(Math.round(r.hoursLeft)).padEnd(4)} | ${r.hasMembers ? "真" : "—".padEnd(4)} | ${String(r.actual).padEnd(5)} | ${r.singleBucket.padEnd(9)} | ${r.pairInterval.padEnd(9)} | ${r.pairP.toFixed(2).padEnd(6)} | ${mark}`,
    );
  }

  // === 5. 真实 ENS members 路径验证 (D-2 窗口无样本, 放宽到最早 members 快照) ===
  console.log(`\n${"=".repeat(72)}`);
  console.log("5. 真实 ENS members 选桶 (ECMWF ENS 50成员频次)");
  console.log("=".repeat(72));
  const memRows2: Row[] = [];
  for (const m of resolved) {
    if (m.actual_temp == null) continue;
    const snaps = (m.forecast_snapshots ?? []).filter(
      (s) => s.ens?.membersMax && s.ens.membersMax.length > 0,
    );
    if (!snaps.length) continue;
    // 取 hours_left 最大的 members 快照 (最早时点, 最能代表 D-2/D-3 选桶)
    snaps.sort((a, b) => (b.hours_left ?? 0) - (a.hours_left ?? 0));
    const snap = snaps[0]!;
    const sel = selectBuckets(m, snap);
    if (!sel || !sel.pair) continue;
    const actual = m.actual_temp;
    const pairLow = Math.min(sel.pair[0].range[0], sel.pair[1].range[0]);
    const pairHigh = Math.max(sel.pair[0].range[1], sel.pair[1].range[1]);
    memRows2.push({
      city: m.city_name,
      date: m.date,
      unit: m.unit,
      actual,
      hoursLeft: snap.hours_left ?? 0,
      hasMembers: true,
      singleBucket: bucketStr(sel.single, m.unit),
      singleP: sel.singleP,
      singleHit: inBucket(actual, sel.single.range[0], sel.single.range[1]),
      pairInterval: `${pairLow}-${pairHigh}${m.unit}`,
      pairP: sel.pairP,
      pairHit: inBucket(actual, pairLow, pairHigh),
    });
  }
  if (memRows2.length) {
    const msHit = memRows2.filter((r) => r.singleHit).length;
    const mpHit = memRows2.filter((r) => r.pairHit).length;
    const hoursArr = memRows2.map((r) => r.hoursLeft).sort((a, b) => a - b);
    const medH = hoursArr[Math.floor(hoursArr.length / 2)]!;
    console.log(`   样本: ${memRows2.length} 个已结算市场 (快照 hours_left 中位数 ${medH.toFixed(1)}h, 范围 ${hoursArr[0]!.toFixed(0)}-${hoursArr[hoursArr.length - 1]!.toFixed(0)}h)`);
    console.log(`   [ENS成员 ${memRows2.length}] 单桶命中: ${msHit} (${((msHit / memRows2.length) * 100).toFixed(1)}%)`);
    console.log(`   [ENS成员 ${memRows2.length}] 双桶区间命中: ${mpHit} (${((mpHit / memRows2.length) * 100).toFixed(1)}%)`);

    // 按 ENS 区间概率分箱校准
    console.log(`\n   ${"ENS区间概率".padEnd(12)} | ${"样本".padEnd(6)} | ${"命中".padEnd(6)} | ${"命中率".padEnd(8)} | 平均预测`);
    console.log("   " + "-".repeat(62));
    const bins2 = [
      { label: "<0.30", min: -0.01, max: 0.3 },
      { label: "0.30-0.50", min: 0.3, max: 0.5 },
      { label: "0.50-0.70", min: 0.5, max: 0.7 },
      { label: ">=0.70", min: 0.7, max: 1.01 },
    ];
    for (const b of bins2) {
      const inB = memRows2.filter((r) => r.pairP >= b.min && r.pairP < b.max);
      if (!inB.length) continue;
      const hit = inB.filter((r) => r.pairHit).length;
      const avgP = inB.reduce((s, r) => s + r.pairP, 0) / inB.length;
      console.log(
        `   ${b.label.padEnd(12)} | ${String(inB.length).padEnd(6)} | ${String(hit).padEnd(6)} | ${((hit / inB.length) * 100).toFixed(1).padEnd(7)}% | ${avgP.toFixed(2)}`,
      );
    }

    console.log(`\n   明细:`);
    for (const r of [...memRows2].sort((a, b) => b.hoursLeft - a.hoursLeft)) {
      const mark = r.pairHit ? "✓✓" : r.singleHit ? "✓" : "✗";
      console.log(
        `   ${r.city.padEnd(14)} | ${r.date.padEnd(11)} | ${String(Math.round(r.hoursLeft)).padEnd(4)} | ${String(r.actual).padEnd(5)} | ${r.singleBucket.padEnd(9)} | ${r.pairInterval.padEnd(9)} | ${r.pairP.toFixed(2).padEnd(6)} | ${mark}`,
      );
    }
  } else {
    console.log(`   无已结算市场带真实 members 数据。`);
  }

  // === 6. D-3 预告 ===
  console.log(`\n${"=".repeat(72)}`);
  console.log("6. D-3 验证计划");
  console.log("=".repeat(72));
  console.log(`   历史 D-3 (72-80h) 快照: 0 条 → 无法用旧数据验证。`);
  console.log(`   MAX_HOURS=80 已生效 (08-05 推送), 08-07 市场上架后 (约 08-05 晚至 08-06) 会采集 D-3 快照,`);
  console.log(`   08-08 结算后即可用同样脚本验证 D-3 选桶成功率。`);
}

main();
