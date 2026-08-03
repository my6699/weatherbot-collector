/* LLM 门控回测: 回放 AI 对历史已结算交易的 skip/proceed 判断 (2026-08-04)
 *
 * 目的: 量化 "加上 LLM_GATE + LLM_PROVIDER2 (双AI门控)" 对历史胜率/PnL 的影响.
 * 方法: 对每个已结算 position, 重建 askTradeAdvisor 的输入 (forecast/sigma/metar/
 *   bucket/ask/bid/our_prob/edge/ev/volume/spread/hours_left, 均不含 actual_temp
 *   未来信息), 调真实 LLM 判断, 再用 position 的实际 pnl/命中 对比:
 *     - 无门控 (全买)  vs  AI门控 (只买 proceed)
 *     - skip 组 (AI砍掉) 的实际 PnL -> 若为负说明 AI 砍对, 若为正说明误杀
 * 单/双 AI 由 env WEATHERBOT_LLM_PROVIDER2 决定 (双AI需配 DEEPSEEK_API_KEY).
 *
 * 局限 (必须在解读时考虑):
 *   1. LLM 非确定: 重跑结果可能略有不同; 这里是一次性快照.
 *   2. 未来信息偏差: LLM 训练数据可能含个别天气事件结果, 但具体日期的最高温
 *      极不可能被记住, 风险低.
 *   3. 单候选回放: 历史只回放开仓的那个桶, AI 看不到当时其他候选; 实际 scan
 *      时 AI 看多候选, 判断可能不同.
 *   4. 限流 fail-open: API 限流时 verdict=null 默认 proceed, 会让门控偏弱
 *      (报告会显示 null 比例).
 *
 * Run (CI ubuntu):  npx tsx scripts/backtest-llm-gate.ts
 * 需: GEMINI_API_KEY (必) + DEEPSEEK_API_KEY + WEATHERBOT_LLM_PROVIDER2=deepseek (双AI)
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import {
  askTradeAdvisor,
  resetLlmCallBudget,
  type MarketTradeContext,
  type TradeCandidateContext,
} from "../src/llm.js";
import { inBucket, marketCalibrated } from "../src/math.js";

interface Pos {
  market_id: string;
  question: string;
  bucket_low: number;
  bucket_high: number;
  entry_price: number;
  bid_at_entry: number;
  spread: number;
  p: number;
  ev: number;
  forecast_temp: number | null;
  forecast_src: string | null;
  sigma: number | null;
  opened_at: string;
  status: string;
  pnl: number | null;
  close_reason: string | null;
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
interface Outcome {
  range: [number, number];
  volume?: number;
}
interface Mkt {
  city: string;
  city_name: string;
  date: string;
  unit: "F" | "C";
  actual_temp: number | null;
  status: string;
  positions?: Pos[];
  position?: Pos | null;
  forecast_snapshots?: Snap[];
  all_outcomes?: Outcome[];
}

const DIR = path.join(process.cwd(), "data", "markets");
const markets: Mkt[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => {
    try {
      return JSON.parse(readFileSync(path.join(DIR, f), "utf-8")) as Mkt;
    } catch {
      return null;
    }
  })
  .filter((m): m is Mkt => m != null);

interface Row {
  city_name: string;
  date: string;
  unit: string;
  bucket: string;
  entry: number;
  p: number;
  ev: number;
  hit: boolean;
  pnl: number;
  close_reason: string | null;
  action: "proceed" | "skip" | "null";
  risk: string;
  reason: string;
  primary_action?: string;
  primary_reason?: string;
  secondary_action?: string;
  secondary_reason?: string;
}

const rows: Row[] = [];
let skippedNoData = 0;
let nullCount = 0;

for (const m of markets) {
  if (m.status !== "resolved" || m.actual_temp == null) continue;
  const positions = m.positions ?? (m.position ? [m.position] : []);
  for (const pos of positions) {
    if (pos.pnl == null) continue;
    const snaps = (m.forecast_snapshots ?? []).filter((s) => s.ts);
    const opened = pos.opened_at ? new Date(pos.opened_at).getTime() : Date.now();
    // 开仓时点 snap: ts <= opened 中最近的 (无则用最后一个)
    const before = snaps
      .filter((s) => new Date(s.ts!).getTime() <= opened)
      .sort((a, b) => new Date(b.ts!).getTime() - new Date(a.ts!).getTime());
    const snap = before[0] ?? snaps[snaps.length - 1];
    const forecast = pos.forecast_temp ?? snap?.best ?? null;
    if (forecast == null) {
      skippedNoData++;
      continue;
    }
    const sigma = pos.sigma ?? (m.unit === "C" ? 2.3 : 1.7);
    const metar = snap?.metar ?? null;
    const gap =
      snap?.ecmwf != null && snap?.hrrr != null
        ? Math.round(Math.abs(snap.ecmwf - snap.hrrr) * 100) / 100
        : null;
    const vol =
      (m.all_outcomes ?? []).find(
        (o) => o.range[0] === pos.bucket_low && o.range[1] === pos.bucket_high,
      )?.volume ?? 0;
    const ask = pos.entry_price;
    const edge = Math.round((pos.p - marketCalibrated(ask)) * 10000) / 10000;
    const cand: TradeCandidateContext = {
      bucket: `${pos.bucket_low}-${pos.bucket_high}${m.unit}`,
      ask,
      bid: pos.bid_at_entry,
      our_prob: pos.p,
      edge,
      ev: pos.ev,
      volume: vol,
      spread: pos.spread,
      hours_left: snap?.hours_left ?? 0,
    };
    const ctx: MarketTradeContext = {
      city_name: m.city_name,
      date: m.date,
      unit: m.unit,
      forecast,
      forecast_source: pos.forecast_src ?? snap?.best_source ?? "ensemble",
      ensemble_gap: gap,
      ensemble_spread: null,
      sigma,
      metar,
      strategy: "regular",
      open_positions: 0,
      candidates: [cand],
    };

    resetLlmCallBudget();
    let action: Row["action"] = "null";
    let risk = "low";
    let reason = "(advisor unavailable)";
    let priAct: string | undefined;
    let priReason: string | undefined;
    let secAct: string | undefined;
    let secReason: string | undefined;
    try {
      const res = await askTradeAdvisor(ctx);
      if (res) {
        const v = res.verdicts[0];
        if (v) {
          action = v.action;
          risk = v.risk;
          reason = v.reason;
        }
        // merged 已含 secondary; 拆 primary/secondary 仅在 secondary 存在时可推断
        const sv = res.secondary?.verdicts[0];
        if (sv) {
          secAct = sv.action;
          secReason = sv.reason;
          // merged=proceed => primary 必 proceed; merged=skip => primary 未知, 标记
          priAct = action === "proceed" ? "proceed" : "(skip-source)";
          priReason = priAct;
        } else {
          priAct = action;
          priReason = reason;
        }
      } else {
        nullCount++;
      }
    } catch (e) {
      reason = "ERROR: " + String(e).slice(0, 80);
      nullCount++;
    }
    const hit = pos.resolved_hit ?? inBucket(m.actual_temp, pos.bucket_low, pos.bucket_high);
    rows.push({
      city_name: m.city_name,
      date: m.date,
      unit: m.unit,
      bucket: cand.bucket,
      entry: ask,
      p: pos.p,
      ev: pos.ev,
      hit,
      pnl: pos.pnl ?? 0,
      close_reason: pos.close_reason,
      action,
      risk,
      reason,
      primary_action: priAct,
      primary_reason: priReason,
      secondary_action: secAct,
      secondary_reason: secReason,
    });
    console.log(
      `[${rows.length}] ${m.city_name} ${m.date} ${cand.bucket} entry=$${ask.toFixed(3)} → ${action}(${risk}) hit=${hit ? "✓" : "✗"} pnl=$${pos.pnl} | ${reason.slice(0, 70)}`,
    );
  }
}

// ---------- 统计 ----------
const n = rows.length;
const dual = rows.some((r) => r.secondary_action != null);
const totalPnl = rows.reduce((a, r) => a + r.pnl, 0);
const totalHits = rows.filter((r) => r.hit).length;

// 门控: proceed 才买; skip/null 的处理 — null(fail-open)按 proceed 计 (实盘 fail-open)
const gated = rows.filter((r) => r.action !== "skip"); // proceed + null 都买
const skipped = rows.filter((r) => r.action === "skip");
const gatedPnl = gated.reduce((a, r) => a + r.pnl, 0);
const gatedHits = gated.filter((r) => r.hit).length;
const skipPnl = skipped.reduce((a, r) => a + r.pnl, 0);
const skipHits = skipped.filter((r) => r.hit).length;

// 严格门控 (null 也算 skip, 保守上界)
const strictGated = rows.filter((r) => r.action === "proceed");
const strictPnl = strictGated.reduce((a, r) => a + r.pnl, 0);
const strictHits = strictGated.filter((r) => r.hit).length;

const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) : "0.0");

const report = `# LLM 门控回测报告

生成时间: ${new Date().toISOString()}
模式: ${dual ? "双AI (Gemini primary + DeepSeek secondary, 任一skip即否决)" : "单Gemini"}
样本: ${n} 个已结算 position (跳过 ${skippedNoData} 个缺数据, advisor null ${nullCount} 个)

## 核心对比: 无门控 vs AI门控

| 指标 | 无门控(全买) | AI门控(proceed才买, null放行) | 严格门控(连null也砍) |
|------|-------------|------------------------------|---------------------|
| 交易数 | ${n} | ${gated.length} | ${strictGated.length} |
| 命中数 | ${totalHits} | ${gatedHits} | ${strictHits} |
| 胜率 | ${pct(totalHits, n)}% | ${pct(gatedHits, gated.length)}% | ${pct(strictHits, strictGated.length)}% |
| 总 PnL | $${totalPnl.toFixed(1)} | $${gatedPnl.toFixed(1)} | $${strictPnl.toFixed(1)} |
| 均 PnL/笔 | $${(n ? totalPnl / n : 0).toFixed(2)} | $${(gated.length ? gatedPnl / gated.length : 0).toFixed(2)} | $${(strictGated.length ? strictPnl / strictGated.length : 0).toFixed(2)} |

门控收益: AI门控 PnL $${gatedPnl.toFixed(1)} vs 无门控 $${totalPnl.toFixed(1)} = ${gatedPnl - totalPnl >= 0 ? "+" : ""}$${(gatedPnl - totalPnl).toFixed(1)}

## AI 砍掉的 ${skipped.length} 笔实际表现 (判断误杀)

| 指标 | skip组 (AI砍掉) | proceed组 (AI放行) |
|------|----------------|-------------------|
| 交易数 | ${skipped.length} | ${gated.length} |
| 命中数 | ${skipHits} | ${gatedHits} |
| 胜率 | ${pct(skipHits, skipped.length)}% | ${pct(gatedHits, gated.length)}% |
| 总 PnL | $${skipPnl.toFixed(1)} | $${gatedPnl.toFixed(1)} |
| 均 PnL | $${(skipped.length ? skipPnl / skipped.length : 0).toFixed(2)} | $${(gated.length ? gatedPnl / gated.length : 0).toFixed(2)} |

**解读**: skip组均PnL = $${(skipped.length ? skipPnl / skipped.length : 0).toFixed(2)}
- 若为负 → AI 砍掉了亏损交易, 门控有价值
- 若为正 → AI 误杀了盈利交易, 门控有害
- 砍掉 ${skipped.length}/${n} 笔 (${pct(skipped.length, n)}%), 其中命中 ${skipHits} 笔 (误杀的赢家)

${dual ? `## 双AI拆分\n\n- DeepSeek secondary 单独 skip: ${rows.filter((r) => r.secondary_action === "skip").length} 笔\n- 合并 skip (任一skip): ${skipped.length} 笔\n- 门控规则 (llm.ts:305): 任一模型 skip 即否决\n` : ""}
## 局限 (解读时务必考虑)

1. LLM 非确定, 本报告是一次性快照, 重跑可能略变
2. 未来信息偏差: LLM 训练数据或含个别事件结果 (具体日期最高温被记住概率极低)
3. 单候选回放: 只回放开仓桶, AI 看不到当时其他候选
4. ${nullCount} 个 advisor null (限流/错误) 按放行计, 可能让门控偏弱

## 逐笔 verdict

| city | date | bucket | entry | p | ev | action | risk | hit | pnl | close | reason |
|------|------|--------|-------|---|----|--------|------|-----|-----|-------|--------|
${rows
  .map(
    (r) =>
      `| ${r.city_name} | ${r.date} | ${r.bucket} | ${r.entry.toFixed(3)} | ${(r.p * 100).toFixed(1)}% | ${r.ev.toFixed(2)} | ${r.action} | ${r.risk} | ${r.hit ? "✓" : "✗"} | $${r.pnl.toFixed(1)} | ${r.close_reason ?? ""} | ${r.reason.replace(/\|/g, "/").slice(0, 70)} |`,
  )
  .join("\n")}
`;

console.log("\n" + report);
const outDir = path.join(process.cwd(), "data", "processed");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `llm_gate_backtest_${new Date().toISOString().slice(0, 10)}.md`);
writeFileSync(outFile, report, "utf-8");
console.log(`\n报告已写入: ${outFile}`);
