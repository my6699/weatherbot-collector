/**
 * 验证集成成员频次在非正态场景下的优势
 *
 * 场景设计:
 *   1. 偏态分布: 模拟冷锋过境, 成员偏向低温侧 (长尾在高温)
 *   2. 双峰分布: 模拟两种可能的天气路径 (有云/无云, 降雨/晴)
 *   3. 正态分布: baseline 对比
 *
 * 预期: bucketProbEnsemble 能捕捉非正态特征, 正态 CDF 会误判概率
 */

import { bucketProb, bucketProbEnsemble, inBucket } from "../src/math.js";

// 生成 n 个偏态分布成员 (Gamma 分布近似)
// shape < 1 时右偏 (长尾在高温), shape > 1 时左偏 (长尾在低温)
function generateSkewedMembers(
  mean: number,
  spread: number,
  shape: number, // shape < 1 = 右偏, > 1 = 左偏
  n = 51,
): number[] {
  const members: number[] = [];
  // 用 Gamma 分布近似偏态
  // Gamma(shape, scale) 的 mean = shape * scale, var = shape * scale^2
  // 所以 scale = var / mean, shape = mean^2 / var
  const targetVar = spread * spread;
  const scale = targetVar / Math.abs(mean);
  const k = Math.abs(mean) / scale;

  for (let i = 0; i < n; i++) {
    // Marsaglia and Tsang's method for Gamma(k, 1)
    let gammaSample = 0;
    if (k >= 1) {
      const d = k - 1 / 3;
      const c = 1 / Math.sqrt(9 * d);
      while (true) {
        let x = randn();
        let v = 1 + c * x;
        v = v * v * v;
        if (v <= 0) continue;
        const u = Math.random();
        if (u < 1 - 0.0331 * (x * x) * (x * x)) {
          gammaSample = d * v * scale;
          break;
        }
        if (Math.log(u) <= 0.5 * x * x + d * Math.log(v) - d + d * v) {
          gammaSample = d * v * scale;
          break;
        }
      }
    } else {
      // For shape < 1, use transformation
      const u = Math.random();
      gammaSample = generateSkewedMembers(mean, spread, k + 1, 1)[0] * Math.pow(u, 1 / k);
    }

    // 平移到目标均值
    const sample = mean - (k * scale - mean) + gammaSample;
    members.push(Math.round(sample * 10) / 10);
  }
  return members;
}

// 简化的偏态生成 (用对数正态近似)
function generateLognormalSkewed(
  mean: number,
  spread: number,
  skewDir: "left" | "right", // left = 长尾在低温, right = 长尾在高温
  n = 51,
): number[] {
  // 对数正态参数反推
  // mean = exp(mu + sigma^2/2), var = (exp(sigma^2) - 1) * exp(2*mu + sigma^2)
  const targetVar = spread * spread;
  // 近似: sigma ~ sqrt(log(1 + var/mean^2))
  const sigma = Math.sqrt(Math.log(1 + targetVar / (mean * mean) + 0.1));
  const mu = Math.log(Math.abs(mean)) - sigma * sigma / 2;

  const members: number[] = [];
  for (let i = 0; i < n; i++) {
    // Lognormal: exp(mu + sigma * Z)
    let sample = Math.exp(mu + sigma * randn());
    // 根据偏态方向调整
    if (skewDir === "left") {
      // 长尾在低温: 取负值偏移
      sample = mean + spread - sample * 0.3;
    }
    members.push(Math.round(sample * 10) / 10);
  }
  return members;
}

// 生成双峰分布成员 (两个正态分布的混合)
// 模拟场景: 50% 概率有云 (低温) vs 50% 概率晴 (高温)
function generateBimodalMembers(
  peak1: number, // 第一个峰的均值 (如低温)
  peak2: number, // 第二个峰的均值 (如高温)
  sigma1: number, // 第一个峰的标准差
  sigma2: number, // 第二个峰的标准差
  mixRatio = 0.5, // 第一峰的比例
  n = 51,
): number[] {
  const members: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = Math.random();
    if (r < mixRatio) {
      members.push(Math.round((peak1 + randn() * sigma1) * 10) / 10);
    } else {
      members.push(Math.round((peak2 + randn() * sigma2) * 10) / 10);
    }
  }
  return members;
}

// 生成正态分布成员 (baseline)
function generateNormalMembers(mean: number, sigma: number, n = 51): number[] {
  return Array.from({ length: n }, () => Math.round((mean + randn() * sigma) * 10) / 10);
}

// 确定性随机数生成器
let seed = 42;
function randn(): number {
  seed = (seed * 9301 + 49297) % 233280;
  const u1 = Math.max(0.0001, seed / 233280);
  seed = (seed * 9301 + 49297) % 233280;
  const u2 = seed / 233280;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// 场景定义
interface Scenario {
  name: string;
  members: number[];
  actual_temp: number; // 真实温度
  bucket_low: number;
  bucket_high: number;
  description: string;
}

const scenarios: Scenario[] = [
  // 场景 1: 双峰分布 - 冷锋过境不确定性
  // 峰1: 28°C (冷锋到达), 峰2: 34°C (冷锋未到)
  // 实际: 冷锋到达, 最高温 29°C
  {
    name: "双峰-冷锋过境",
    members: generateBimodalMembers(28, 34, 1.0, 1.5, 0.5, 51),
    actual_temp: 29,
    bucket_low: 27,
    bucket_high: 30,
    description: "峰1=28°C(冷锋到), 峰2=34°C(未到), 实际29°C(冷锋到)",
  },

  // 场景 2: 双峰分布 - 对流降雨不确定性
  // 峰1: 32°C (有对流雨), 峰2: 38°C (无雨)
  // 实际: 无雨, 最高温 37°C
  {
    name: "双峰-对流降雨",
    members: generateBimodalMembers(32, 38, 1.5, 1.0, 0.4, 51),
    actual_temp: 37,
    bucket_low: 35,
    bucket_high: 38,
    description: "峰1=32°C(有雨), 峰2=38°C(无雨), 实际37°C(无雨)",
  },

  // 场景 3: 偏态分布 - 热浪长尾
  // 均值 35°C, 但有极端高温尾部 (热浪加强概率)
  // 实际: 极端高温 40°C
  {
    name: "偏态-热浪长尾",
    members: generateLognormalSkewed(35, 3, "right", 51),
    actual_temp: 40,
    bucket_low: 39,
    bucket_high: 42,
    description: "均值35°C, 右偏(高温长尾), 实际40°C(极端高温)",
  },

  // 场景 4: 偏态分布 - 冷锋速过
  // 均值 25°C, 左偏 (低温长尾 - 冷锋可能早到)
  // 实际: 冷锋早到, 最高温仅 22°C
  {
    name: "偏态-冷锋早到",
    members: generateLognormalSkewed(25, 3, "left", 51),
    actual_temp: 22,
    bucket_low: 20,
    bucket_high: 23,
    description: "均值25°C, 左偏(低温长尾), 实际22°C(冷锋早到)",
  },

  // 场景 5: 正态分布 - baseline 对比
  // 均值 30°C, sigma=2
  // 实际: 31°C
  {
    name: "正态-baseline",
    members: generateNormalMembers(30, 2, 51),
    actual_temp: 31,
    bucket_low: 29,
    bucket_high: 32,
    description: "均值30°C, sigma=2, 实际31°C(正态中心)",
  },

  // 场景 6: 双峰 - 模型分歧剧烈
  // ECMWF 预测 25°C (有云), GFS 预测 35°C (晴)
  // 成员分布: 25 个在 25±1, 26 个在 35±1
  // 实际: 中间态, 最高温 30°C (两个峰都没命中)
  {
    name: "双峰-模型分歧",
    members: generateBimodalMembers(25, 35, 1.0, 1.0, 0.5, 51),
    actual_temp: 30,
    bucket_low: 29,
    bucket_high: 31,
    description: "峰1=25°C, 峰2=35°C, 实际30°C(中间空隙)",
  },
];

// 辅助函数: 计算成员统计量
function memberStats(members: number[]): { mean: number; std: number; min: number; max: number; p10: number; p90: number } {
  const sorted = [...members].sort((a, b) => a - b);
  const mean = members.reduce((a, b) => a + b, 0) / members.length;
  const std = Math.sqrt(members.reduce((s, x) => s + (x - mean) ** 2, 0) / members.length);
  return {
    mean: Math.round(mean * 10) / 10,
    std: Math.round(std * 10) / 10,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    p10: sorted[Math.floor(members.length * 0.1)]!,
    p90: sorted[Math.floor(members.length * 0.9)]!,
  };
}

// 主函数
function main(): void {
  console.log("=".repeat(80));
  console.log("集成成员频次 vs 正态 CDF — 非正态场景验证");
  console.log("=".repeat(80));

  const results: {
    scenario: string;
    p_ensemble: number;
    p_cdf: number;
    actual_hit: number;
    brier_ensemble: number;
    brier_cdf: number;
    winner: string;
  }[] = [];

  for (const s of scenarios) {
    console.log(`\n【${s.name}】 ${s.description}`);
    console.log("-".repeat(60));

    // 成员统计
    const stats = memberStats(s.members);
    console.log(`成员分布: mean=${stats.mean}°C, std=${stats.std}°C, range=[${stats.min}, ${stats.max}]°C`);
    console.log(`          p10=${stats.p10}°C, p90=${stats.p90}°C`);

    // 集成成员频次概率
    const pEnsemble = bucketProbEnsemble(s.members, s.bucket_low, s.bucket_high);

    // 正态 CDF 概率 (用成员统计的均值和 std)
    const pCdf = bucketProb(stats.mean, s.bucket_low, s.bucket_high, stats.std);

    // 实际是否命中
    const actualHit = inBucket(s.actual_temp, s.bucket_low, s.bucket_high) ? 1 : 0;

    // Brier Score
    const brierEns = Math.pow(pEnsemble - actualHit, 2);
    const brierCdf = Math.pow(pCdf - actualHit, 2);

    console.log(`\n目标桶: ${s.bucket_low}-${s.bucket_high}°C`);
    console.log(`实际温度: ${s.actual_temp}°C → ${actualHit === 1 ? "命中 ✓" : "未命中 ✗"}`);
    console.log(`\n概率预测:`);
    console.log(`  集成成员频次: ${pEnsemble.toFixed(3)} (${(pEnsemble * 100).toFixed(1)}%)`);
    console.log(`  正态 CDF     : ${pCdf.toFixed(3)} (${(pCdf * 100).toFixed(1)}%)`);
    console.log(`\nBrier Score (lower is better):`);
    console.log(`  集成成员频次: ${brierEns.toFixed(4)}`);
    console.log(`  正态 CDF     : ${brierCdf.toFixed(4)}`);

    const winner = brierEns < brierCdf ? "集成成员胜" : brierEns > brierCdf ? "正态CDF胜" : "平局";
    console.log(`  → ${winner}`);

    results.push({
      scenario: s.name,
      p_ensemble: pEnsemble,
      p_cdf: pCdf,
      actual_hit: actualHit,
      brier_ensemble: brierEns,
      brier_cdf: brierCdf,
      winner,
    });
  }

  // 汇总
  console.log("\n" + "=".repeat(80));
  console.log("汇总对比");
  console.log("=".repeat(80));
  console.log(`${"场景".padEnd(20)} | ${"集成概率".padEnd(10)} | ${"CDF概率".padEnd(10)} | ${"实际命中".padEnd(8)} | ${"集成Brier".padEnd(10)} | ${"CDF Brier".padEnd(10)} | 胜者`);
  console.log("-".repeat(100));
  for (const r of results) {
    console.log(
      `${r.scenario.padEnd(20)} | ${(r.p_ensemble * 100).toFixed(1).padEnd(10)}% | ${(r.p_cdf * 100).toFixed(1).padEnd(10)}% | ${r.actual_hit === 1 ? "命中".padEnd(8) : "未中".padEnd(8)} | ${r.brier_ensemble.toFixed(4).padEnd(10)} | ${r.brier_cdf.toFixed(4).padEnd(10)} | ${r.winner}`,
    );
  }

  const ensWins = results.filter((r) => r.winner === "集成成员胜").length;
  const cdfWins = results.filter((r) => r.winner === "正态CDF胜").length;
  const draws = results.filter((r) => r.winner === "平局").length;

  console.log("\n" + "=".repeat(80));
  console.log(`总计: 集成成员胜 ${ensWins} 局, 正态CDF胜 ${cdfWins} 局, 平局 ${draws} 局`);
  console.log(`平均 Brier Score: 集成成员 ${(results.reduce((s, r) => s + r.brier_ensemble, 0) / results.length).toFixed(4)} vs 正态CDF ${(results.reduce((s, r) => s + r.brier_cdf, 0) / results.length).toFixed(4)}`);

  // 直方图可视化 (ASCII)
  console.log("\n" + "=".repeat(80));
  console.log("成员分布可视化 (场景1 双峰-冷锋过境):");
  console.log("=".repeat(80));
  const s1 = scenarios[0]!;
  const hist: Record<number, number> = {};
  for (const m of s1.members) {
    const bucket = Math.round(m);
    hist[bucket] = (hist[bucket] || 0) + 1;
  }
  const temps = Object.keys(hist).map(Number).sort((a, b) => a - b);
  const maxCount = Math.max(...Object.values(hist));
  for (const t of temps) {
    const count = hist[t]!;
    const barLen = Math.round((count / maxCount) * 40);
    const bar = "█".repeat(barLen);
    console.log(`${t}°C | ${bar} (${count})`);
  }
}

main();