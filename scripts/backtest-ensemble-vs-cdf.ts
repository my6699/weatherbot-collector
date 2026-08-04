/* 验证集成成员频次 vs 正态 CDF 的 Brier Score 差异
 *
 * 核心问题: 我们在 2026-08-04 部署了 ECMWF ENS 51 成员物理概率 (bucketProbEnsemble),
 * 替代之前的正态 CDF (bucketProb)。本地验证显示 NYC 08-04 桶概率从 0.197 跳到 0.920,
 * 但需要在全部 80 个已结算市场上量化 Brier Score 改善幅度。
 *
 * 历史快照没有 membersMax (这是新功能), 所以我们用快照中的均值和离散度
 * 生成模拟的 51 个正态分布成员, 来模拟集成成员的效果。
 *
 * 对比:
 *   1. bucketProb (正态 CDF, sigma=city_cal)
 *   2. bucketProbEnsemble (51 个模拟正态成员, 用快照 spread)
 *   3. bucketProbEnsemble (51 个模拟均匀分布成员, 更分散)
 *
 * Brier Score = mean((p_predicted - actual_outcome)^2), 越低越好。
 *
 * Run: npx tsx scripts/backtest-ensemble-vs-cdf.ts
 */

import { readdirSync, readFileSync } from "fs";
import path from "path";
import { bucketProb, bucketProbEnsemble, inBucket } from "../src/math.js";
import { getSigma, loadAllMarkets } from "../src/storage.js";
import { LOCATIONS } from "../src/config.js";

const DIR = path.join(process.cwd(), "data", "markets");

// Box-Muller 生成标准正态随机数 (确定性种子便于复现)
let seed = 42;
function randn(): number {
  seed = (seed * 9301 + 49297) % 233280;
  const u1 = seed / 233280;
  seed = (seed * 9301 + 49297) % 233280;
  const u2 = seed / 233280;
  return Math.sqrt(-2 * Math.log(u1 || 0.0001)) * Math.cos(2 * Math.PI * u2);
}

/** 用均值和 sigma 生成 n 个模拟成员 (正态分布)。 */
function generateNormalMembers(mean: number, sigma: number, n = 51): number[] {
  return Array.from({ length: n }, () => Math.round((mean + randn() * sigma) * 10) / 10);
}

/** 用均值和 spread 生成 n 个模拟成员 (均匀分布, 更分散)。 */
function generateUniformMembers(mean: number, spread: number, n = 51): number[] {
  const halfRange = Math.max(0.5, spread * 1.5);
  return Array.from({ length: n }, () =>
    Math.round((mean - halfRange + Math.random() * 2 * halfRange) * 10) / 10,
  );
}

interface OutcomeRow {
  range: [number, number];
  low: number;
  high: number;
}

interface MarketForBrier {
  city: string;
  city_name: string;
  date: string;
  unit: "F" | "C";
  actual_temp: number;
  forecast_temp: number; // 开仓时刻的预测温度 (已 bias 修正)
  sigma: number;
  outcomes: OutcomeRow[];
  position: { bucket_low: number; bucket_high: number };
}

function main(): void {
  const markets = loadAllMarkets();
  const resolved = markets.filter((m) => m.status === "resolved" && m.actual_temp != null);
  console.log(`[BACKTEST] ${resolved.length} resolved markets found`);

  // 收集每个持仓的数据 (我们关心的是"在当时的预测下, 各桶的概率预测准确度")
  const records: MarketForBrier[] = [];
  for (const m of resolved) {
    const loc = LOCATIONS[m.city];
    if (!loc || m.actual_temp == null) continue;

    // 取最后一个快照的 best (bias 修正后), 或者 position 里的 forecast_temp
    const snaps = m.forecast_snapshots ?? [];
    let forecastTemp = 0;
    if (snaps.length > 0) {
      const last = snaps[snaps.length - 1];
      forecastTemp = last?.best ?? m.positions?.[0]?.forecast_temp ?? 0;
    } else {
      forecastTemp = m.positions?.[0]?.forecast_temp ?? 0;
    }
    if (forecastTemp === 0) continue;

    const sigma = getSigma(m.city);
    const outcomes: OutcomeRow[] = (m.all_outcomes ?? []).map((o) => ({
      range: o.range,
      low: o.range[0],
      high: o.range[1],
    }));
    if (outcomes.length === 0) continue;

    const pos = m.positions?.[0];
    if (!pos) continue;

    records.push({
      city: m.city,
      city_name: m.city_name,
      date: m.date,
      unit: m.unit,
      actual_temp: m.actual_temp,
      forecast_temp: forecastTemp,
      sigma,
      outcomes,
      position: { bucket_low: pos.bucket_low, bucket_high: pos.bucket_high },
    });
  }

  console.log(`[BACKTEST] ${records.length} records with valid forecast+actual`);

  // 对每条记录, 计算每个桶的预测概率 vs 实际结果 (0 or 1)
  // 用三种方法:
  const brierNormalCdf: number[] = []; // 正态 CDF
  const brierEnsembleNormal: number[] = []; // 集成成员 (正态模拟)
  const brierEnsembleUniform: number[] = []; // 集成成员 (均匀模拟, 更分散)

  for (const r of records) {
    for (const o of r.outcomes) {
      const { low, high } = o;
      const actual = inBucket(r.actual_temp, low, high) ? 1 : 0;

      // 方法 1: 正态 CDF
      const pNorm = bucketProb(r.forecast_temp, low, high, r.sigma);
      brierNormalCdf.push(Math.pow(pNorm - actual, 2));

      // 方法 2: 集成成员 (正态模拟, sigma 用城市校准值)
      const membersNorm = generateNormalMembers(r.forecast_temp, r.sigma);
      const pEnsNorm = bucketProbEnsemble(membersNorm, low, high);
      brierEnsembleNormal.push(Math.pow(pEnsNorm - actual, 2));

      // 方法 3: 集成成员 (均匀模拟, range=forecast ± 2σ)
      const spreadRange = r.sigma * 2; // 用 2σ 作为 spread 范围
      const membersUni = generateUniformMembers(r.forecast_temp, spreadRange);
      const pEnsUni = bucketProbEnsemble(membersUni, low, high);
      brierEnsembleUniform.push(Math.pow(pEnsUni - actual, 2));
    }
  }

  const avg = (arr: number[]) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  const brierNorm = avg(brierNormalCdf);
  const brierEnsNorm = avg(brierEnsembleNormal);
  const brierEnsUni = avg(brierEnsembleUniform);

  console.log("\n[BRIER SCORE] 对比 (lower is better):");
  console.log(`  正态 CDF (baseline)       : ${brierNorm.toFixed(4)}  (n=${brierNormalCdf.length})`);
  console.log(`  集成成员(正态模拟)        : ${brierEnsNorm.toFixed(4)}  (n=${brierEnsembleNormal.length})  [Δ=${((brierNorm - brierEnsNorm) * 100).toFixed(2)}%]`);
  console.log(`  集成成员(均匀模拟)        : ${brierEnsUni.toFixed(4)}  (n=${brierEnsembleUniform.length})  [Δ=${((brierNorm - brierEnsUni) * 100).toFixed(2)}%]`);

  // 命中率对比: 预测概率 > 0.5 的桶是否实际命中
  const hitRate = (arr: { p: number; actual: number }[], threshold = 0.5) => {
    const predicted = arr.filter((a) => a.p > threshold);
    if (predicted.length === 0) return { total: 0, hits: 0, rate: 0 };
    const hits = predicted.filter((a) => a.actual === 1).length;
    return { total: predicted.length, hits, rate: (hits / predicted.length) * 100 };
  };

  const details: { pNorm: number; pEnsNorm: number; pEnsUni: number; actual: number }[] = [];
  for (const r of records) {
    for (const o of r.outcomes) {
      const actual = inBucket(r.actual_temp, o.low, o.high) ? 1 : 0;
      details.push({
        pNorm: bucketProb(r.forecast_temp, o.low, o.high, r.sigma),
        pEnsNorm: bucketProbEnsemble(generateNormalMembers(r.forecast_temp, r.sigma), o.low, o.high),
        pEnsUni: bucketProbEnsemble(generateUniformMembers(r.forecast_temp, r.sigma * 2), o.low, o.high),
        actual,
      });
    }
  }

  const r50Norm = hitRate(details.map((d) => ({ p: d.pNorm, actual: d.actual })));
  const r50EnsNorm = hitRate(details.map((d) => ({ p: d.pEnsNorm, actual: d.actual })));
  const r50EnsUni = hitRate(details.map((d) => ({ p: d.pEnsUni, actual: d.actual })));

  console.log("\n[HIT RATE] 预测概率 > 50% 的桶是否实际命中:");
  console.log(`  正态 CDF     : ${r50Norm.hits}/${r50Norm.total} = ${r50Norm.rate.toFixed(1)}%`);
  console.log(`  集成(正态)   : ${r50EnsNorm.hits}/${r50EnsNorm.total} = ${r50EnsNorm.rate.toFixed(1)}%`);
  console.log(`  集成(均匀)   : ${r50EnsUni.hits}/${r50EnsUni.total} = ${r50EnsUni.rate.toFixed(1)}%`);

  // 分桶类型: 窄桶 (range <= 2) vs 宽桶
  const narrowBuckets = details.filter((_, i) => {
    const r = records[Math.floor(i / (records[0]?.outcomes.length ?? 1))];
    const o = r?.outcomes[i % (r?.outcomes.length ?? 1)];
    return o ? o.high - o.low <= 2 : false;
  });

  console.log("\n[NOTE] 此回测用模拟成员 (正态/均匀) 近似 ECMWF ENS 真实成员。");
  console.log("  真实 ENS 成员包含物理扰动 (冷锋/对流等), 在双峰场景下会比模拟成员");
  console.log("  表现更好。等积累更多带 membersMax 的快照后, 可重跑获得真实 Brier Score。");
}

main();
