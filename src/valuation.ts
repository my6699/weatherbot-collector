/**
 * 独立估值引擎 (ValuationEngine)
 *
 * 核心: 为每个温度桶计算"独立于市场"的公允概率 → 公允价格。
 * 策略定位: 从"市场跟随"转向"独立估值"——用自己的天气数据 (集合预报 +
 * 历史校准) 定价, 再与 Polymarket 市场价格对比发现错误定价。
 *
 * 概率来源优先级:
 *   1. ENS 成员频次 (ECMWF 50 成员物理扰动) — 最可靠, 直接统计落桶比例。
 *      回测: ENS 区间概率 >=0.70 时实际命中 72.7%, 基本"说多少就多少"。
 *   2. CDF 校准表 (无成员时) — 用历史已结算市场的 "CDF概率 vs 实际命中"
 *      分箱拟合经验命中率, 修正正态 CDF 对区间概率的系统性低估
 *      (回测: CDF 说 0.11 时实际命中 44.8%; NYC 08-04 桶 92% 被 CDF 压到 19.7%)。
 *
 * 校准表: data/cdf_calibration.json, 由 buildCdfCalibration() 从已结算市场
 * 粗建, 随样本积累刷新。粗建阶段为 in-sample, 2-3 周真实数据后再做 LOO 验证。
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { DATA_DIR } from "./config.js";
import { bucketProb, bucketProbEnsemble } from "./math.js";
import type { MarketRecord } from "./storage.js";

/** 公允概率的来源标记 (BUY 日志 / 结算分析用)。 */
export type FairSource = "ens" | "cdf_cal" | "cdf_raw";

export interface FairBucket {
  /** 公允概率 (校准后, 独立于市场)。 */
  fairProb: number;
  /** 公允价格 = 概率直接映射 (60% → $0.60)。 */
  fairPrice: number;
  /** 概率来源。 */
  source: FairSource;
}

export function cdfCalibrationFilePath(): string {
  return path.join(DATA_DIR, "cdf_calibration.json");
}

export interface CdfBin {
  min: number;
  max: number;
  n: number;
  hits: number;
  /** 实际命中率 = hits / n。 */
  hit_rate: number;
  /** 箱内平均预测概率。 */
  avg_pred: number;
}

export interface CdfCalibration {
  bins: CdfBin[];
  /** 全局命中率 (低样本箱的兜底)。 */
  global_hit_rate: number;
  n_total: number;
  updated_at: string;
}

let calCache: CdfCalibration | null = null;

export function loadCdfCalibration(): CdfCalibration | null {
  if (calCache) return calCache;
  const p = cdfCalibrationFilePath();
  if (existsSync(p)) {
    try {
      calCache = JSON.parse(readFileSync(p, "utf-8")) as CdfCalibration;
      return calCache;
    } catch {
      calCache = null;
    }
  }
  return null;
}

/** 清除缓存 (测试 / 刷新后调用)。 */
export function resetCdfCalibrationCache(): void {
  calCache = null;
}

/**
 * CDF 概率校准: 查表把正态 CDF 算出的概率映射到经验命中率。
 * 样本充足箱返回箱内 hit_rate; 低样本箱 (<5) 回退到全局命中率, 避免单点噪声。
 * 无校准表或概率落在箱外时返回原值 (未校准)。
 */
export function cdfCalibrated(p: number): number {
  return cdfCalibratedWith(loadCdfCalibration(), p);
}

/** 用指定的校准表校准 (供留一法回测显式传表)。 */
export function cdfCalibratedWith(cal: CdfCalibration | null, p: number): number {
  if (!(p > 0) || p >= 1) return p;
  if (!cal || cal.bins.length === 0) return p;
  for (const b of cal.bins) {
    if (p >= b.min && p < b.max) {
      if (b.n >= 5) return Math.round(b.hit_rate * 10000) / 10000;
      return Math.round(cal.global_hit_rate * 10000) / 10000;
    }
  }
  // 概率落在分箱范围外 (如 >0.90): 用最后一箱或全局兜底
  const last = cal.bins[cal.bins.length - 1];
  if (last && p >= last.max) {
    return Math.round(last.hit_rate * 10000) / 10000;
  }
  return p;
}

/**
 * 为单个桶计算公允概率。
 * @param membersMax ENS 成员日最高温数组 (已纠偏); 空数组时走 CDF 校准路径
 * @param adjForecast bias 修正后的预报温度 (CDF 路径用)
 * @param tLow 桶下界 (-999 = or below)
 * @param tHigh 桶上界 (999 = or higher)
 * @param sigma 正态 CDF 的 sigma (与 scan.ts 一致)
 */
export function fairBucketProb(
  membersMax: number[] | undefined,
  adjForecast: number,
  tLow: number,
  tHigh: number,
  sigma: number,
): FairBucket {
  if (membersMax && membersMax.length > 0) {
    const p = bucketProbEnsemble(membersMax, tLow, tHigh);
    return { fairProb: p, fairPrice: p, source: "ens" };
  }
  const raw = bucketProb(adjForecast, tLow, tHigh, sigma);
  const cal = cdfCalibrated(raw);
  return {
    fairProb: cal,
    fairPrice: cal,
    source: cal === raw ? "cdf_raw" : "cdf_cal",
  };
}

/**
 * 收集 CDF 校准样本: 每个已结算市场取 D-2 附近快照 (44-60h, 无成员时),
 * 计算最优单桶 CDF 概率和最优双桶区间 CDF 概率, 与最终命中配对。
 * 每市场贡献最多 2 个样本。抽成独立函数以便回测脚本做留一法 (LOO) 评估。
 */
export function collectCdfSamples(
  markets: MarketRecord[],
): { pred: number; hit: 0 | 1; market: string }[] {
  const resolved = markets.filter((m) => m.status === "resolved" && m.actual_temp != null);
  const samples: { pred: number; hit: 0 | 1; market: string }[] = [];

  for (const m of resolved) {
    const snaps = m.forecast_snapshots ?? [];
    if (!snaps.length || (m.all_outcomes ?? []).length < 2) continue;
    // 取 D-2 附近快照 (44-60h), 回退到最接近的快照
    let snap: (typeof snaps)[number] | null = null;
    let bestDiff = Infinity;
    for (const s of snaps) {
      const h = s.hours_left ?? 999;
      if (h < 24) continue; // 太近结算的 CDF 与选桶场景不符
      const d = Math.abs(h - 52);
      if (d < bestDiff) {
        bestDiff = d;
        snap = s;
      }
    }
    if (!snap || snap.hours_left == null) continue;

    const outcomes = (m.all_outcomes ?? []).filter((o) => o.range[0] !== -999 && o.range[1] !== 999);
    if (outcomes.length < 2) continue;

    const membersMax = snap.ens?.membersMax;
    const hasMembers = !!membersMax && membersMax.length > 0;
    if (hasMembers) continue; // ENS 路径不需要 CDF 校准

    const adjForecast = snap.best ?? snap.ens?.mean ?? snap.ecmwf;
    if (adjForecast == null || !Number.isFinite(adjForecast)) continue;

    // sigma 与 scan.ts 一致: base * horizonScale, spread 覆盖
    const baseSigma = loadBaseSigma(m);
    const hours = snap.hours_left ?? 0;
    const horizonScale = 1 + Math.max(0, hours - 6) / 48;
    let sigma = baseSigma * horizonScale;
    if (snap.ens && snap.ens.spread > 0) sigma = Math.max(snap.ens.spread, baseSigma * 0.5);
    sigma = Math.round(sigma * 1000) / 1000;

    const actual = m.metar_max ?? m.actual_temp;
    if (actual == null) continue;

    // 单桶样本: 最高 CDF 概率的桶
    let bestSingle: { range: [number, number] } | null = null;
    let bestSingleP = -1;
    for (const o of outcomes) {
      const p = bucketProb(adjForecast, o.range[0], o.range[1], sigma);
      if (p > bestSingleP) {
        bestSingleP = p;
        bestSingle = o;
      }
    }
    if (bestSingle && bestSingleP > 0) {
      samples.push({ pred: bestSingleP, hit: inBucketHit(actual, bestSingle.range), market: m.city });
    }
    // 区间样本: 最高区间概率的相邻对 (记录区间范围以便判命中)
    let bestPairP = -1;
    let bestPairRange: [number, number] | null = null;
    for (let ai = 0; ai < outcomes.length; ai++) {
      for (let bi = ai + 1; bi < outcomes.length; bi++) {
        const a = outcomes[ai]!;
        const b = outcomes[bi]!;
        const adjacent = a.range[1] + 1 === b.range[0] || b.range[1] + 1 === a.range[0];
        if (!adjacent) continue;
        const low = Math.min(a.range[0], b.range[0]);
        const high = Math.max(a.range[1], b.range[1]);
        const pPair = bucketProb(adjForecast, low, high, sigma);
        if (pPair > bestPairP) {
          bestPairP = pPair;
          bestPairRange = [low, high];
        }
      }
    }
    if (bestPairP > 0 && bestPairRange) {
      const [low, high] = bestPairRange;
      const hit: 0 | 1 = actual >= low && actual <= high ? 1 : 0;
      samples.push({ pred: bestPairP, hit, market: m.city });
    }
  }
  return samples;
}

/** 由样本构建校准表 (不落盘)。 */
export function buildCdfCalibrationFromSamples(
  samples: { pred: number; hit: 0 | 1 }[],
): CdfCalibration | null {
  if (samples.length < 10) return null;
  const binsDef = [
    { min: -0.01, max: 0.15 },
    { min: 0.15, max: 0.3 },
    { min: 0.3, max: 0.5 },
    { min: 0.5, max: 1.01 },
  ];
  const bins: CdfBin[] = [];
  for (const def of binsDef) {
    const inB = samples.filter((s) => s.pred >= def.min && s.pred < def.max);
    const n = inB.length;
    const hits = inB.filter((s) => s.hit === 1).length;
    bins.push({
      min: def.min,
      max: def.max,
      n,
      hits,
      hit_rate: n > 0 ? Math.round((hits / n) * 10000) / 10000 : 0,
      avg_pred: n > 0 ? Math.round((inB.reduce((a, s) => a + s.pred, 0) / n) * 10000) / 10000 : 0,
    });
  }
  const nTotal = samples.length;
  const globalHits = samples.filter((s) => s.hit === 1).length;
  return {
    bins,
    global_hit_rate: Math.round((globalHits / nTotal) * 10000) / 10000,
    n_total: nTotal,
    updated_at: new Date().toISOString(),
  };
}

/**
 * 从已结算市场粗建 CDF 校准表 (方案 A) 并落盘。
 * 粗建阶段为 in-sample, 2-3 周真实数据后再做 LOO 验证。
 */
export function buildCdfCalibration(markets: MarketRecord[]): CdfCalibration | null {
  const samples = collectCdfSamples(markets);
  const cal = buildCdfCalibrationFromSamples(samples);
  if (!cal) return null;
  calCache = cal;
  writeFileSync(cdfCalibrationFilePath(), JSON.stringify(cal, null, 2), "utf-8");
  return cal;
}

/** 桶是否命中实际温度 (含开区间与单度桶语义)。 */
function inBucketHit(actual: number, range: [number, number]): 0 | 1 {
  const [lo, hi] = range;
  if (lo === -999) return actual <= hi ? 1 : 0;
  if (hi === 999) return actual >= lo ? 1 : 0;
  if (lo === hi) return actual >= lo - 0.5 && actual <= hi + 0.5 ? 1 : 0;
  return actual >= lo && actual <= hi ? 1 : 0;
}

/** 从 calibration.json 读 sigma 的本地兜底 (避免与 storage.ts 的 getSigma 循环依赖)。 */
function loadBaseSigma(m: MarketRecord): number {
  const key = `${m.city}_ecmwf`;
  const p = path.join(DATA_DIR, "calibration.json");
  if (existsSync(p)) {
    try {
      const cal = JSON.parse(readFileSync(p, "utf-8")) as Record<string, { sigma?: number }>;
      const v = cal[key]?.sigma;
      if (v != null && v > 0) return v;
    } catch {
      /* fall through */
    }
  }
  return m.unit === "F" ? 1.7 : 2.3;
}
