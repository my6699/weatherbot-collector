/**
 * 双桶区间套利分析: 统计 D-0 当天"两桶合计 >= TOP2_SUM_TRIGGER"出现的时间点。
 *
 * 数据来源: data/markets/*.json 的 market_snapshots 数组。
 * - 旧快照 (2026-08-04 之前): 只有 top_bucket/top_price (单桶最高价)
 * - 新快照 (2026-08-04 之后): 有 top2_bucket/top2_price/top2_sum (两桶合计, 真实记录)
 *
 * 输出:
 *   1. 新格式快照: 两桶合计触发 TOP2_SUM 的时间点 (距结算小时数)
 *   2. 旧数据保守下界: 单桶最高价 >= 阈值的触发时点 (单桶达标 => 两桶必然达标)
 *   3. 新格式两桶信号与实际命中的关系 (套利安全性)
 *
 * 注意: 旧数据的 all_outcomes 只保存最终状态, 无法重建历史两桶价格,
 *       因此旧数据的"两桶合计"不可信, 只统计单桶信号。
 *
 * Run: npx tsx scripts/analyze-top2-sum.ts
 */

import { readdirSync, readFileSync } from "fs";
import path from "path";
import { TOP2_SUM_TRIGGER } from "../src/config.js";
import { inBucket } from "../src/math.js";

interface MarketSnap {
  ts?: string;
  top_bucket: string | null;
  top_price: number | null;
  top2_bucket?: string | null;
  top2_price?: number | null;
  top2_sum?: number | null;
}

interface MarketRecord {
  city: string;
  city_name: string;
  date: string;
  unit: "F" | "C";
  status: string;
  actual_temp: number | null;
  event_end_date: string;
  market_snapshots: MarketSnap[];
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

/** 结算前 hours_left (从快照时间到 event_end_date) */
function hoursLeftOf(ts: string, endDate: string): number {
  const t = new Date(ts).getTime();
  const end = new Date(endDate).getTime();
  if (Number.isNaN(t) || Number.isNaN(end)) return NaN;
  return (end - t) / 3600000;
}

interface TriggerRecord {
  city: string;
  date: string;
  ts: string;
  hours_left: number;
  top2_sum: number;
  bucket: string;
}

interface SingleRecord {
  city: string;
  date: string;
  ts: string;
  hours_left: number;
  top_price: number;
}

function main(): void {
  const markets = loadAllMarkets();
  console.log(`[ANALYZE] ${markets.length} markets, TOP2_SUM_TRIGGER = ${TOP2_SUM_TRIGGER}\n`);

  // === 1. 新格式快照: 真实两桶合计 ===
  let newSnapCount = 0;
  let newOverTrigger = 0;
  const newTriggers: TriggerRecord[] = [];
  const allNewSums: number[] = [];

  for (const m of markets) {
    const snaps = m.market_snapshots ?? [];
    for (const s of snaps) {
      if (s.top2_sum == null) continue;
      const hl = s.ts ? hoursLeftOf(s.ts, m.event_end_date) : NaN;
      if (Number.isNaN(hl) || hl < 0) continue; // 排除结算后
      newSnapCount++;
      allNewSums.push(s.top2_sum);
      if (s.top2_sum >= TOP2_SUM_TRIGGER) {
        newOverTrigger++;
        newTriggers.push({
          city: m.city_name,
          date: m.date,
          ts: s.ts ?? "",
          hours_left: Math.round(hl * 10) / 10,
          top2_sum: Math.round(s.top2_sum * 1000) / 1000,
          bucket: s.top2_bucket ?? "",
        });
      }
    }
  }

  console.log("=".repeat(70));
  console.log(`1. 新格式快照 (真实两桶合计): ${newSnapCount} 条`);
  console.log("=".repeat(70));
  if (newSnapCount === 0) {
    console.log("   暂无真实数据 (collect-data 每次运行都会积累, 1-2 天后重跑本脚本)");
  } else {
    allNewSums.sort((a, b) => a - b);
    const avg = allNewSums.reduce((a, b) => a + b, 0) / allNewSums.length;
    console.log(`   两桶合计均值: ${avg.toFixed(3)}`);
    console.log(`   两桶合计 >= ${TOP2_SUM_TRIGGER}: ${newOverTrigger}/${newSnapCount}`);
    console.log(`   两桶合计 >= 0.90: ${allNewSums.filter((v) => v >= 0.9).length}`);
    console.log(`   两桶合计 >= 1.00: ${allNewSums.filter((v) => v >= 1.0).length}`);
  }

  // === 2. 新格式触发市场明细 ===
  console.log("\n" + "=".repeat(70));
  console.log(`2. 新格式触发 TOP2_SUM >= ${TOP2_SUM_TRIGGER} (${newTriggers.length}条)`);
  console.log("=".repeat(70));
  if (newTriggers.length > 0) {
    newTriggers.sort((a, b) => b.hours_left - a.hours_left);
    console.log(`   ${"城市".padEnd(16)} | ${"日期".padEnd(12)} | ${"距结算h".padEnd(8)} | ${"两桶合计".padEnd(9)} | 桶区间`);
    console.log("   " + "-".repeat(70));
    for (const t of newTriggers) {
      console.log(
        `   ${t.city.padEnd(16)} | ${t.date.padEnd(12)} | ${t.hours_left.toFixed(1).padEnd(8)} | $${t.top2_sum.toFixed(3).padEnd(7)} | ${t.bucket}`,
      );
    }
    // 触发时刻分布
    const hls = newTriggers.map((t) => t.hours_left).sort((a, b) => a - b);
    console.log("\n   触发时刻分布 (距结算小时数):");
    const bins = [
      { label: "0-2h (临结算)", min: 0, max: 2 },
      { label: "2-4h", min: 2, max: 4 },
      { label: "4-6h", min: 4, max: 6 },
      { label: "6-8h", min: 6, max: 8 },
      { label: "8-12h (D-0早)", min: 8, max: 12 },
      { label: "12h+ (更早)", min: 12, max: 999 },
    ];
    for (const bin of bins) {
      const count = hls.filter((h) => h >= bin.min && h < bin.max).length;
      const bar = "█".repeat(Math.round((count / Math.max(1, hls.length)) * 30));
      console.log(`   ${bin.label.padEnd(14)}: ${String(count).padEnd(4)} ${bar}`);
    }
    console.log(`   中位数: ${hls[Math.floor(hls.length / 2)]!.toFixed(1)}h 前触发`);
    console.log(`   最早: ${hls[0]!.toFixed(1)}h  最晚: ${hls[hls.length - 1]!.toFixed(1)}h`);
  } else {
    console.log("   无真实触发记录 (需积累数据)");
  }

  // === 3. 旧数据保守下界: 单桶最高价 ===
  const singleTriggers: SingleRecord[] = [];
  for (const m of markets) {
    for (const s of m.market_snapshots ?? []) {
      if (s.top2_sum != null) break; // 新格式市场跳过 (由上面统计)
      const hl = s.ts ? hoursLeftOf(s.ts, m.event_end_date) : NaN;
      if (Number.isNaN(hl) || hl < 0 || hl > 24) continue;
      if (s.top_price != null && s.top_price >= TOP2_SUM_TRIGGER) {
        singleTriggers.push({
          city: m.city_name,
          date: m.date,
          ts: s.ts ?? "",
          hours_left: Math.round(hl * 10) / 10,
          top_price: s.top_price,
        });
        break;
      }
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log(`3. 旧数据保守下界 (单桶最高价 >= ${TOP2_SUM_TRIGGER}): ${singleTriggers.length}个市场`);
  console.log("=".repeat(70));
  if (singleTriggers.length > 0) {
    const hls = singleTriggers.map((s) => s.hours_left).sort((a, b) => a - b);
    console.log(`   单桶触发中位数: ${hls[Math.floor(hls.length / 2)]!.toFixed(1)}h 前`);
    console.log(`   最早: ${hls[0]!.toFixed(1)}h  最晚: ${hls[hls.length - 1]!.toFixed(1)}h`);
    console.log(`   (单桶达阈值 => 两桶必然已达阈值, 是两桶信号的保守下界)`);
    const bins = [
      { label: "0-2h", min: 0, max: 2 },
      { label: "2-4h", min: 2, max: 4 },
      { label: "4-6h", min: 4, max: 6 },
      { label: "6-8h", min: 6, max: 8 },
      { label: "8-12h", min: 8, max: 12 },
      { label: "12-24h", min: 12, max: 24 },
    ];
    for (const bin of bins) {
      const count = hls.filter((h) => h >= bin.min && h < bin.max).length;
      const bar = "█".repeat(Math.round((count / Math.max(1, hls.length)) * 30));
      console.log(`   ${bin.label.padEnd(10)}: ${String(count).padEnd(4)} ${bar}`);
    }
  } else {
    console.log("   无数据");
  }

  // === 4. 新格式两桶信号与实际命中 (套利安全性) ===
  console.log("\n" + "=".repeat(70));
  console.log("4. 两桶信号与实际命中的关系 (套利安全性)");
  console.log("=".repeat(70));
  const resolved = markets.filter((m) => m.status === "resolved" && m.actual_temp != null);
  console.log(`   已结算市场: ${resolved.length}个`);
  if (newTriggers.length > 0) {
    let hit = 0;
    let total = 0;
    for (const t of newTriggers) {
      const m = markets.find((x) => x.city_name === t.city && x.date === t.date);
      if (!m || m.actual_temp == null) continue;
      const m2 = t.bucket.match(/(-?\d+)-(-?\d+)/);
      if (!m2) continue;
      const low = Number(m2[1]);
      const high = Number(m2[2]);
      total++;
      if (inBucket(m.actual_temp, low, high)) hit++;
    }
    console.log(`   触发且已结算: ${total}个`);
    if (total > 0) {
      console.log(`   实际温度落在两桶区间: ${hit}/${total} = ${((hit / total) * 100).toFixed(1)}%`);
      console.log(`   (越高 => 两桶信号越可靠, 卖出锁利越安全)`);
    }
  } else {
    console.log("   暂无真实两桶信号可验证, 待数据积累");
  }

  // === 5. 建议 ===
  console.log("\n" + "=".repeat(70));
  console.log("5. 下一步");
  console.log("=".repeat(70));
  console.log(`   - 每次 collect-data 运行都会为 D-0 市场记录 top2_sum`);
  console.log(`   - 1-2 天后重跑: npx tsx scripts/analyze-top2-sum.ts`);
  console.log(`   - 数据足够后即可确定"两桶合计 > ${TOP2_SUM_TRIGGER} 在 D-0 几点出现"`);
}

main();
