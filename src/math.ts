import { KELLY_FRACTION } from "./config.js";
import { getMarketSlope } from "./storage.js";

/** Abramowitz & Stegun approximation */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y =
    1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax));
  return sign * y;
}

export function normCdf(x: number): number {
  return 0.5 * (1.0 + erf(x / Math.sqrt(2.0)));
}

export function inBucket(forecast: number, tLow: number, tHigh: number): boolean {
  if (tLow === tHigh) {
    return Math.round(Number(forecast)) === Math.round(tLow);
  }
  return tLow <= Number(forecast) && Number(forecast) <= tHigh;
}

export function bucketProb(forecast: number, tLow: number, tHigh: number, sigma?: number): number {
  const s = sigma ?? 2.0;
  if (tLow === -999) {
    return normCdf((tHigh - Number(forecast)) / s);
  }
  if (tHigh === 999) {
    return 1.0 - normCdf((tLow - Number(forecast)) / s);
  }
  if (tLow === tHigh) {
    // Single-degree bucket (e.g. "be 24°C"): treat as ±0.5 range around the value.
    return normCdf((tHigh + 0.5 - Number(forecast)) / s) - normCdf((tHigh - 0.5 - Number(forecast)) / s);
  }
  // Range bucket (e.g. "between 86-87°F"): probability mass within [low, high].
  return normCdf((tHigh - Number(forecast)) / s) - normCdf((tLow - Number(forecast)) / s);
}

/**
 * 集合成员频次概率: 统计 ECMWF ENS 51 个成员的日最高温有多少落在目标桶内。
 *
 * 与 bucketProb (正态 CDF) 的区别: 正态分布假设单峰对称, 在冷锋过境/双峰场景
 * 下严重低估尾部风险。集合成员由物理扰动直接生成, 50 个成员里 40 个落在 30°C
 * 桶 = 真实概率 80%, 远比凭空想象的数学分布准确。
 *
 * @param membersMax 各成员的日最高温数组 (已纠偏)
 * @param tLow 桶下界 (-999 = or below)
 * @param tHigh 桶上界 (999 = or higher)
 * @returns 落在桶内的成员比例 [0,1]; 无成员时返回 -1 (调用方回退到 bucketProb)
 */
export function bucketProbEnsemble(
  membersMax: number[],
  tLow: number,
  tHigh: number,
): number {
  if (membersMax.length === 0) return -1;
  let hits = 0;
  for (const t of membersMax) {
    if (tLow === -999) {
      if (t <= tHigh) hits++;
    } else if (tHigh === 999) {
      if (t >= tLow) hits++;
    } else if (tLow === tHigh) {
      // Single-degree bucket: ±0.5 tolerance (matches bucketProb semantics).
      if (t >= tLow - 0.5 && t <= tHigh + 0.5) hits++;
    } else {
      if (t >= tLow && t <= tHigh) hits++;
    }
  }
  return hits / membersMax.length;
}

export function calcEv(p: number, price: number): number {
  if (price <= 0 || price >= 1) return 0.0;
  return Math.round((p * (1.0 / price - 1.0) - (1.0 - p)) * 10000) / 10000;
}

export function calcKelly(p: number, price: number): number {
  if (price <= 0 || price >= 1) return 0.0;
  const b = 1.0 / price - 1.0;
  const f = (p * b - (1.0 - p)) / b;
  return Math.round(Math.min(Math.max(0.0, f) * KELLY_FRACTION, 1.0) * 10000) / 10000;
}

/**
 * Recalibrate a raw market probability using a logit slope.
 * Weather markets are mildly overconfident: prices near 0/1 overstate the truth.
 * Slope defaults to the dynamically-fitted value (getMarketSlope, Logistic
 * regression over settled markets); falls back to MARKET_CAL_SLOPE=0.85 when
 * too few samples. Pass an explicit slope to override.
 */
export function marketCalibrated(p: number, slope?: number): number {
  const s = slope ?? getMarketSlope();
  if (p <= 0) return 0.0;
  if (p >= 1) return 1.0;
  const logit = Math.log(p / (1 - p));
  return Math.round((1 / (1 + Math.exp(-s * logit))) * 10000) / 10000;
}

export function betSize(kelly: number, balance: number, maxBet: number): number {
  const raw = kelly * balance;
  return Math.round(Math.min(raw, maxBet) * 100) / 100;
}

export function parseTempRange(question: string | undefined): [number, number] | null {
  if (!question) return null;
  const num = "(-?\\d+(?:\\.\\d+)?)";
  if (/or below/i.test(question)) {
    const m = new RegExp(`${num}[°]?[FC] or below`, "i").exec(question);
    if (m?.[1]) return [-999.0, Number.parseFloat(m[1])];
  }
  if (/or higher/i.test(question)) {
    const m = new RegExp(`${num}[°]?[FC] or higher`, "i").exec(question);
    if (m?.[1]) return [Number.parseFloat(m[1]), 999.0];
  }
  let m = new RegExp(`between ${num}-${num}[°]?[FC]`, "i").exec(question);
  if (m?.[1] && m[2]) return [Number.parseFloat(m[1]), Number.parseFloat(m[2])];
  m = new RegExp(`be ${num}[°]?[FC] on`, "i").exec(question);
  if (m?.[1]) {
    const v = Number.parseFloat(m[1]);
    return [v, v];
  }
  return null;
}

export function hoursToResolution(endDateStr: string): number {
  try {
    const end = new Date(endDateStr.replace("Z", "+00:00"));
    const now = new Date();
    return Math.max(0.0, (end.getTime() - now.getTime()) / 3600000);
  } catch {
    return 999.0;
  }
}
