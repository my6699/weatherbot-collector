import { writeFileSync } from "fs";
import path from "path";
import {
  DATA_DIR,
  LLM_ENABLED,
  LLM_MAX_CALLS_PER_SCAN,
  LLM_MODEL,
  LLM_MODEL2,
  LLM_PROVIDER,
  LLM_PROVIDER2,
  LLM_TIMEOUT_MS,
  LOCATIONS,
} from "./config.js";
import { postJson } from "./http.js";
import { loadBiasTable } from "./bias.js";
import { loadAllMarkets, loadState, openPositions } from "./storage.js";

/* ------------------------------------------------------------------ */
/* Provider selection (all free tiers, OpenAI-compatible)              */
/* ------------------------------------------------------------------ */

interface ProviderCfg {
  provider: string;
  base: string;
  key: string;
  model: string;
}

function providerCfg(providerName: string, modelOverride: string): ProviderCfg | null {
  if (!LLM_ENABLED) return null;
  const provider = providerName.toLowerCase();
  const model = modelOverride.trim();
  const keyOf = (env: string): string => process.env[env]?.trim() ?? "";
  switch (provider) {
    case "gemini":
      if (!process.env.GEMINI_API_KEY) return null;
      return {
        provider,
        base: "https://generativelanguage.googleapis.com/v1beta/openai",
        key: keyOf("GEMINI_API_KEY"),
        model: model || "gemini-flash-latest",
      };
    case "groq":
      if (!process.env.GROQ_API_KEY) return null;
      return {
        provider,
        base: "https://api.groq.com/openai/v1",
        key: keyOf("GROQ_API_KEY"),
        model: model || "llama-3.3-70b-versatile",
      };
    case "deepseek":
      if (!process.env.DEEPSEEK_API_KEY) return null;
      return {
        provider,
        base: "https://api.deepseek.com/v1",
        key: keyOf("DEEPSEEK_API_KEY"),
        model: model || "deepseek-chat",
      };
    case "openrouter":
      if (!process.env.OPENROUTER_API_KEY) return null;
      return {
        provider,
        base: "https://openrouter.ai/api/v1",
        key: keyOf("OPENROUTER_API_KEY"),
        model: model || "meta-llama/llama-3.3-70b-instruct:free",
      };
    case "custom":
      if (!process.env.WEATHERBOT_LLM_CUSTOM_BASE) return null;
      return {
        provider,
        base: process.env.WEATHERBOT_LLM_CUSTOM_BASE.replace(/\/+$/, ""),
        key: keyOf("WEATHERBOT_LLM_CUSTOM_KEY"),
        model: model || "gpt-4o-mini",
      };
    default:
      return null;
  }
}

/** Primary provider (LLM_PROVIDER / LLM_MODEL). */
function primaryCfg(): ProviderCfg | null {
  return providerCfg(LLM_PROVIDER, LLM_MODEL);
}

/** Optional 2nd-opinion provider (LLM_PROVIDER2 / LLM_MODEL2), null when off. */
function secondaryCfg(): ProviderCfg | null {
  return LLM_PROVIDER2.trim() !== "" ? providerCfg(LLM_PROVIDER2, LLM_MODEL2) : null;
}

export function llmAvailable(): boolean {
  return primaryCfg() != null;
}

let warned = false;
function warnUnavailable(): void {
  if (warned) return;
  warned = true;
  console.log(
    `  [LLM] disabled — no key for provider "${LLM_PROVIDER}" (get a free GEMINI_API_KEY at aistudio.google.com)`,
  );
}

/* ------------------------------------------------------------------ */
/* Chat helper                                                         */
/* ------------------------------------------------------------------ */

interface ChatMessage {
  role: string;
  content: string;
}

export async function llmChat(
  system: string,
  user: string,
  temperature = 0.2,
  cfgOverride?: ProviderCfg,
): Promise<string | null> {
  const cfg = cfgOverride ?? primaryCfg();
  if (!cfg) {
    warnUnavailable();
    return null;
  }
  try {
    const res = await postJson<{ choices?: { message?: { content?: string } }[] }>(
      `${cfg.base}/chat/completions`,
      {
        model: cfg.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ] as ChatMessage[],
        temperature,
        max_tokens: 1500,
      },
      { Authorization: `Bearer ${cfg.key}` },
      LLM_TIMEOUT_MS,
    );
    const content = res?.choices?.[0]?.message?.content;
    return content != null && content.trim() !== "" ? content.trim() : null;
  } catch (e) {
    console.warn(`  [LLM] ${cfg.provider} call failed: ${String(e)}`);
    return null;
  }
}

/** Strip ```json fences and parse an LLM reply as JSON; null on failure. */
function parseJsonReply(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (m?.[1]) {
      try {
        return JSON.parse(m[1]) as unknown;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Per-scan call budget (protect free-tier rate limits)                */
/* ------------------------------------------------------------------ */

/** Budget is tracked per provider so the 2nd opinion never starves the primary. */
const callBudget: Record<string, number> = {};

export function resetLlmCallBudget(): void {
  for (const k of Object.keys(callBudget)) delete callBudget[k];
}

function llmCallAllowed(provider: string): boolean {
  const used = callBudget[provider] ?? 0;
  if (used >= LLM_MAX_CALLS_PER_SCAN) return false;
  callBudget[provider] = used + 1;
  return true;
}

/* ------------------------------------------------------------------ */
/* Buy-time risk advisor                                               */
/* ------------------------------------------------------------------ */

export interface TradeCandidateContext {
  bucket: string;
  ask: number;
  bid: number;
  our_prob: number;
  edge: number;
  ev: number;
  volume: number;
  spread: number;
  hours_left: number;
}

export interface MarketTradeContext {
  city_name: string;
  date: string;
  unit: string;
  forecast: number | null;
  forecast_source: string;
  ensemble_gap: number | null;
  ensemble_spread: number | null;
  sigma: number;
  metar: number | null;
  strategy: "regular" | "endgame";
  open_positions: number;
  candidates: TradeCandidateContext[];
}

export interface TradeVerdict {
  action: "proceed" | "skip";
  risk: "low" | "medium" | "high";
  reason: string;
}

const TRADE_SYSTEM = `你是 Polymarket 天气市场的量化交易风控顾问。你的唯一任务：根据给定的市场与预报上下文，逐条审查每个候选买入是否存在数据异常、结算规则风险、流动性陷阱或明显负期望的迹象。
规则：
1. 只输出 JSON 数组，数组元素与候选一一对应：{"action":"proceed"|"skip","risk":"low"|"medium"|"high","reason":"一句话中文原因"}。
2. 没有发现明确问题时输出 proceed / low。
3. 仅在发现明确异常时 skip：例如预报与市场极端背离、成交量极低、买价/卖价差异常、终局观测与桶不匹配、同一市场多个桶同时出现异常价、问题文本与城市/站点不符。
4. 不要因为正常波动或保守情绪而 skip。不要输出 JSON 以外的任何文字。`;

export interface TradeAdvisorResult {
  verdicts: TradeVerdict[];
  /** 2nd-opinion model's raw verdicts (when configured AND available). */
  secondary?: { provider: string; verdicts: TradeVerdict[] } | null;
}

function buildTradePrompt(ctx: MarketTradeContext): string {
  const rows = ctx.candidates
    .map(
      (c, i) =>
        `${i}. ${c.bucket} | ask ${c.ask.toFixed(3)} bid ${c.bid.toFixed(3)} | ourP ${(c.our_prob * 100).toFixed(1)}% | edge ${c.edge.toFixed(3)} | ev ${c.ev.toFixed(3)} | vol ${c.volume} | spread ${c.spread.toFixed(3)} | hoursLeft ${c.hours_left.toFixed(1)}`,
    )
    .join("\n");

  return `市场：${ctx.city_name} ${ctx.date}（单位 ${ctx.unit}）
策略：${ctx.strategy}
预报：${ctx.forecast ?? "n/a"}${ctx.unit}（来源 ${ctx.forecast_source}）
模型分歧 gap：${ctx.ensemble_gap ?? "n/a"}${ctx.unit}｜模型离散 spread：${ctx.ensemble_spread ?? "n/a"}${ctx.unit}｜sigma：${ctx.sigma}
实时观测 METAR：${ctx.metar ?? "n/a"}${ctx.unit}
已持仓桶数：${ctx.open_positions}
候选（索引与输出数组一一对应）：
${rows}
请逐条审查，输出 JSON 数组。`;
}

/** Ask ONE model for per-candidate verdicts. Null on unavailable / budget /
 *  parse failure (fail-open, caller decides what null means). */
async function askOneModel(
  cfg: ProviderCfg,
  ctx: MarketTradeContext,
): Promise<TradeVerdict[] | null> {
  if (!llmCallAllowed(cfg.provider)) return null;
  const raw = await llmChat(TRADE_SYSTEM, buildTradePrompt(ctx), 0.1, cfg);
  if (!raw) return null;
  const parsed = parseJsonReply(raw);
  if (!Array.isArray(parsed)) {
    console.warn(`  [LLM] ${cfg.provider} advisor reply is not a JSON array: ${raw.slice(0, 120)}`);
    return null;
  }
  // Fail-open: missing/malformed entries default to proceed.
  return ctx.candidates.map((_, i) => {
    const row = parsed[i];
    if (!row || typeof row !== "object") {
      return { action: "proceed" as const, risk: "low" as const, reason: "解析缺失，默认放行" };
    }
    const r = row as Record<string, unknown>;
    return {
      action: r.action === "skip" ? ("skip" as const) : ("proceed" as const),
      risk: r.risk === "high" || r.risk === "medium" ? (r.risk as "high" | "medium") : ("low" as const),
      reason: typeof r.reason === "string" ? (r.reason as string) : "",
    };
  });
}

const RISK_RANK: Record<TradeVerdict["risk"], number> = { low: 0, medium: 1, high: 2 };

export async function askTradeAdvisor(
  ctx: MarketTradeContext,
): Promise<TradeAdvisorResult | null> {
  const priCfg = primaryCfg();
  if (!priCfg) {
    warnUnavailable();
    return null;
  }

  const priVerdicts = await askOneModel(priCfg, ctx);
  if (!priVerdicts) return null;

  // 2nd opinion (independent model, e.g. Groq Llama). Optional: if unset or
  // failed, the primary verdict alone decides (behavior unchanged).
  let secondary: TradeAdvisorResult["secondary"] = null;
  const secCfg = secondaryCfg();
  if (secCfg) {
    const secVerdicts = await askOneModel(secCfg, ctx);
    if (secVerdicts) {
      secondary = { provider: secCfg.provider, verdicts: secVerdicts };
      console.log(`  [LLM 2ND] ${secCfg.provider} reviewed ${ctx.city_name} ${ctx.date} (${ctx.strategy})`);
    }
  }

  // Merge: buy only when BOTH models agree. Any skip vetoes; risk takes the
  // higher of the two; reasons are joined so the log shows both viewpoints.
  const fallback: TradeVerdict = { action: "proceed", risk: "low", reason: "解析缺失，默认放行" };
  const verdicts: TradeVerdict[] = ctx.candidates.map((_, i) => {
    const p = priVerdicts[i] ?? fallback;
    if (!secondary) return p;
    const s = secondary.verdicts[i] ?? p;
    const action = p.action === "skip" || s.action === "skip" ? ("skip" as const) : ("proceed" as const);
    const risk = RISK_RANK[p.risk] >= RISK_RANK[s.risk] ? p.risk : s.risk;
    const reason = `${priCfg.provider}: ${p.reason}${s.reason ? ` | ${secondary.provider}: ${s.reason}` : ""}`;
    return { action, risk, reason };
  });
  return { verdicts, secondary };
}

/* ------------------------------------------------------------------ */
/* Weekly performance review                                           */
/* ------------------------------------------------------------------ */

export async function runLlmReview(): Promise<string | null> {
  if (!llmAvailable()) {
    warnUnavailable();
    return null;
  }
  const state = loadState();
  const markets = loadAllMarkets();
  const resolved = markets.filter((m) => m.status === "resolved" && m.pnl != null);
  const open = markets.filter((m) => openPositions(m).length > 0);

  const byCity = new Map<string, { n: number; w: number; pnl: number }>();
  for (const m of resolved) {
    const e = byCity.get(m.city) ?? { n: 0, w: 0, pnl: 0 };
    e.n += 1;
    e.pnl += m.pnl ?? 0;
    if (m.resolved_outcome === "win") e.w += 1;
    byCity.set(m.city, e);
  }
  const cityLines = [...byCity.entries()]
    .sort((a, b) => a[1].pnl - b[1].pnl)
    .map(([c, e]) => {
      const name = LOCATIONS[c]?.name ?? c;
      const wr = e.n ? ((e.w / e.n) * 100).toFixed(0) : "0";
      return `${name}: ${e.w}/${e.n}胜(${wr}%) PnL ${e.pnl >= 0 ? "+" : ""}${e.pnl.toFixed(2)}`;
    })
    .join("\n");

  const openLines =
    open
      .flatMap((m) =>
        openPositions(m).map(
          (p) =>
            `${m.city_name} ${m.date} ${p.bucket_low}-${p.bucket_high} entry $${p.entry_price.toFixed(3)} src ${p.forecast_src ?? p.strategy ?? ""}`,
        ),
      )
      .join("\n") || "无";

  const resolvedLines =
    resolved
      .slice(-40)
      .map(
        (m) =>
          `${m.city_name} ${m.date} bucket ${m.position?.bucket_low ?? "?"}-${m.position?.bucket_high ?? "?"} pnl ${m.pnl ?? 0}`,
      )
      .join("\n") || "无";

  // Horizon-aware rolling bias table (city × horizon × source).
  const biasLines = Object.entries(loadBiasTable())
    .sort((a, b) => Math.abs(b[1].bias) - Math.abs(a[1].bias))
    .slice(0, 12)
    .map(([k, e]) => {
      const [city = "", horizon = "", src = ""] = k.split("|");
      const name = LOCATIONS[city]?.name ?? city;
      const unit = LOCATIONS[city]?.unit ?? "C";
      return `${name} ${horizon} ${src}: ${e.bias >= 0 ? "+" : ""}${e.bias.toFixed(2)}°${unit} (n=${e.n})`;
    })
    .join("\n") || "无";

  const total = state.wins + state.losses;
  const system =
    "你是量化交易复盘顾问。基于实际交易记录，诊断问题并给出可执行改进建议。必须用简体中文。输出 markdown。";
  const user = `余额 ${state.balance}（起始 ${state.starting_balance}，峰值 ${state.peak_balance}）
已结算 ${total} 笔（胜 ${state.wins}，负 ${state.losses}，胜率 ${total ? ((state.wins / total) * 100).toFixed(0) : 0}%）
分城市统计（按 PnL 升序）：
${cityLines || "无"}
未平仓持仓：
${openLines}
最近已结算明细（最多 40 条）：
${resolvedLines}

滚动偏差表（预报-实际，正值=预报偏低需上调，单位见条目；已应用在开仓前的预报修正）：
${biasLines}

请输出：
1. 主要问题诊断（分城市 / 分策略，引用具体数字）
2. 具体改进建议：哪些城市应剔除或减仓、sigma / edge / 终局参数怎么调、要盯哪些风险点
3. 偏差表评估：哪些修正可信（趋势性，n≥4）哪些是噪音（n小）；是否需要针对特定城市×时距额外过滤（如 D+1 预报偏低）
4. 下阶段行动清单（按优先级）
控制在 350 字以内。`;

  const raw = await llmChat(system, user, 0.3);
  if (!raw) return null;

  const stamp = new Date().toISOString().slice(0, 10);
  const file = path.join(DATA_DIR, `llm_review_${stamp}.md`);
  const content = [
    `# LLM 周度复盘 — ${stamp}`,
    ``,
    `- 余额: ${state.balance} / 起始 ${state.starting_balance}`,
    `- 已结算: ${total}（胜 ${state.wins} / 负 ${state.losses}）`,
    ``,
    raw,
    ``,
  ].join("\n");
  writeFileSync(file, content, "utf-8");
  return file;
}

/* ------------------------------------------------------------------ */
/* Beginner plain-language narration for investment-advice reports     */
/* ------------------------------------------------------------------ */

export interface AdviceNarrationInfo {
  city: string;
  date: string;
  bucket: string;
  forecast: number | null;
  unit: string;
  our_prob: number;
  ask: number;
  edge: number;
  cost: number;
  strategy: string;
}

const ADVICE_SYSTEM =
  "你是面向投资新手的理财科普解说员。用大白话解释，避免任何专业术语，语气平和客观。必须提醒风险，绝不承诺收益。";

export async function askAdviceNarration(
  info: AdviceNarrationInfo,
): Promise<string | null> {
  const priCfg = primaryCfg();
  if (!priCfg) {
    warnUnavailable();
    return null;
  }
  if (!llmCallAllowed(priCfg.provider)) return null;

  const user = `市场上有一个预测：「${info.city} ${info.date} 的最高气温」。
我们下注：最高温落在 ${info.bucket}。气象模型预报 ${info.forecast ?? "未知"}${info.unit}。
我们算出这个结果的概率约 ${(info.our_prob * 100).toFixed(0)}%，而市场上买它要花 $${info.ask.toFixed(3)}（我们的判断比市场高 ${(info.edge * 100).toFixed(1)}%）。
本次投入 $${info.cost.toFixed(2)}，策略：${info.strategy}。

请用 2-3 句话、完全大白话给完全不懂金融的人解释：1) 这是什么机会；2) 为什么买；3) 最大的风险是什么；4) 什么时候见分晓。100 字以内。`;

  return await llmChat(ADVICE_SYSTEM, user, 0.3, priCfg);
}
