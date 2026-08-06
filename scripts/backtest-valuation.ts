/**
 * 独立估值引擎 (ValuationEngine) 校准度回测
 *
 * 目标: 验证估值引擎输出的"公允概率"是否可靠 (校准度), 为偏离度交易打基础。
 *
 * 验证内容:
 *   1. CDF 校准表 (方案 A) 的有效性:
 *      - 原始 CDF vs 校准 CDF 的 Brier score (in-sample + 留一法 LOO)
 *      - 分箱校准度: 预测概率 vs 实际命中率
 *   2. ENS 成员频次路径的校准度 (有成员时公允概率是否"说多少就多少")
 *   3. 动态模型权重 (保守启用: 30天窗口 MAE 反比 + 限幅 ±0.1) vs
 *      固定权重 (0.5/0.3/0.2) 的单桶概率 Brier 对比
 *
 * 数据局限: 历史快照没有"当时"的全桶市场价格 (all_outcomes 只存最新),
 * 所以本脚本只验证公允概率本身的校准度; 偏离度信号有效性待 top2_sum /
 * market 快照积累后另跑。
 *
 * Run: npx tsx scripts/backtest-valuation.ts
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { LOCATIONS } from "../src/config.js";
import { bucketProb, bucketProbEnsemble, inBucket } from "../src/math.js";
import { getSigma } from "../src/storage.js";
import {
  buildCdfCalibrationFromSamples,
  cdfCalibratedWith,
  collectCdfSamples,
} from "../src/valuation.js";

// 与生产一致: CI 里 BIAS_ENABLED=true。
process.env.WEATHERBOT_BIAS_ENABLED = "true";

const ENSEMBLE_WEIGHTS: Record<string, number> = {
  ecmwf_ifs025: 0.5,
  gfs_seamless: 0.3,
  icon_seamless: 0.2,
};
const MODELS = ["ecmwf_ifs025", "gfs_seamless", "icon_seamless"] as const;
const WIN_N = 30; // 动态权重滚动窗口
const CLAMP = 0.1; // 动态权重相对固定权重的限幅

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
  models?: Record<string, number>;
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
  metar_max?: number | null;
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

/** sigma 与生产一致: base * horizonScale, ens.spread 覆盖。 */
function snapSigma(m: Mkt, snap: ForecastSnap): number {
  const hours = snap.hours_left ?? 0;
  const base = getSigma(m.city, "ecmwf");
  const horizonScale = 1 + Math.max(0, hours - 6) / 48;
  let sigma = base * horizonScale;
  if (snap.ens && snap.ens.spread > 0) sigma = Math.max(snap.ens.spread, base * 0.5);
  return Math.round(sigma * 1000) / 1000;
}

function brier(preds: { p: number; y: 0 | 1 }[]): number {
  if (!preds.length) return 0;
  return preds.reduce((s, r) => s + (r.p - r.y) * (r.p - r.y), 0) / preds.length;
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "-";
}

function main(): void {
  const markets = loadAllMarkets();
  const resolved = markets.filter((m) => m.status === "resolved" && m.actual_temp != null);
  console.log(`[BACKTEST] 估值引擎校准度验证 — 已结算市场 ${resolved.length} / 总 ${markets.length}\n`);

  // ============ 1. CDF 校准表 (方案 A) ============
  console.log("=".repeat(72));
  console.log("1. CDF 校准表 (方案 A) — 原始 CDF vs 校准 CDF");
  console.log("=".repeat(72));

  const samples = collectCdfSamples(markets);
  console.log(`   样本: ${samples.length} 个 (每已结算市场 ≤2: 最优单桶 + 最优双桶区间, 无 ENS 成员)\n`);

  const rawPreds = samples.map((s) => ({ p: s.pred, y: s.hit }));
  console.log(`   原始 CDF  Brier: ${brier(rawPreds).toFixed(4)}`);

  // in-sample 校准表
  const insTable = buildCdfCalibrationFromSamples(samples);
  if (insTable) {
    const insPreds = samples.map((s) => ({ p: cdfCalibratedWith(insTable, s.pred), y: s.hit }));
    console.log(`   in-sample 校准 CDF  Brier: ${brier(insPreds).toFixed(4)}  (${pct(insPreds.filter((r) => r.p > 0.5 && r.y === 1 || r.p <= 0.5 && r.y === 0).length, insPreds.length)} 方向正确)`);

    console.log(`\n   校准表分箱 (in-sample):`);
    console.log(`   ${"箱".padEnd(14)} | ${"n".padEnd(5)} | ${"预测均值".padEnd(10)} | ${"实际命中".padEnd(10)} | 偏差`);
    console.log("   " + "-".repeat(56));
    for (const b of insTable.bins) {
      const label = `${b.min < 0 ? "<" : "≥" + b.min.toFixed(2)}${b.max > 1 ? "+" : " <" + b.max.toFixed(2)}`;
      const diff = b.n > 0 ? b.hit_rate - b.avg_pred : 0;
      console.log(
        `   ${label.padEnd(14)} | ${String(b.n).padEnd(5)} | ${b.avg_pred.toFixed(3).padEnd(10)} | ${pct(b.hits, b.n).padEnd(10)} | ${diff >= 0 ? "+" : ""}${diff.toFixed(3)}`,
      );
    }
  }

  // 留一法 (LOO): 每个样本用"去掉该市场全部样本后"的表校准
  const looPreds: { p: number; y: 0 | 1; market: string }[] = [];
  const marketsSet = new Set(samples.map((s) => s.market));
  for (const mk of marketsSet) {
    const rest = samples.filter((s) => s.market !== mk);
    const table = buildCdfCalibrationFromSamples(rest);
    for (const s of samples.filter((x) => x.market === mk)) {
      const cal = table ? cdfCalibratedWith(table, s.pred) : s.pred;
      looPreds.push({ p: cal, y: s.hit, market: mk });
    }
  }
  if (looPreds.length) {
    console.log(`\n   LOO 校准 CDF  Brier: ${brier(looPreds).toFixed(4)}   (原始 ${brier(rawPreds).toFixed(4)})`);
    const rawLoo = samples.map((s) => ({ p: s.pred, y: s.hit }));
    const improved = looPreds.length > 0 ? brier(rawLoo) - brier(looPreds) : 0;
    console.log(`   LOO 校准相对改进: ${improved >= 0 ? "+" : ""}${improved.toFixed(4)} (正 = 校准有效)`);
  }

  // ============ 2. ENS 成员频次校准度 ============
  console.log(`\n${"=".repeat(72)}`);
  console.log("2. ENS 成员频次公允概率 — 校准度 (预测 vs 实际)");
  console.log("=".repeat(72));
  const ensPreds: { p: number; y: 0 | 1 }[] = [];
  let ensMarkets = 0;
  for (const m of resolved) {
    const snaps = (m.forecast_snapshots ?? []).filter(
      (s) => s.ens?.membersMax && s.ens.membersMax.length > 0,
    );
    if (!snaps.length) continue;
    snaps.sort((a, b) => (b.hours_left ?? 0) - (a.hours_left ?? 0));
    const snap = snaps[0]!;
    const members = snap.ens!.membersMax!;
    const actual = m.metar_max ?? m.actual_temp;
    if (actual == null) continue;
    const outcomes = (m.all_outcomes ?? []).filter((o) => o.range[0] !== -999 && o.range[1] !== 999);
    if (outcomes.length < 2) continue;
    ensMarkets++;
    // 单桶: 最高 ENS 概率的桶
    let bestP = -1;
    let bestBucket: [number, number] | null = null;
    for (const o of outcomes) {
      const p = bucketProbEnsemble(members, o.range[0], o.range[1]);
      if (p > bestP) {
        bestP = p;
        bestBucket = o.range;
      }
    }
    if (bestBucket) {
      const y: 0 | 1 = inBucket(actual, bestBucket[0], bestBucket[1]) ? 1 : 0;
      ensPreds.push({ p: bestP, y });
    }
  }
  if (ensPreds.length) {
    console.log(`   样本: ${ensPreds.length} 个已结算市场 (最早 members 快照, hours_left 中位 ${(() => {
      const hs: number[] = [];
      for (const m of resolved) {
        const snaps = (m.forecast_snapshots ?? []).filter((s) => s.ens?.membersMax?.length);
        if (!snaps.length) continue;
        snaps.sort((a, b) => (b.hours_left ?? 0) - (a.hours_left ?? 0));
        hs.push(snaps[0]!.hours_left ?? 0);
      }
      return hs.length ? hs.sort((a, b) => a - b)[Math.floor(hs.length / 2)]!.toFixed(1) : "-";
    })()}h)`);
    console.log(`   ENS 公允概率 Brier: ${brier(ensPreds).toFixed(4)}`);
    const bins = [
      { label: "<0.30", min: -0.01, max: 0.3 },
      { label: "0.30-0.50", min: 0.3, max: 0.5 },
      { label: "0.50-0.70", min: 0.5, max: 0.7 },
      { label: ">=0.70", min: 0.7, max: 1.01 },
    ];
    console.log(`   ${"ENS概率".padEnd(12)} | ${"n".padEnd(5)} | ${"预测均值".padEnd(10)} | ${"实际命中".padEnd(10)} | 偏差`);
    console.log("   " + "-".repeat(56));
    for (const b of bins) {
      const inB = ensPreds.filter((r) => r.p >= b.min && r.p < b.max);
      if (!inB.length) continue;
      const hits = inB.filter((r) => r.y === 1).length;
      const avgP = inB.reduce((s, r) => s + r.p, 0) / inB.length;
      const diff = hits / inB.length - avgP;
      console.log(
        `   ${b.label.padEnd(12)} | ${String(inB.length).padEnd(5)} | ${avgP.toFixed(3).padEnd(10)} | ${pct(hits, inB.length).padEnd(10)} | ${diff >= 0 ? "+" : ""}${diff.toFixed(3)}`,
      );
    }
  } else {
    console.log(`   无已结算市场带真实 members 数据。`);
  }

  // ============ 3. 动态模型权重 vs 固定权重 ============
  console.log(`\n${"=".repeat(72)}`);
  console.log("3. 动态模型权重 (30天窗口 MAE 反比, 限幅 ±0.1) vs 固定权重 (0.5/0.3/0.2)");
  console.log("=".repeat(72));

  const sorted = [...resolved].sort((a, b) => a.date.localeCompare(b.date));
  const errByModel: Record<string, number[]> = {};
  const fixedPreds: { p: number; y: 0 | 1 }[] = [];
  const dynPreds: { p: number; y: 0 | 1 }[] = [];
  let dynMarkets = 0;

  for (const m of sorted) {
    const snaps = m.forecast_snapshots ?? [];
    const snap = findSnap(snaps, 44, 60) ?? findSnap(snaps, 24, 72);
    if (!snap || !snap.ens?.models) continue;
    const modelTemps = snap.ens.models;
    const present = MODELS.filter((mo) => modelTemps[mo] != null);
    if (present.length < 2) continue;
    const actual = m.metar_max ?? m.actual_temp;
    if (actual == null) continue;
    const outcomes = (m.all_outcomes ?? []).filter((o) => o.range[0] !== -999 && o.range[1] !== 999);
    if (outcomes.length < 2) continue;

    // 固定权重 mean
    let ws = 0;
    let ms = 0;
    for (const mo of present) {
      const w = ENSEMBLE_WEIGHTS[mo] ?? 0;
      ws += w;
      ms += w * modelTemps[mo]!;
    }
    const fixedMean = ws > 0 ? ms / ws : NaN;

    // 动态权重 mean (只用当前市场之前的误差, 无前视偏差)
    let dynMean: number | null = null;
    const availErr = present.filter((mo) => (errByModel[mo] ?? []).length >= 3);
    if (availErr.length >= 2) {
      const rawW: Record<string, number> = {};
      let sumW = 0;
      for (const mo of availErr) {
        const arr = errByModel[mo]!;
        const mae = arr.reduce((a, b) => a + Math.abs(b), 0) / arr.length;
        const w = mae > 0 ? 1 / mae : 0;
        rawW[mo] = w;
        sumW += w;
      }
      if (sumW > 0) {
        // 限幅: 相对固定权重 ±CLAMP, 再归一化
        const clamped: Record<string, number> = {};
        for (const mo of present) {
          const fixed = ENSEMBLE_WEIGHTS[mo] ?? 0;
          const raw = (rawW[mo] ?? 0) / sumW;
          clamped[mo] = Math.max(0, Math.min(1, Math.max(fixed - CLAMP, Math.min(fixed + CLAMP, raw))));
        }
        let csum = Object.values(clamped).reduce((a, b) => a + b, 0);
        if (csum > 0) {
          let dms = 0;
          for (const mo of present) {
            dms += (clamped[mo] / csum) * modelTemps[mo]!;
          }
          dynMean = dms;
        }
      }
    }

    const sigma = snapSigma(m, snap);
    const horizon = snap.horizon ?? "D+0";
    const bestSource = snap.best_source ?? "best";
    const biasSource = bestSource === "ensemble" ? "best" : bestSource;
    // 注: 快照的 best/模型值已是 forecast.ts 里纠偏后的值; 此处直接使用。

    const fixedAdj = fixedMean;
    const dynAdj = dynMean;

    // 单桶: 最高概率桶
    let fBestP = -1;
    let fBucket: [number, number] | null = null;
    for (const o of outcomes) {
      const p = bucketProb(fixedAdj, o.range[0], o.range[1], sigma);
      if (p > fBestP) {
        fBestP = p;
        fBucket = o.range;
      }
    }
    if (fBucket) {
      const y: 0 | 1 = inBucket(actual, fBucket[0], fBucket[1]) ? 1 : 0;
      fixedPreds.push({ p: fBestP, y });
    }
    if (dynAdj != null) {
      dynMarkets++;
      let dBucket: [number, number] | null = null;
      let dBestP = -1;
      for (const o of outcomes) {
        const p = bucketProb(dynAdj, o.range[0], o.range[1], sigma);
        if (p > dBestP) {
          dBestP = p;
          dBucket = o.range;
        }
      }
      if (dBucket) {
        const y: 0 | 1 = inBucket(actual, dBucket[0], dBucket[1]) ? 1 : 0;
        dynPreds.push({ p: dBestP, y });
      }
    }

    // 追加当前市场误差到滚动窗口 (供后续市场用)
    for (const mo of present) {
      const arr = errByModel[mo] ?? (errByModel[mo] = []);
      arr.push(modelTemps[mo]! - actual);
      if (arr.length > WIN_N) arr.shift();
    }
  }

  const fHit = fixedPreds.filter((r) => r.y === 1).length;
  const dHit = dynPreds.filter((r) => r.y === 1).length;
  console.log(`   市场样本: ${fixedPreds.length} (固定) / ${dynPreds.length} (动态, 需≥3个历史误差)`);
  console.log(`   固定权重: Brier ${brier(fixedPreds).toFixed(4)}, 最高桶命中 ${pct(fHit, fixedPreds.length)}`);
  console.log(`   动态权重: Brier ${brier(dynPreds).toFixed(4)}, 最高桶命中 ${pct(dHit, dynPreds.length)}`);
  if (dynPreds.length >= 10) {
    const delta = brier(fixedPreds) - brier(dynPreds);
    console.log(`   动态 vs 固定 Brier 差异: ${delta >= 0 ? "+" : ""}${delta.toFixed(4)} (正 = 动态更优)`);
  } else {
    console.log(`   动态权重样本不足 (${dynPreds.length}), 差异无统计意义。`);
  }

  console.log(`\n说明: 历史快照无 D-2 时点全桶市场价格, 偏离度信号 (公允价 vs 市场价) 待积累后另验。`);
}

main();
