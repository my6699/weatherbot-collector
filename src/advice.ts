import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { ADVICE_DIR, ADVICE_ENABLED, ENDGAME_TAKE_PROFIT } from "./config.js";
import { hoursToResolution, marketCalibrated } from "./math.js";
import { askAdviceNarration } from "./llm.js";
import { loadState } from "./storage.js";
import type { MarketRecord, Position } from "./storage.js";

export interface AdviceCtx {
  locName: string;
  date: string;
  horizon: string;
  unitSym: string;
}

function bucketLabel(signal: Position, unitSym: string): string {
  if (signal.bucket_low === -999) return `${signal.bucket_high}${unitSym} 或以下`;
  if (signal.bucket_high === 999) return `${signal.bucket_low}${unitSym} 或以上`;
  return `${signal.bucket_low}-${signal.bucket_high}${unitSym}`;
}

/** Filename-safe bucket part (open-ended buckets become below/above). */
function bucketFilePart(signal: Position): string {
  const lo = signal.bucket_low === -999 ? "below" : String(signal.bucket_low);
  const hi = signal.bucket_high === 999 ? "above" : String(signal.bucket_high);
  return `${lo}-${hi}`;
}

/**
 * Generate a beginner-friendly investment-advice report after a buy executes.
 * Deterministic template (always works offline) + optional AI plain-language
 * section. Never throws — failures are logged by the caller and ignored.
 */
export async function writeInvestmentAdvice(
  mkt: MarketRecord,
  signal: Position,
  ctx: AdviceCtx,
): Promise<string | null> {
  if (!ADVICE_ENABLED) return null;
  mkdirSync(ADVICE_DIR, { recursive: true });

  const unitSym = ctx.unitSym;
  const bucket = bucketLabel(signal, unitSym);
  const entry = signal.entry_price;
  const bidAtEntry = signal.bid_at_entry ?? entry;
  const edge = Math.round((signal.p - marketCalibrated(entry)) * 10000) / 10000;
  const endDate = mkt.event_end_date ?? "";
  const hours = endDate ? hoursToResolution(endDate) : 0;
  const stop = signal.stop_price ?? Math.min(entry * 0.8, bidAtEntry * 0.8);
  const isEndgame = signal.strategy === "endgame";
  const takeProfit = isEndgame ? ENDGAME_TAKE_PROFIT : hours < 48 ? 0.85 : 0.75;
  const winPnl = Math.round(signal.shares * (1 - entry) * 100) / 100;
  const balPct = Math.round((signal.cost / Math.max(1, loadState().balance)) * 1000) / 10;
  const forecast = signal.forecast_temp;
  const source = signal.forecast_src ?? "ensemble";
  const strategyLabel = isEndgame
    ? "终局确定性扫盘（临近结算，机场实时观测已基本锁定最高温，市场定价还没跟上）"
    : "常规模型边缘套利（基于多模型气象预报与市场定价的差异）";

  const why =
    isEndgame && forecast != null
      ? `机场实时观测（METAR）已达 ${forecast}${unitSym}，临近结算基本锁定了最高温会落在 ${bucket}，而市场定价还没跟上，所以出现套利空间。`
      : `多模型气象预报（ECMWF+GFS+ICON 加权）预测最高温 ${forecast ?? "未知"}${unitSym}（来源：${source}），我们据此算出 "${bucket}" 的概率为 ${(signal.p * 100).toFixed(0)}%。`;

  const file = path.join(
    ADVICE_DIR,
    `investment_advice_${mkt.city}_${mkt.date}_${bucketFilePart(signal)}.md`,
  );

  let aiPara = "";
  const narration = await askAdviceNarration({
    city: mkt.city_name,
    date: mkt.date,
    bucket,
    forecast,
    unit: unitSym,
    our_prob: signal.p,
    ask: entry,
    edge,
    cost: signal.cost,
    strategy: strategyLabel,
  });
  if (narration) aiPara = `\n${narration}\n`;

  const md = `# 投资机会报告 — ${mkt.city_name} ${mkt.date}

> 生成时间：${new Date().toISOString().replace("T", " ").slice(0, 19)}（UTC）

## 一、这是个什么机会？
Polymarket 上有一个预测市场：「**${mkt.city_name} ${mkt.date} 的最高气温是多少**」。市场按温度区间分成多个结果，结算时哪个区间包含实际最高温，它的"YES"就值 1 美元。
我们这次下注的区间是 **${bucket}** —— 也就是赌「当天最高温会落在 ${bucket}」。

## 二、为什么买？
${why}
- 我们算出的概率：**${(signal.p * 100).toFixed(0)}%**
- 市场买入价（ask）：**$${entry.toFixed(3)}**
- 价差（edge）：**${(edge * 100).toFixed(1)}%** —— 我们认为的真实概率比市场定价高这么多，长期按这个思路下注会赚钱
- 期望收益（EV）：**+${signal.ev.toFixed(2)} 美元/股** —— 平均每买 1 股，长期预期赚这么多
- 策略：${strategyLabel}

## 三、花了多少钱？
- 下注金额：**$${signal.cost.toFixed(2)}**（约占账户 **${balPct}%**）
- 买入价：$${entry.toFixed(3)}，持有 **${signal.shares}** 股
- 开盘价差（spread）：${(signal.spread ?? 0).toFixed(3)}（越小越好，是进出场的隐性成本）

## 四、风险有多大？
- **最坏情况：这 $${signal.cost.toFixed(2)} 全部亏掉** —— 结果没落在我们赌的区间，YES 变成 0 美元
- 我们只有 ${(signal.p * 100).toFixed(0)}% 的把握，也就是说大约还有 ${(100 - signal.p * 100).toFixed(0)}% 的概率不中
- 天气预报本身有误差（模型不确定度 σ=${signal.sigma}），越临近结算预报越准，但我们买的是"最高温"，白天温度可能还会变化
- 提醒：这是预测市场，本质是概率游戏，任何策略都不能保证盈利，请用亏得起的钱参与

## 五、什么时候见结果？
- 结算时间：${endDate || "未公布"}（约 ${hours.toFixed(0)} 小时后）
- 结算后：赌中 → 每股变成 1 美元（赚 **$${winPnl.toFixed(2)}**）；没中 → 归零

## 六、中途如何退出？
- 止盈：价格涨到 **$${takeProfit.toFixed(2)}** 就卖出，落袋为安
- 止损：价格跌破 **$${stop.toFixed(3)}** 就卖出，避免亏更多
- 预报大幅变化：如果模型改口（预报温度明显偏离这个区间），也会提前卖出

## 七、AI 大白话解读${aiPara}

---
> 本报告由天气机器人自动生成，仅供参考，不构成任何投资建议。市场有风险，决策需谨慎。
`;

  writeFileSync(file, md, "utf-8");
  return file;
}
