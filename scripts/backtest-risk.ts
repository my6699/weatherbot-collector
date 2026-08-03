/* Backtest the NEW risk rules (dynamic sigma stop-loss + per-city daily
 * $40 cost cap) against existing closed positions in data/markets/.
 * Read-only: never writes to data/. Run: node ...tsx dist/cli.mjs scripts/backtest-risk.ts */
import { readdirSync, readFileSync } from "fs";
import path from "path";

const DIR = path.join(process.cwd(), "data", "markets");
const BASE_SIGMA_C = 2.3;
const BASE_SIGMA_F = 1.7;
const STOP_MULT = 0.8; // tight
const STOP_MULT_WIDE = 0.5; // wide
const MAX_CITY_COST = 40;

interface Pos {
  market_id?: string;
  bucket_low: number;
  bucket_high: number;
  entry_price: number;
  bid_at_entry: number;
  cost: number;
  shares: number;
  sigma?: number;
  status: string;
  pnl: number | null;
  close_reason: string | null;
  stop_price?: number;
  exit_price: number | null;
  opened_at?: string;
  closed_at?: string;
  forecast_temp?: number | null;
}
interface Mkt {
  city: string;
  city_name: string;
  date: string;
  unit: "F" | "C";
  status: string;
  actual_temp: number | null;
  positions: Pos[];
}

function loadMarkets(): Mkt[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(path.join(DIR, f), "utf-8")) as Mkt;
      } catch {
        return null;
      }
    })
    .filter((m): m is Mkt => m != null);
}

function inBucket(temp: number, low: number, high: number): boolean {
  if (low === high) return Math.round(temp) === Math.round(low);
  return low <= temp && temp <= high;
}

function newStopFor(p: Pos, unit: "F" | "C"): { stop: number; wide: boolean } {
  const base = unit === "C" ? BASE_SIGMA_C : BASE_SIGMA_F;
  const wide = (p.sigma ?? 0) > base;
  const mult = wide ? STOP_MULT_WIDE : STOP_MULT;
  return { stop: Math.min(p.entry_price, p.bid_at_entry) * mult, wide };
}

const markets = loadMarkets();
const allPos = markets.flatMap((m) =>
  (m.positions ?? []).map((p) => ({ ...p, _city: m.city_name, _date: m.date, _unit: m.unit })),
);
const closed = allPos.filter((p) => p.status === "closed");
const open = allPos.filter((p) => p.status === "open");

console.log("===== 数据概览 =====");
console.log(`市场文件: ${markets.length}（resolved: ${markets.filter((m) => m.status === "resolved").length}）`);
console.log(`仓: ${allPos.length}（closed: ${closed.length}, open: ${open.length}）`);
const byReason = new Map<string, { n: number; pnl: number }>();
for (const p of closed) {
  const r = p.close_reason ?? "unknown";
  const e = byReason.get(r) ?? { n: 0, pnl: 0 };
  e.n += 1;
  e.pnl += p.pnl ?? 0;
  byReason.set(r, e);
}
console.log("按平仓原因:");
for (const [r, e] of [...byReason.entries()].sort((a, b) => a[1].pnl - b[1].pnl)) {
  console.log(`  ${r.padEnd(20)} ${e.n} 笔 | PnL ${e.pnl.toFixed(2)}`);
}

/* ------------------------------------------------------------------ */
/* A. 动态止损回测：旧止损 vs 新止损                                  */
/* ------------------------------------------------------------------ */
console.log("\n===== A. 动态 Sigma 止损 =====");
const sl = closed.filter((p) => p.close_reason === "stop_loss");
let wider = 0;
let wouldNotStop = 0;
let tighter = 0;
let wouldStop = 0;
for (const p of sl) {
  const old = p.stop_price ?? Math.min(p.entry_price, p.bid_at_entry) * STOP_MULT;
  const { stop: neu, wide } = newStopFor(p, p._unit);
  if (neu < old - 1e-9) wider += 1;
  else tighter += 1;
  const exit = p.exit_price ?? 0;
  if (neu < old - 1e-9 && exit >= neu) wouldNotStop += 1;
  else wouldStop += 1;
  if (wide) console.log(`  [WIDE] ${p._city} ${p._date} b${p.bucket_low}-${p.bucket_high} sig ${p.sigma?.toFixed(1)} entry ${p.entry_price} bid ${p.bid_at_entry} old ${old.toFixed(3)} -> new ${neu.toFixed(3)} exit ${exit.toFixed(3)} pnl ${p.pnl}`);
}
console.log(`止损仓 ${sl.length} 笔:`);
console.log(`  新止损更宽: ${wider} 笔 | 更紧: ${tighter} 笔`);
console.log(`  新逻辑下"不会在旧价位触发"(exit >= 新止损): ${wouldNotStop} 笔`);
console.log(`  新逻辑下仍会触发: ${wouldStop} 笔`);

/* ------------------------------------------------------------------ */
/* C. 已结算市场：stop_loss 仓若持有至结算                             */
/* ------------------------------------------------------------------ */
console.log("\n===== C. stop_loss 仓若持有至结算（仅已结算市场） =====");
let cWin = 0;
let cLoss = 0;
let cWrongStop = 0; // 错杀盈利单的笔数
let cRightStop = 0; // 正确止损的笔数
let cHoldDelta = 0; // 持有至结算 相对 止损出场 的盈亏差（负 = 止损反而更好）
for (const m of markets) {
  if (m.status !== "resolved" || m.actual_temp == null) continue;
  for (const p of m.positions ?? []) {
    if (p.close_reason !== "stop_loss" || p.status !== "closed") continue;
    const won = inBucket(m.actual_temp, p.bucket_low, p.bucket_high);
    // 持有至结算的盈亏（赢 = 每股按 $1 结算；输 = 全损）
    const holdPnl = won ? (1 - p.entry_price) * p.shares : -p.cost;
    const actual = p.pnl ?? 0;
    if (won) {
      cWin += 1;
      cWrongStop += 1;
    } else {
      cLoss += 1;
      cRightStop += 1;
    }
    cHoldDelta += holdPnl - actual;
  }
}
console.log(`已结算市场中的止损仓: 赢 ${cWin} 笔 / 输 ${cLoss} 笔`);
console.log(`  错杀率: ${(cWin / Math.max(1, cWin + cLoss) * 100).toFixed(0)}%`);
console.log(`  持有至结算相对止损出场的盈亏差: $${cHoldDelta.toFixed(2)}（负 = 止损优于死扛, 正 = 死扛更好）`);

// 新动态止损对已结算止损仓的净影响：
// 新止损更宽且 exit >= 新止损 → 旧价位不触发 → 实际会持有至结算
let newRuleTotal = 0;
let newRuleHold = 0;
let newRuleCount = 0;
for (const m of markets) {
  if (m.status !== "resolved" || m.actual_temp == null) continue;
  for (const p of m.positions ?? []) {
    if (p.close_reason !== "stop_loss" || p.status !== "closed") continue;
    const won = inBucket(m.actual_temp, p.bucket_low, p.bucket_high);
    const { stop: neu } = newStopFor(p, m.unit);
    const old = p.stop_price ?? Math.min(p.entry_price, p.bid_at_entry) * STOP_MULT;
    const exit = p.exit_price ?? 0;
    if (neu < old - 1e-9 && exit >= neu) {
      // 新逻辑不触发 → 持有至结算
      newRuleTotal += won ? (1 - p.entry_price) * p.shares : -p.cost;
      newRuleHold += 1;
    } else {
      newRuleTotal += p.pnl ?? 0;
    }
    newRuleCount += 1;
  }
}
const actualTotal = markets
  .filter((m) => m.status === "resolved" && m.actual_temp != null)
  .flatMap((m) => m.positions ?? [])
  .filter((p) => p.close_reason === "stop_loss" && p.status === "closed")
  .reduce((s, p) => s + (p.pnl ?? 0), 0);
console.log(`\n新动态止损在已结算止损仓(${newRuleCount} 笔)上的净影响:`);
console.log(`  其中 ${newRuleHold} 笔会被"放行至结算", 合计盈亏 $${newRuleTotal.toFixed(2)} vs 旧规则 $${actualTotal.toFixed(2)}`);
console.log(`  差值 $${(newRuleTotal - actualTotal).toFixed(2)}（负 = 新规则更差, 正 = 新规则更好）`);

/* ------------------------------------------------------------------ */
/* B. 单城日 $40 上限时间线模拟                                       */
/* ------------------------------------------------------------------ */
console.log("\n===== B. 单城市日成本上限 $40（时间线模拟） =====");
interface SimPos extends Pos {
  _city: string;
  _date: string;
  _unit: "F" | "C";
}
type TE = { t: number; open: boolean; p: SimPos };
const events: TE[] = [];
for (const p of allPos as SimPos[]) {
  if (p.opened_at) events.push({ t: Date.parse(p.opened_at), open: true, p });
  if (p.closed_at) events.push({ t: Date.parse(p.closed_at), open: false, p });
}
// 同一时间戳 open 优先（先计敞口再释放）
events.sort((a, b) => a.t - b.t || (a.open === b.open ? 0 : a.open ? -1 : 1));

function simulateCap(cap: number): { rejected: SimPos[]; peaks: Map<string, number> } {
  const openCost = new Map<string, number>();
  const peaks = new Map<string, number>();
  const rejected: SimPos[] = [];
  for (const ev of events) {
    const key = `${ev.p._city}|${ev.p._date}`;
    if (ev.open) {
      const cur = openCost.get(key) ?? 0;
      if (cur + (ev.p.cost ?? 0) > cap) {
        rejected.push(ev.p);
      } else {
        openCost.set(key, cur + (ev.p.cost ?? 0));
      }
      peaks.set(key, Math.max(peaks.get(key) ?? 0, openCost.get(key) ?? 0));
    } else {
      openCost.set(key, (openCost.get(key) ?? 0) - (ev.p.cost ?? 0));
    }
  }
  return { rejected, peaks };
}

const { rejected, peaks } = simulateCap(MAX_CITY_COST);
const rejClosed = rejected.filter((p) => p.status === "closed");
const rejPnl = rejClosed.reduce((s, p) => s + (p.pnl ?? 0), 0);
// 被拒仓的"持有至结算"结果（仅已结算市场可判定）
let rejWin = 0;
let rejLoss = 0;
for (const p of rejClosed) {
  const m = markets.find(
    (mm) => mm.city_name === p._city && mm.date === p._date && mm.status === "resolved",
  );
  if (!m || m.actual_temp == null) continue;
  if (inBucket(m.actual_temp, p.bucket_low, p.bucket_high)) rejWin += 1;
  else rejLoss += 1;
}
console.log(`被 $40 上限拒掉的仓: ${rejected.length} 笔（其中已平仓 ${rejClosed.length} 笔）`);
console.log(`被拒仓的实际 PnL 合计: $${rejPnl.toFixed(2)}（负 = 避免的亏损, 正 = 误杀的盈利）`);
console.log(`被拒仓若持有至结算: 赢 ${rejWin} 笔 / 输 ${rejLoss} 笔（已结算市场判定）`);
const byCity = new Map<string, { n: number; pnl: number }>();
for (const p of rejClosed) {
  const e = byCity.get(p._city) ?? { n: 0, pnl: 0 };
  e.n += 1;
  e.pnl += p.pnl ?? 0;
  byCity.set(p._city, e);
}
for (const [c, e] of [...byCity.entries()].sort((a, b) => a[1].pnl - b[1].pnl)) {
  console.log(`  ${c.padEnd(14)} 拒 ${e.n} 笔 | PnL ${e.pnl.toFixed(2)}`);
}

/* 极端案例：单城单日实际敞口峰值 */
console.log("\n单城单日峰值敞口（实际历史）:");
for (const [k, v] of [...peaks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${k.padEnd(24)} 峰值 $${v.toFixed(2)}${v > MAX_CITY_COST ? "  (超上限)" : ""}`);
}

/* ------------------------------------------------------------------ */
/* D. 同桶重复投注审计（每桶只买一次的新规则）                         */
/* ------------------------------------------------------------------ */
console.log("\n===== D. 同桶重复投注审计（每桶只买一次） =====");
const byBucket = new Map<string, SimPos[]>();
for (const p of allPos as SimPos[]) {
  const key = `${p._city}|${p._date}|${p.bucket_low}-${p.bucket_high}`;
  const arr = byBucket.get(key) ?? [];
  arr.push(p);
  byBucket.set(key, arr);
}
const repeated = [...byBucket.values()].filter((arr) => arr.length > 1);
let repPnlFirst = 0;
let repPnlRest = 0;
let repFirstWin = 0;
let repRestWin = 0;
for (const arr of repeated) {
  // 按开仓时间排序：第一次 vs 之后重复买入
  const sorted = [...arr].sort((a, b) => Date.parse(a.opened_at ?? "") - Date.parse(b.opened_at ?? ""));
  const [first, ...rest] = sorted;
  repPnlFirst += first.pnl ?? 0;
  for (const r of rest) repPnlRest += r.pnl ?? 0;
  const m = markets.find(
    (mm) => mm.city_name === first._city && mm.date === first._date && mm.status === "resolved",
  );
  if (m && m.actual_temp != null) {
    if (inBucket(m.actual_temp, first.bucket_low, first.bucket_high)) repFirstWin += 1;
    for (const r of rest) {
      if (inBucket(m.actual_temp, r.bucket_low, r.bucket_high)) repRestWin += 1;
    }
  }
}
console.log(`同一 (城市,日期,桶) 被重复买入的桶: ${repeated.length} 个（涉及 ${allPos.length - 0} 笔中的 ${repeated.reduce((s, a) => s + a.length, 0)} 笔仓）`);
console.log(`  首笔合计 PnL: $${repPnlFirst.toFixed(2)} | 后续重复笔合计 PnL: $${repPnlRest.toFixed(2)}`);
console.log(`  首笔命中率: ${repFirstWin}/${Math.max(1, repeated.length)} | 重复笔命中率: ${repRestWin}/${Math.max(1, repeated.reduce((s, a) => s + a.length - 1, 0))}`);
console.log(`  新规则"每桶只买一次"可避免的重复亏损: $${repPnlRest.toFixed(2)}`);

/* ------------------------------------------------------------------ */
/* E. Maker 优先成交（挂单方）潜在改善估算                             */
/* ------------------------------------------------------------------ */
console.log("\n===== E. Maker 优先成交潜在改善估算 =====");
// 完整往返若全程 Maker：买入@best bid（省 1×spread）、卖出@best ask（省 1×spread）。
// 用每笔买入时记录的 spread 近似退出点差，估算 = spread × 2 × 成交率。
// 成交率：GTC post-only 挂单在 8 秒窗口内被吃掉的概率——100% 为理论上限，
// 50% 为保守估计（薄盘口挂单未必立即成交）。止损类卖出不走 Maker，已排除。
const closedSp = (allPos as SimPos[]).filter((p) => p.status === "closed" && p.pnl != null);
const totPnl = closedSp.reduce((s, p) => s + (p.pnl ?? 0), 0);
const spreadSavedMax = closedSp.reduce((s, p) => s + (p.spread ?? 0) * 2, 0);
console.log(`已平仓 ${closedSp.length} 笔（非止损含 Maker 路径），当前总 PnL: $${totPnl.toFixed(2)}`);
console.log(`  Maker 100% 成交（上限）: +$${spreadSavedMax.toFixed(2)} → 总 PnL $${(totPnl + spreadSavedMax).toFixed(2)}`);
console.log(`  Maker 50% 成交（保守） : +$${(spreadSavedMax * 0.5).toFixed(2)} → 总 PnL $${(totPnl + spreadSavedMax * 0.5).toFixed(2)}`);
console.log(`  （注：仅模拟交易记录，实盘成交价/点差更复杂，此为主要参考方向）`);

/* ------------------------------------------------------------------ */
/* F. 按时距分组：D+0 / D+1 / D+2 的开仓质量对比                       */
/* ------------------------------------------------------------------ */
console.log("\n===== F. 按开仓时距分组（D距 = 结算日 - 开仓日） =====");
function daysTo(date: string, openedAt?: string): number {
  if (!openedAt) return 99;
  const d0 = Date.parse(date + "T00:00:00Z");
  const d1 = Date.parse(openedAt.slice(0, 10) + "T00:00:00Z");
  return Math.round((d0 - d1) / 86400000);
}
const byHorizon = new Map<number, { n: number; pnl: number; win: number; resolved: number; resWin: number }>();
for (const p of allPos as SimPos[]) {
  const d = daysTo(p._date, p.opened_at);
  const e = byHorizon.get(d) ?? { n: 0, pnl: 0, win: 0, resolved: 0, resWin: 0 };
  e.n += 1;
  if (p.status === "closed" && p.pnl != null) {
    e.pnl += p.pnl;
    if (p.pnl > 0) e.win += 1;
  }
  const m = markets.find(
    (mm) => mm.city_name === p._city && mm.date === p._date && mm.status === "resolved" && mm.actual_temp != null,
  );
  if (m) {
    e.resolved += 1;
    if (inBucket(m.actual_temp, p.bucket_low, p.bucket_high)) e.resWin += 1;
  }
  byHorizon.set(d, e);
}
console.log("  D距 | 开仓数 | 平仓PnL | 盈利单率 | 已结算桶命中率");
for (const [d, e] of [...byHorizon.entries()].sort((a, b) => a[0] - b[0])) {
  const winRate = e.n > 0 ? ((e.win / e.n) * 100).toFixed(0) + "%" : "-";
  const hitRate = e.resolved > 0 ? ((e.resWin / e.resolved) * 100).toFixed(0) + "%" : "-";
  console.log(
    `  D+${d}  | ${String(e.n).padStart(3)}   | ${e.pnl.toFixed(2).padStart(8)} | ${e.win}/${e.n} (${winRate}) | ${e.resWin}/${e.resolved} (${hitRate})`,
  );
}

/* ------------------------------------------------------------------ */
/* G+H. 偏差修正预演 + 偏差扫描（最优修正值搜索）                      */
/* ------------------------------------------------------------------ */
console.log("\n===== G. 偏差修正预演（D+1 +0.64°C / D+2 +1.12°C，F 城市×1.8） =====");
// 对每个已结算市场的仓位：用其开仓时的预报温度 forecast_temp 模拟"修正后
// 会选中的桶"（单点桶 = round(预报+偏差)），对比当前实际买的桶的命中率。
const BIAS_D1_C = 0.64;
const BIAS_D2_C = 1.12;
const gSamples: { p: SimPos; m: Mkt; d: number }[] = [];
for (const p of allPos as SimPos[]) {
  if (p.status !== "closed" || p.forecast_temp == null) continue;
  const m = markets.find(
    (mm) => mm.city_name === p._city && mm.date === p._date && mm.status === "resolved" && mm.actual_temp != null,
  );
  if (!m || m.actual_temp == null) continue;
  gSamples.push({ p, m, d: daysTo(p._date, p.opened_at) });
}
function corrHitFor(p: SimPos, m: Mkt, bias: number): boolean {
  const ft = p.forecast_temp ?? 0;
  const corr = Math.round((ft + bias) * 10) / 10;
  if (p.bucket_high - p.bucket_low === 0) {
    return Math.round(m.actual_temp ?? 0) === Math.round(corr);
  }
  const shift = corr - ft;
  return inBucket(m.actual_temp ?? 0, p.bucket_low + shift, p.bucket_high + shift);
}
let gCurHit = 0;
let gCorrHit = 0;
let gSettledWinDelta = 0;
for (const s of gSamples) {
  const biasC = s.d <= 0 ? 0 : s.d === 1 ? BIAS_D1_C : BIAS_D2_C;
  const bias = s.m.unit === "C" ? biasC : biasC * 1.8;
  const cur = inBucket(s.m.actual_temp ?? 0, s.p.bucket_low, s.p.bucket_high);
  const corrHit = corrHitFor(s.p, s.m, bias);
  if (cur) gCurHit += 1;
  if (corrHit) gCorrHit += 1;
  if (!cur && corrHit) gSettledWinDelta += 1;
}
console.log(`已结算且记录开仓预报的仓: ${gSamples.length} 笔`);
console.log(`  当前桶命中: ${gCurHit}/${gSamples.length} (${((gCurHit / Math.max(1, gSamples.length)) * 100).toFixed(0)}%)`);
console.log(`  修正后桶命中: ${gCorrHit}/${gSamples.length} (${((gCorrHit / Math.max(1, gSamples.length)) * 100).toFixed(0)}%)`);
console.log(`  修正后新增命中(原本未中): ${gSettledWinDelta} 笔`);

console.log("\n===== H. 偏差扫描（搜索最优修正值，bias 单位 °C） =====");
console.log("  bias(°C) | 总命中率   | D+0      | D+1      | D+2");
for (let b = 0; b <= 1.6; b += 0.2) {
  let hit = 0;
  const perD = new Map<number, { n: number; h: number }>();
  for (const s of gSamples) {
    const e = perD.get(s.d) ?? { n: 0, h: 0 };
    e.n += 1;
    const bias = s.m.unit === "C" ? b : b * 1.8;
    if (corrHitFor(s.p, s.m, bias)) {
      hit += 1;
      e.h += 1;
    }
    perD.set(s.d, e);
  }
  const fmt = (e: { n: number; h: number } | undefined) =>
    e && e.n > 0 ? `${e.h}/${e.n}(${((e.h / e.n) * 100).toFixed(0)}%)` : "-";
  console.log(
    `  ${b.toFixed(1).padStart(5)}   | ${hit}/${gSamples.length} (${((hit / Math.max(1, gSamples.length)) * 100).toFixed(0)}%) | ${fmt(perD.get(0))} | ${fmt(perD.get(1))} | ${fmt(perD.get(2))}`,
  );
}
console.log("  （注：预演假设修正在开仓时已知；样本仅 23 笔已结算，需独立数据验证）");
