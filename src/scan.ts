import path from "path";
import {
  BALANCE,
  CALIBRATION_MIN,
  CONSENSUS_MAX_GAP_C,
  CONSENSUS_MAX_GAP_F,
  BREAKER_SPREAD_C,
  BREAKER_SPREAD_F,
  BREAKER_TRIPS,
  BREAKER_COOLDOWN_H,
  CLOB_MAKER_MODE,
  EXIT_SPREAD_FRAC,
  ENDGAME_COOLING_HOUR,
  ENDGAME_HOURS,
  ENDGAME_LOCK_C,
  ENDGAME_LOCK_F,
  ENDGAME_LOCKED_P,
  ENDGAME_LOCAL_HOUR_MIN,
  ENDGAME_MAX_ASK,
  ENDGAME_MAX_ASK_EARLY,
  ENDGAME_MIN_ASK,
  ENDGAME_RISING_C,
  ENDGAME_RISING_F,
  ENDGAME_TAKE_PROFIT,
  ENDGAME_SWEEP,
  FORECAST_CHANGE_MIN_STREAK,
  LOCATIONS,
  LLM_GATE,
  MAX_BET,
  MAX_DEPTH_FRACTION,
  MAX_HOURS,
  MAX_OURP,
  MAX_POSITIONS_PER_MARKET,
  MAX_PRICE,
  MAX_SLIPPAGE,
  METAR_CONFIRM_ENABLED,
  METAR_CONFIRM_HOURS,
  METAR_CONFIRM_LOCAL_HOUR_MIN,
  METAR_CONFIRM_MARGIN_C,
  METAR_CONFIRM_MARGIN_F,
  METAR_DIVERGE_MARGIN_C,
  METAR_DIVERGE_MARGIN_F,
  MIN_ASK,
  MIN_EDGE,
  MIN_EV,
  MIN_HOURS,
  MIN_VOLUME,
  MONTHS,
  MONITOR_INTERVAL,
  SCAN_INTERVAL,
  SELL_SLIPPAGE_TOL,
  STOP_HARD_MULT,
  STOP_MULT,
  STOP_MULT_WIDE,
  MAX_CITY_COST_PER_DATE,
  HORIZON_D0_MULT,
  P_TIER_HIGH,
  P_TIER_HIGH_MULT,
  P_TIER_LOW,
  P_TIER_LOW_MULT,
  BIAS_HIGH_N,
  BIAS_LOW_N_MULT,
  TRADE_D0,
  BIAS_ENABLED,
} from "./config.js";
import { getEnsembleForecast, getMetar } from "./forecasts.js";
import { applyBias, getBiasN, refreshBias } from "./bias.js";
import { metarMaxInUnit, refreshMetarMaxes } from "./metar-archive.js";
import { fetchJson, sleep } from "./http.js";
import {
  betSize,
  bucketProb,
  calcEv,
  calcKelly,
  hoursToResolution,
  inBucket,
  marketCalibrated,
  parseTempRange,
} from "./math.js";
import {
  checkMarketResolved,
  fetchMarketBestPrices,
  getPolymarketEvent,
  getResolvedEventInfo,
  type GammaEvent,
} from "./polymarket.js";
import {
  clobBuyYesUsd,
  clobSellYesShares,
  clobTryMakerBuy,
  clobTryMakerSell,
  getYesBidDepth,
  isLiveClobEnabled,
  resolveYesTokenId,
} from "./clob.js";
import { exportAllToExcel } from "./export-excel.js";
import { askTradeAdvisor, resetLlmCallBudget } from "./llm.js";
import { writeInvestmentAdvice } from "./advice.js";
import type { ForecastSnap, MarketRecord, OutcomeRow, Position } from "./storage.js";
import {
  allPositions,
  appendPosition,
  getSigma,
  loadAllMarkets,
  loadCal,
  loadMarket,
  loadState,
  newMarket,
  openPositions,
  runCalibration,
  saveMarket,
  saveState,
} from "./storage.js";

function utcTodayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Most recent METAR observation recorded for a market (live obs for D+0). */
function lastMetarObs(mkt: MarketRecord): number | null {
  const snaps = mkt.forecast_snapshots ?? [];
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i]?.metar != null) return snaps[i]!.metar!;
  }
  return null;
}

function datesNext4Utc(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Approximate local wall-clock hour from longitude (noon-to-noon weather event
 *  day). Good enough to gate the endgame peak window across the 20 locations. */
function localHourFor(loc: { lon: number }): number {
  const now = new Date();
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
  return (utcHour + Math.round(loc.lon / 15) + 24) % 24;
}

/** Latest two non-null METAR observations from snapshot history. */
function metarTrend(mkt: MarketRecord): { latest: number; prev: number | null } {
  const snaps = mkt.forecast_snapshots ?? [];
  let latest: number | null = null;
  let prev: number | null = null;
  for (let i = snaps.length - 1; i >= 0; i--) {
    const m = snaps[i]?.metar;
    if (m == null) continue;
    if (latest == null) latest = m;
    else {
      prev = m;
      break;
    }
  }
  return { latest: latest ?? NaN, prev };
}

/** Whether the live observation clearly misses an open position's bucket, i.e.
 *  that bucket can no longer be the outcome. Upper break applies at any hour;
 *  lower break only once the daily max window has developed (morning obs are
 *  still heating up, so a low METAR then proves nothing). */
function metarDiverged(
  pos: Position,
  metar: number | null,
  unit: "F" | "C",
  localHour: number,
): boolean {
  if (metar == null || !Number.isFinite(metar)) return false;
  const margin = unit === "F" ? METAR_DIVERGE_MARGIN_F : METAR_DIVERGE_MARGIN_C;
  if (metar > pos.bucket_high + margin) return true;
  if (localHour >= ENDGAME_LOCAL_HOUR_MIN && metar < pos.bucket_low - margin) return true;
  return false;
}

export async function takeForecastSnapshot(
  citySlug: string,
  dates: string[],
): Promise<Record<string, ForecastSnap>> {
  const loc = LOCATIONS[citySlug]!;
  const dateSet = new Set(dates);
  const [ens, metarToday] = await Promise.all([
    getEnsembleForecast(citySlug, dateSet, loc),
    (() => {
      const today = utcTodayIso();
      return dates.includes(today) ? getMetar(citySlug, loc) : Promise.resolve(null);
    })(),
  ]);
  const nowStr = new Date().toISOString();
  const today = utcTodayIso();

  const snapshots: Record<string, ForecastSnap> = {};
  for (const date of dates) {
    const e = ens[date];
    const row: ForecastSnap = {
      ts: nowStr,
      ecmwf: e?.models.ecmwf_ifs025 ?? null,
      hrrr: e?.models.gfs_seamless ?? null,
      metar: date === today ? metarToday : null,
      best: e?.mean ?? null,
      best_source: e ? "ensemble" : null,
      ens: e ?? null,
    };
    snapshots[date] = row;
  }
  return snapshots;
}

function parseEventOutcomes(event: GammaEvent): OutcomeRow[] {
  const outcomes: OutcomeRow[] = [];
  for (const market of event.markets ?? []) {
    const question = market.question ?? "";
    const mid = String(market.id ?? "");
    const volume = Number(market.volume ?? 0);
    const rng = parseTempRange(question);
    if (!rng) continue;
    let bid: number;
    let ask: number;
    try {
      // Gamma outcomePrices = [YES, NO] bids. YES ask ≈ 1 - NO bid.
      const prices = JSON.parse(market.outcomePrices ?? "[0.5,0.5]") as number[];
      bid = Number(prices[0]);
      const noBid = prices.length > 1 ? Number(prices[1]) : 1 - bid;
      ask = Math.min(0.999, Math.max(bid, 1 - noBid));
    } catch {
      continue;
    }
    outcomes.push({
      question,
      market_id: mid,
      range: rng,
      bid: Math.round(bid * 10000) / 10000,
      ask: Math.round(ask * 10000) / 10000,
      price: Math.round(bid * 10000) / 10000,
      spread: Math.round((ask - bid) * 10000) / 10000,
      volume: Math.round(volume),
    });
  }
  outcomes.sort((a, b) => a.range[0] - b.range[0]);
  return outcomes;
}

interface SellGuard {
  /** Force the sell (stop-loss / emergency) even when the bid is thin. */
  force?: boolean;
  /** Expected exit price; if the live bid is far below it (slippage guard) and
   *  not forced, the sell is skipped and retried on a later scan. */
  expectedPrice?: number;
}

async function liveSellExitOrKeepOpen(
  pos: Position,
  label: string,
  guard: SellGuard = {},
): Promise<boolean> {
  if (!isLiveClobEnabled() || !pos.clob_yes_token_id) return true;

  // Slippage guard: never market-sell into a thin book far below the expected
  // exit. Take-profit exits wait for liquidity; stop-losses force through.
  let realBid: number | null = null;
  let realAsk: number | null = null;
  try {
    const prices = await fetchMarketBestPrices(pos.market_id);
    realBid = prices?.bestBid ?? null;
    realAsk = prices?.bestAsk ?? null;
  } catch {
    /* keep selling below */
  }
  if (realBid == null) {
    // No live quote — the market may be closed or momentarily illiquid.
    if (!guard.force) {
      console.log(`  [SELL SKIP] ${label} — no live bid (illiquid/closed), holding`);
      return false;
    }
  } else {
    if (
      !guard.force &&
      guard.expectedPrice != null &&
      realBid < guard.expectedPrice * (1 - SELL_SLIPPAGE_TOL)
    ) {
      console.log(
        `  [SELL SKIP] ${label} — bid $${realBid.toFixed(3)} too far below expected $${guard.expectedPrice.toFixed(3)} (slippage guard, holding)`,
      );
      return false;
    }
    pos.exit_price = realBid; // use the real tradable bid as the fill price
  }

  // Maker-first exit (unless forced — stop-losses must fill immediately): rest
  // a post-only GTC sell at the best ask, never crossing the spread / paying a
  // taker fee. If it does not fill within the wait window, fall back to taker.
  if (CLOB_MAKER_MODE && !guard.force && realAsk != null && realAsk < 0.999) {
    const maker = await clobTryMakerSell(pos.clob_yes_token_id, pos.shares, realAsk);
    if (maker.filled && maker.fillPrice != null) {
      pos.exit_price = maker.fillPrice;
      console.log(
        `  [CLOB] maker sold YES (${label}) @ $${maker.fillPrice.toFixed(3)}`,
      );
      return true;
    }
    console.log(
      `  [CLOB] maker sell (${label}) unfilled @ $${realAsk.toFixed(3)} — falling back to taker`,
    );
  }

  try {
    await clobSellYesShares(pos.clob_yes_token_id, pos.shares);
    console.log(
      `  [CLOB] sold YES (${label})${realBid != null ? ` @ $${realBid.toFixed(3)}` : ""}`,
    );
    return true;
  } catch (e) {
    console.error(`  [CLOB] sell failed (${label}) — leaving position open in app + on-chain`, e);
    return false;
  }
}

interface BuyExecCtx {
  locName: string;
  date: string;
  horizon: string;
  unitSym: string;
  /** Max entry price allowed (regular: MAX_PRICE, endgame: ENDGAME_MAX_ASK). */
  maxPrice: number;
  /** Sigma inflated above the city's base -> widen the stop-loss. */
  wideStop: boolean;
}

/**
 * Execute a buy signal: verify the real ask, re-check the edge after the
 * execution price refresh, place a CLOB order when live, and append the
 * position. Returns true if the position was opened.
 */
async function executeBuy(
  mkt: MarketRecord,
  signal: Position,
  ctx: BuyExecCtx,
): Promise<boolean> {
  // Extreme-weather circuit: global halt on NEW buys while active. Monitoring
  // and selling stay live (we never trap open positions). Applies to regular
  // AND endgame buys since both route through this function.
  const circuitUntil = loadState().circuit_until ?? 0;
  if (Date.now() < circuitUntil) {
    console.log(
      `  [CIRCUIT] buys halted until ${new Date(circuitUntil).toISOString()} (extreme weather) — skip ${ctx.locName} ${ctx.date}`,
    );
    return false;
  }
  // Strict forecast-validity confirmation before ANY buy (regular + endgame):
  // for same-day (D+0) markets the live observation must not already falsify
  // the target bucket — if the METAR is above the bucket's high edge, that
  // bucket can no longer be the daily max, so the prediction behind this trade
  // is invalid and we must not enter. (Only D+0 snapshots carry a METAR, so
  // future-day trades are unaffected.)
  const snaps = mkt.forecast_snapshots ?? [];
  let liveMetar: number | null = null;
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i]?.metar != null) {
      liveMetar = snaps[i]!.metar!;
      break;
    }
  }
  if (liveMetar != null) {
    const divMargin = ctx.unitSym === "F" ? METAR_DIVERGE_MARGIN_F : METAR_DIVERGE_MARGIN_C;
    if (liveMetar > signal.bucket_high + divMargin) {
      console.log(
        `  [FORECAST INVALID] ${ctx.locName} ${ctx.date} — METAR ${liveMetar}${ctx.unitSym} already above bucket ${signal.bucket_low}-${signal.bucket_high}${ctx.unitSym}, prediction falsified — skip`,
      );
      return false;
    }
  }
  let skipPosition = false;
  let liveBid: number | null = null;
  try {
    const prices = await fetchMarketBestPrices(signal.market_id);
    if (prices) {
      const realAsk = prices.bestAsk;
      const realBid = prices.bestBid;
      liveBid = realBid;
      const realSpread = Math.round((realAsk - realBid) * 10000) / 10000;
      // Skip if spread is too wide in absolute OR relative terms —
      // a wide-relative-spread bucket is structurally unprofitable to round-trip.
      if (
        realSpread > MAX_SLIPPAGE ||
        realSpread > realAsk * 0.5 ||
        realAsk >= ctx.maxPrice
      ) {
        console.log(
          `  [SKIP] ${ctx.locName} ${ctx.date} — real ask $${realAsk.toFixed(3)} spread $${realSpread.toFixed(3)}`,
        );
        skipPosition = true;
      } else {
        signal.entry_price = realAsk;
        signal.bid_at_entry = realBid;
        signal.spread = realSpread;
        signal.shares = Math.round((signal.cost / realAsk) * 100) / 100;
        signal.ev = Math.round(calcEv(signal.p, realAsk) * 10000) / 10000;
        // Execution price changed — re-verify the NET edge before buying.
        // An early exit (take-profit / forecast-change / stop) crosses the spread
        // again, so deduct a conservative fraction of the live spread.
        const estExitCost = realSpread * EXIT_SPREAD_FRAC;
        if (
          realAsk < MIN_ASK ||
          signal.ev < MIN_EV ||
          signal.p - marketCalibrated(realAsk) - estExitCost < MIN_EDGE
        ) {
          console.log(
            `  [EDGE GONE] ${ctx.locName} ${ctx.date} — real ask $${realAsk.toFixed(3)} spread $${realSpread.toFixed(3)} net edge (exit cost $${estExitCost.toFixed(3)}) no longer profitable`,
          );
          skipPosition = true;
        }
      }
    }
  } catch (e) {
    console.error(`  [WARN] Could not fetch real ask for ${signal.market_id}:`, e);
  }

  if (skipPosition || signal.entry_price >= ctx.maxPrice) return false;

  let proceed = true;
  if (isLiveClobEnabled()) {
    const yesToken = await resolveYesTokenId(signal.market_id);
    if (!yesToken) {
      console.log(
        `  [CLOB SKIP] ${ctx.locName} ${ctx.date} — no YES token id (check Gamma / clobTokenIds)`,
      );
      proceed = false;
    } else {
      // Depth guard: never open a position whose notional exceeds MAX_DEPTH_FRACTION
      // of the top-2 levels of resting YES bid depth. A book this thin could never
      // absorb our eventual exit without severe slippage.
      const depth = await getYesBidDepth(yesToken, 2);
      if (depth != null && depth > 0) {
        const maxNotional = depth * MAX_DEPTH_FRACTION;
        if (signal.cost > maxNotional) {
          if (maxNotional < 0.5) {
            console.log(
              `  [DEPTH SKIP] ${ctx.locName} ${ctx.date} — depth $${depth.toFixed(2)} too thin for $${signal.cost.toFixed(2)}`,
            );
            proceed = false;
          } else {
            const oldCost = signal.cost;
            signal.cost = Math.floor(maxNotional * 100) / 100;
            signal.shares = Math.round((signal.cost / signal.entry_price) * 100) / 100;
            console.log(
              `  [DEPTH CAP] ${ctx.locName} ${ctx.date} — size $${oldCost.toFixed(2)} -> $${signal.cost.toFixed(2)} (depth $${depth.toFixed(2)})`,
            );
          }
        }
      }
      if (proceed) {
        try {
          if (CLOB_MAKER_MODE && liveBid != null) {
            // Maker-first: rest a post-only GTC buy at the best bid; a fill
            // never crosses the spread (and pays no maker fee). If it does not
            // fill within the wait window, fall back to the taker market order.
            const maker = await clobTryMakerBuy(yesToken, signal.cost, liveBid);
            if (maker.filled && maker.fillPrice != null) {
              signal.entry_price = maker.fillPrice;
              signal.bid_at_entry = maker.fillPrice;
              signal.shares = Math.round((signal.cost / maker.fillPrice) * 100) / 100;
              signal.ev = Math.round(calcEv(signal.p, maker.fillPrice) * 10000) / 10000;
              console.log(
                `  [CLOB] maker buy filled ${ctx.locName} ${ctx.date} @ $${maker.fillPrice.toFixed(3)}`,
              );
            } else {
              await clobBuyYesUsd(yesToken, signal.cost);
              console.log(
                `  [CLOB] taker buy ${ctx.locName} ${ctx.date} @ $${signal.entry_price.toFixed(3)} (maker unfilled, fallback)`,
              );
            }
          } else {
            await clobBuyYesUsd(yesToken, signal.cost);
          }
          signal.clob_yes_token_id = yesToken;
        } catch (e) {
          console.error(`  [CLOB BUY FAIL] ${ctx.locName} ${ctx.date}:`, e);
          proceed = false;
        }
      }
    }
  }
  if (!proceed) return false;

  // Per-city, per-date exposure cap: total COST of open positions for the same
  // (city, date) must stay under MAX_CITY_COST_PER_DATE. Prevents one city's
  // weather black-swan (or a streak of bad buckets) from sinking the account.
  const cityDateCost =
    (mkt.positions ?? [])
      .filter((p) => p.status === "open")
      .reduce((s, p) => s + (p.cost || 0), 0) + signal.cost;
  if (cityDateCost > MAX_CITY_COST_PER_DATE) {
    console.log(
      `  [CITY CAP] ${ctx.locName} ${ctx.date} — ${cityDateCost.toFixed(2)} > $${MAX_CITY_COST_PER_DATE} cap, skip`,
    );
    return false;
  }

  // Dynamic (sigma-aware) stop-loss, anchored to the bid at entry so low-price
  // buckets are never stopped out instantly. Sigma inflated above the city's
  // base (model disagreement) widens the stop to survive normal volatility.
  if (signal.stop_price == null) {
    const mult = ctx.wideStop ? STOP_MULT_WIDE : STOP_MULT;
    signal.stop_price =
      Math.round(Math.min(signal.entry_price * mult, signal.bid_at_entry * mult) * 1000) / 1000;
  }

  appendPosition(mkt, signal);
  const bucketLabel = `${signal.bucket_low}-${signal.bucket_high}${ctx.unitSym}`;
  console.log(
    `  [BUY]  ${ctx.locName} ${ctx.horizon} ${ctx.date} | ${bucketLabel} | ` +
      `$${signal.entry_price.toFixed(3)} | EV ${signal.ev >= 0 ? "+" : ""}${signal.ev.toFixed(2)} | ` +
      `edge ${(signal.p - marketCalibrated(signal.entry_price)).toFixed(3)} | ` +
      `$${signal.cost.toFixed(2)} (${(signal.forecast_src ?? "").toUpperCase()})`,
  );
  // Beginner-friendly investment-advice report (fail-open, never affects trading).
  try {
    const rep = await writeInvestmentAdvice(mkt, signal, ctx);
    if (rep) console.log(`  [ADVICE] report: ${path.basename(rep)}`);
  } catch (e) {
    console.warn(`  [ADVICE] report generation failed: ${String(e)}`);
  }
  return true;
}

async function liveSellSettlementAttempt(pos: Position, label: string): Promise<void> {
  if (!isLiveClobEnabled() || !pos.clob_yes_token_id) return;
  try {
    await clobSellYesShares(pos.clob_yes_token_id, pos.shares);
    console.log(`  [CLOB] sold YES (${label})`);
  } catch (e) {
    console.warn(`  [CLOB] settlement sell failed (${label}) — you may redeem/close manually`, e);
  }
}

export async function scanAndUpdate(): Promise<{ newPos: number; closed: number; resolved: number }> {
  const now = new Date();
  const state = loadState();
  resetLlmCallBudget();
  // Horizon-aware rolling bias table, recomputed once per run from resolved markets.
  const bias = refreshBias(loadAllMarkets());
  const biasKeys = Object.keys(bias).length;
  if (biasKeys > 0) console.log(`  [BIAS] ${biasKeys} corrections in table (auto-apply ${BIAS_ENABLED ? "ON" : "OFF"})`);
  // Settlement-source truth: per-station daily max from the METAR hourly archive.
  await refreshMetarMaxes();
  let balance = state.balance;
  let newPos = 0;
  let closed = 0;
  let resolved = 0;
  // Extreme-weather circuit breaker: markets whose ensemble spread explodes.
  let breakerTrips = 0;

  for (const citySlug of Object.keys(LOCATIONS)) {
    const loc = LOCATIONS[citySlug]!;
    const unit = loc.unit;
    const unitSym = unit === "F" ? "F" : "C";
    process.stdout.write(`  -> ${loc.name}... `);

    const dates = datesNext4Utc();
    let snapshots: Record<string, ForecastSnap>;
    try {
      snapshots = await takeForecastSnapshot(citySlug, dates);
      await sleep(300);
    } catch (e) {
      console.log(`skipped (${String(e)})`);
      continue;
    }

    for (let i = 0; i < 4; i++) {
      const date = dates[i];
      if (!date) continue;
      const parts = date.split("-").map(Number);
      const mo = parts[1];
      const day = parts[2];
      const year = parts[0];
      if (!mo || !day || !year) continue;
      const monthName = MONTHS[mo - 1];
      if (!monthName) continue;

      const event = await getPolymarketEvent(citySlug, monthName, day, year);
      if (!event) continue;

      const endDate = event.endDate ?? "";
      const hours = endDate ? hoursToResolution(endDate) : 0;
      const horizon = `D+${i}`;

      let mkt = loadMarket(citySlug, date);
      if (mkt === null) {
        if (hours < MIN_HOURS || hours > MAX_HOURS) continue;
        mkt = newMarket(citySlug, date, event, hours);
      }

      if (mkt.status === "resolved") continue;

      const outcomes = parseEventOutcomes(event);
      mkt.all_outcomes = outcomes;

      const snap = snapshots[date] ?? {};
      const forecastSnap: ForecastSnap = {
        ts: snap.ts,
        horizon,
        hours_left: Math.round(hours * 10) / 10,
        ecmwf: snap.ecmwf ?? null,
        hrrr: snap.hrrr ?? null,
        metar: snap.metar ?? null,
        best: snap.best ?? null,
        best_source: snap.best_source ?? null,
        ens: snap.ens ?? null,
      };
      mkt.forecast_snapshots.push(forecastSnap);

      const top = outcomes.length ? outcomes.reduce((a, b) => (a.price >= b.price ? a : b)) : null;
      mkt.market_snapshots.push({
        ts: snap.ts,
        top_bucket: top ? `${top.range[0]}-${top.range[1]}${unitSym}` : null,
        top_price: top ? top.price : null,
      });

      const forecastTemp = snap.best ?? null;
      const bestSource = snap.best_source ?? null;
      // City's calibrated (base) sigma — used for the horizon scale, the
      // wide-stop decision, and the endgame stop too.
      const baseSigma = getSigma(citySlug, bestSource ?? "ecmwf");

      for (const pos of openPositions(mkt)) {
        let currentPrice: number | null = null;
        let oMatch: OutcomeRow | undefined;
        for (const o of outcomes) {
          if (o.market_id === pos.market_id) {
            currentPrice = o.price;
            oMatch = o;
            break;
          }
        }

        if (currentPrice != null && oMatch) {
          currentPrice = oMatch.bid;
          const entry = pos.entry_price;
          // Live-observation divergence: if the actual temp clearly misses the
          // bucket (upper break any hour / lower break after the peak window),
          // the bucket is no longer the outcome — close it NOW instead of
          // waiting for a stop-loss. (Only D+0 carries a METAR, so future-day
          // positions are naturally unaffected.)
          if (metarDiverged(pos, metarTrend(mkt).latest, unit, localHourFor(loc))) {
            const exitLabel = `${loc.name} ${date}`;
            const soldOk = await liveSellExitOrKeepOpen(pos, `${exitLabel} metar_diverged`, {
              force: false,
              expectedPrice: currentPrice,
            });
            if (!soldOk) continue;
            const exitPrice = pos.exit_price ?? currentPrice;
            const pnl = Math.round((exitPrice - entry) * pos.shares * 100) / 100;
            balance += pos.cost + pnl;
            pos.closed_at = snap.ts ?? null;
            pos.close_reason = "metar_diverged";
            pos.exit_price = exitPrice;
            pos.pnl = pnl;
            pos.status = "closed";
            closed += 1;
            console.log(
              `  [DIVERGE] ${loc.name} ${date} — METAR ${metarTrend(mkt).latest}${unitSym} misses b${pos.bucket_low}-${pos.bucket_high} | exit $${exitPrice.toFixed(3)} | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
            );
            continue;
          }
          // Thin bucket markets have wide bid/ask spreads; anchor the stop to the
          // entry BID (what we could actually exit at) so the spread doesn't
          // instantly trigger a stop right after opening.
          // Price-stop gate (2026-08-03 audit): only fire the price-based stop on
          // D+0 (hoursLeft<24) once the daily max has formed (local >=
          // ENDGAME_LOCAL_HOUR_MIN, now 15h). Before then the orderbook is
          // information-noise ("current temp low" != "daily max low") and price-
          // stops kill winning tickets (Ankara 7-31: stopped at local 09:08 on an
          // 18°C obs, actual max was 26°C — a hit). D+1/D+2 rely on
          // forecast_changed + metarDiverged instead. hardCrash always fires.
          const hoursLeft = hoursToResolution(mkt.event_end_date);
          const localHour = localHourFor(loc);
          const priceStopAllowed = hoursLeft < 24 && localHour >= ENDGAME_LOCAL_HOUR_MIN;
          const stop = pos.stop_price ?? Math.min(entry * STOP_MULT, pos.bid_at_entry * STOP_MULT);

          if (currentPrice >= entry * 1.2 && stop < entry) {
            pos.stop_price = entry;
            pos.trailing_activated = true;
          }

          if (currentPrice <= stop) {
            const hardCrash = currentPrice < entry * STOP_HARD_MULT;
            if (!priceStopAllowed && !hardCrash) {
              console.log(
                `  [STOP HOLD] ${loc.name} ${date} — bid $${currentPrice.toFixed(3)} below stop $${stop.toFixed(3)} but daily max not formed (local ${localHour.toFixed(1)}h, ${hoursLeft.toFixed(0)}h left), hold for info-stop`,
              );
              continue;
            }
            // Stop-loss confirm (same as monitorPositions): a transient dip in a
            // thin book is marked pending first; only a persisting dip or a hard
            // crash (< STOP_HARD_MULT × entry) exits immediately.
            if (!hardCrash && !pos.stop_pending) {
              pos.stop_pending = true;
              console.log(
                `  [STOP PENDING] ${loc.name} ${date} — bid $${currentPrice.toFixed(3)} below stop $${stop.toFixed(3)}, confirm next scan`,
              );
              continue;
            }
            const exitLabel = `${loc.name} ${date}`;
            const soldOk = await liveSellExitOrKeepOpen(pos, exitLabel, {
              force: true,
              expectedPrice: currentPrice,
            });
            if (!soldOk) continue;
            const exitPrice = pos.exit_price ?? currentPrice;
            const pnl = Math.round((exitPrice - entry) * pos.shares * 100) / 100;
            balance += pos.cost + pnl;
            pos.closed_at = snap.ts ?? null;
            pos.close_reason = exitPrice < entry ? "stop_loss" : "trailing_stop";
            pos.exit_price = exitPrice;
            pos.pnl = pnl;
            pos.status = "closed";
            closed += 1;
            const reason = exitPrice < entry ? "STOP" : "TRAILING BE";
            console.log(
              `  [${reason}] ${loc.name} ${date} | entry $${entry.toFixed(3)} exit $${exitPrice.toFixed(3)} | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
            );
          }
        }
      }

      if (forecastTemp != null) {
        const open = openPositions(mkt);
        const buffer = unit === "F" ? 2.0 : 1.0;
        const fcLocalHour = localHourFor(loc);
        const fcGateOpen = fcLocalHour >= ENDGAME_LOCAL_HOUR_MIN;
        for (const pos of open) {
          const oldLow = pos.bucket_low;
          const oldHigh = pos.bucket_high;
          const midBucket =
            oldLow !== -999 && oldHigh !== 999 ? (oldLow + oldHigh) / 2 : forecastTemp;
          const forecastFar =
            Math.abs(forecastTemp - midBucket) > Math.abs(midBucket - oldLow) + buffer;
          const diverged = !inBucket(forecastTemp, oldLow, oldHigh) && forecastFar;
          // forecast_changed gate (2026-08-03): close only when the forecast has
          // been outside the bucket for >= FORECAST_CHANGE_MIN_STREAK CONSECUTIVE
          // scans AND the local hour is past ENDGAME_LOCAL_HOUR_MIN (daily max
          // formed). Before the max forms a one-scan wobble is noise; Miami 7-31
          // was killed at local 12:00 by a single hrrr 96->93 dip, the max later
          // hit 96.5 in the bucket. Reset the streak on any in-bucket scan.
          if (!diverged) {
            pos.forecast_change_streak = 0;
            continue;
          }
          const streak = (pos.forecast_change_streak ?? 0) + 1;
          pos.forecast_change_streak = streak;
          if (!fcGateOpen) {
            console.log(
              `  [FC HOLD] ${loc.name} ${date} — forecast ${forecastTemp}${unitSym} outside b${oldLow}-${oldHigh}${unitSym} (streak ${streak}) but daily max not formed (local ${fcLocalHour.toFixed(1)}h < ${ENDGAME_LOCAL_HOUR_MIN}), hold`,
            );
            continue;
          }
          if (streak < FORECAST_CHANGE_MIN_STREAK) {
            console.log(
              `  [FC PENDING] ${loc.name} ${date} — forecast ${forecastTemp}${unitSym} outside b${oldLow}-${oldHigh}${unitSym} (streak ${streak}/${FORECAST_CHANGE_MIN_STREAK}), confirm next scan`,
            );
            continue;
          }
          let currentPrice: number | null = null;
          for (const o of outcomes) {
            if (o.market_id === pos.market_id) {
              currentPrice = o.price;
              break;
            }
          }
          if (currentPrice != null) {
            const exitLabel = `${loc.name} ${date}`;
            const soldOk = await liveSellExitOrKeepOpen(pos, `${exitLabel} forecast_changed`, {
              force: false,
              expectedPrice: currentPrice,
            });
            if (!soldOk) continue;
            const exitPrice = pos.exit_price ?? currentPrice;
            const pnl = Math.round((exitPrice - pos.entry_price) * pos.shares * 100) / 100;
            balance += pos.cost + pnl;
            pos.closed_at = snap.ts ?? null;
            pos.close_reason = "forecast_changed";
            pos.exit_price = exitPrice;
            pos.pnl = pnl;
            pos.status = "closed";
            closed += 1;
            console.log(
              `  [CLOSE] ${loc.name} ${date} — forecast changed (streak ${streak}) | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
            );
          }
        }
      }

      if (openPositions(mkt).length < MAX_POSITIONS_PER_MARKET && forecastTemp != null && hours >= MIN_HOURS && (TRADE_D0 || i > 0 || METAR_CONFIRM_ENABLED)) {
        const ens = snap.ens;
        // Extreme-weather breaker: if the models blow apart (spread above the
        // threshold), this market's forecast is untrustworthy — skip it. Counts
        // toward the global circuit below when widespread.
        const breakerSpread = unit === "C" ? BREAKER_SPREAD_C : BREAKER_SPREAD_F;
        if (ens && ens.spread > breakerSpread) {
          console.log(
            `  [BREAKER] ${loc.name} ${date} — ensemble spread ${ens.spread.toFixed(1)}°${unitSym} > ${breakerSpread.toFixed(1)}° (unstable weather, skip)`,
          );
          breakerTrips += 1;
          continue;
        }
        // P0: model consensus gate — skip when major models disagree strongly.
        const maxGap = unit === "C" ? CONSENSUS_MAX_GAP_C : CONSENSUS_MAX_GAP_F;
        if (ens && ens.gap > maxGap) {
          console.log(
            `  [CONSENSUS SKIP] ${loc.name} ${date} — ECMWF vs GFS gap ${ens.gap.toFixed(1)}°${unitSym} > ${maxGap.toFixed(1)}°`,
          );
        } else {
          // The historical sigma (calibrated over all horizons) is too fat near
          // resolution. The live ensemble spread is the truest uncertainty signal:
          // use it as the sigma, floored at half the historical value so edges
          // concentrate around a (possibly model-updated) mean instead of phantom tails.
          const horizonScale = 1 + Math.max(0, hours - 6) / 48;
          let sigma = baseSigma * horizonScale;
          if (ens && ens.spread > 0) {
            sigma = Math.max(ens.spread, baseSigma * 0.5);
          }
          sigma = Math.round(sigma * 1000) / 1000;

          // Horizon-aware rolling bias correction on the chosen forecast (the
          // mean is already ECMWF-corrected in-model; "best" holds the residual).
          const biasSource = bestSource === "ensemble" ? "best" : bestSource ?? "best";
          const adjForecast = applyBias(forecastTemp, citySlug, horizon, biasSource);
          const biasDelta = adjForecast - forecastTemp;

          // P2: scan every bucket, spread capital across the forecast distribution.
          // A bucket is bought at most ONCE per market — even if a previous
          // position on it was closed (stop/forecast-change), we never re-enter
          // the same bucket. Tracked via ALL historical positions' market ids.
          const heldIds = new Set((mkt.positions ?? []).map((p) => p.market_id));
          // Confidence-weighted sizing factors (config.ts, backtest-optimize.ts):
          // D+0 hits 60% vs D+1 52% -> size up; high-p hits 67% vs low-p 43%;
          // bias n>=8 hits 55% vs n<8 27% -> size down low-confidence.
          const biasN = getBiasN(citySlug, horizon, biasSource);
          const horizonFactor = horizon === "D+0" ? HORIZON_D0_MULT : 1.0;
          const biasFactor = biasN >= BIAS_HIGH_N ? 1.0 : BIAS_LOW_N_MULT;
          const candidates: {
            o: OutcomeRow;
            p: number;
            ev: number;
            edge: number;
            kelly: number;
            size: number;
          }[] = [];
          for (const o of outcomes) {
            const [tLow, tHigh] = o.range;
            if (heldIds.has(o.market_id)) continue;
            if (o.volume < MIN_VOLUME) continue;
            const ask = o.ask;
            if (ask < MIN_ASK || ask >= MAX_PRICE) continue;
            const p = bucketProb(adjForecast, tLow, tHigh, sigma);
            if (p > MAX_OURP) {
              console.log(
                `  [MAX_OURP] ${loc.name} ${date} ${tLow}-${tHigh}${unitSym} — p ${p.toFixed(3)} > ${MAX_OURP.toFixed(2)}, skip`,
              );
              continue;
            }
            const ev = calcEv(p, ask);
            // P2: compare against the market's calibrated probability (weather markets overconfident).
            const calProb = marketCalibrated(ask);
            const edge = p - calProb;
            if (ev < MIN_EV || edge < MIN_EDGE) continue;
            const kelly = calcKelly(p, ask);
            const pFactor = p >= P_TIER_HIGH ? P_TIER_HIGH_MULT : p >= P_TIER_LOW ? 1.0 : P_TIER_LOW_MULT;
            const adjMaxBet = MAX_BET * horizonFactor * pFactor * biasFactor;
            const size = betSize(kelly, balance, adjMaxBet);
            if (size < 0.5) continue;
            candidates.push({ o, p, ev, edge, kelly, size });
          }
          // Sort survivors by model probability p, NOT edge. Backtest 2026-08-03
          // (scripts/backtest-strategy.ts): selecting the highest-p bucket hits
          // 46.7% (in-sample) / 28.3% (leave-one-out) vs 7.0% for edge ordering.
          // edge stays as the admission filter (MIN_EDGE above) so we never buy a
          // bucket the market has already priced correctly — but among survivors
          // we want the bucket closest to the (bias-corrected) forecast mode, not
          // the bucket where the model disagrees most with the market (edge
          // ordering selected market-skeptic buckets that hit only 7%).
          candidates.sort((a, b) => b.p - a.p);
          // Diagnostic: best achievable edge across tradeable buckets (unfiltered by EV/edge).
          let maxEdgeAll = -1;
          for (const o of outcomes) {
            const ask = o.ask;
            if (ask < MIN_ASK || ask >= MAX_PRICE) continue;
            const p = bucketProb(adjForecast, o.range[0], o.range[1], sigma);
            maxEdgeAll = Math.max(maxEdgeAll, p - marketCalibrated(ask));
          }
          console.log(
            `  [SCAN] ${loc.name} ${date} — ${outcomes.length} buckets | gap ${ens?.gap != null ? ens.gap.toFixed(1) : "n/a"}° | ${candidates.length} candidates | maxEdge ${maxEdgeAll.toFixed(3)}${biasDelta !== 0 ? ` | bias ${biasDelta >= 0 ? "+" : ""}${biasDelta.toFixed(1)}°` : ""}`,
          );

          // D+0 METAR confirmation ("safe same-day"): only trade event-day markets
          // whose target bucket is confirmed by live observations — the obs must
          // already be at/near the bucket's low edge and not collapsing, and the
          // local hour must have developed past the morning (daily max in play).
          let pool = candidates;
          if (i === 0 && METAR_CONFIRM_ENABLED) {
            if (hours > METAR_CONFIRM_HOURS) {
              console.log(
                `  [METAR CONFIRM] ${loc.name} ${date} — ${hours.toFixed(0)}h to resolution > ${METAR_CONFIRM_HOURS}h, skip D+0`,
              );
              pool = [];
            } else {
              const localHour = localHourFor(loc);
              const { latest: curMetar, prev: prevMetar } = metarTrend(mkt);
              const margin = unit === "F" ? METAR_CONFIRM_MARGIN_F : METAR_CONFIRM_MARGIN_C;
              if (localHour < METAR_CONFIRM_LOCAL_HOUR_MIN) {
                console.log(
                  `  [METAR CONFIRM] ${loc.name} ${date} — local ${localHour.toFixed(1)}h before ${METAR_CONFIRM_LOCAL_HOUR_MIN}h, skip ${pool.length} D+0 candidate(s)`,
                );
                pool = [];
              } else if (curMetar == null || !Number.isFinite(curMetar)) {
                console.log(
                  `  [METAR CONFIRM] ${loc.name} ${date} — no METAR obs, skip ${pool.length} D+0 candidate(s)`,
                );
                pool = [];
              } else {
                const kept = pool.filter((c) => {
                  const [tLow] = c.o.range;
                  if (tLow === -999) return true;
                  const near = curMetar >= tLow - margin;
                  const notCollapsing = prevMetar == null || curMetar >= prevMetar - margin;
                  return near && notCollapsing;
                });
                if (kept.length < pool.length) {
                  console.log(
                    `  [METAR CONFIRM] ${loc.name} ${date} — obs ${curMetar}°${unitSym}: kept ${kept.length}/${pool.length} D+0 candidate(s)`,
                  );
                }
                pool = kept;
              }
            }
          }
          const picks = pool.slice(0, MAX_POSITIONS_PER_MARKET - openPositions(mkt).length);

          // LLM risk advisor: review the candidates before execution. Advisory by
          // default (logs [LLM] lines for the weekly review); hard veto only when
          // WEATHERBOT_LLM_GATE=true. Fail-open: any LLM error leaves the trade untouched.
          let llmBlocked = new Set<string>();
          if (picks.length > 0) {
            const res = await askTradeAdvisor({
              city_name: loc.name,
              date,
              unit: unitSym,
              forecast: adjForecast,
              forecast_source: bestSource ?? "ensemble",
              ensemble_gap: ens?.gap ?? null,
              ensemble_spread: ens?.spread ?? null,
              sigma,
              metar: snap.metar ?? null,
              strategy: "regular",
              open_positions: openPositions(mkt).length,
              candidates: picks.map((pk) => ({
                bucket: `${pk.o.range[0]}-${pk.o.range[1]}${unitSym}`,
                ask: pk.o.ask,
                bid: pk.o.bid,
                our_prob: pk.p,
                edge: pk.edge,
                ev: pk.ev,
                volume: pk.o.volume,
                spread: pk.o.spread,
                hours_left: hours,
              })),
            });
            if (res) {
              for (let i = 0; i < picks.length; i++) {
                const v = res.verdicts[i];
                if (!v) continue;
                console.log(
                  `  [LLM] ${loc.name} ${date} ${picks[i]!.o.range[0]}-${picks[i]!.o.range[1]}${unitSym} — ${v.action} (risk ${v.risk}) ${v.reason}`,
                );
                if (LLM_GATE && v.action === "skip") llmBlocked.add(picks[i]!.o.market_id);
              }
            }
          }

          for (const pick of picks) {
            if (LLM_GATE && llmBlocked.has(pick.o.market_id)) {
              console.log(
                `  [LLM GATE] ${loc.name} ${date} ${pick.o.range[0]}-${pick.o.range[1]}${unitSym} — blocked by LLM`,
              );
              continue;
            }
            const o = pick.o;
            const [tLow, tHigh] = o.range;
            const signal: Position = {
              market_id: o.market_id,
              question: o.question,
              bucket_low: tLow,
              bucket_high: tHigh,
              entry_price: o.ask,
              bid_at_entry: o.bid,
              spread: o.spread,
              shares: Math.round((pick.size / o.ask) * 100) / 100,
              cost: pick.size,
              p: Math.round(pick.p * 10000) / 10000,
              ev: Math.round(pick.ev * 10000) / 10000,
              kelly: Math.round(pick.kelly * 10000) / 10000,
              forecast_temp: adjForecast,
              forecast_src: bestSource,
              sigma,
              opened_at: snap.ts,
              status: "open",
              pnl: null,
              exit_price: null,
              close_reason: null,
              closed_at: null,
            };

            const filled = await executeBuy(mkt, signal, {
              locName: loc.name,
              date,
              horizon,
              unitSym,
              maxPrice: MAX_PRICE,
              wideStop: sigma > baseSigma,
            });
            if (filled) {
              balance -= signal.cost;
              state.total_trades += 1;
              newPos += 1;
            }
          }
        }
      }

      // Endgame sweep: within ENDGAME_HOURS of resolution, a live METAR obs at or
      // beyond the forecast peak locks the daily max. The market often still prices
      // these near-certain buckets with lag (0.75-0.95) — buy and hold to settlement.
      //
      // Time-trap guards (the daily max usually peaks at local 14:00-16:00):
      //   1. before local ENDGAME_LOCAL_HOUR_MIN an obs near the peak is NOT a
      //      locked max — a cloud gap can spike it or the sun keeps heating.
      //   2. if the obs is still rising vs the previous observation, don't lock.
      //   3. unless cooling is confirmed (local hour + falling obs), buy under a
      //      stricter cap (ENDGAME_MAX_ASK_EARLY) to avoid overpaying a "locked"
      //      peak that might still break higher.
      if (ENDGAME_SWEEP && i === 0 && hours < ENDGAME_HOURS) {
        const metar = snap.metar;
        const ensMean = snap.ens?.mean ?? null;
        if (metar != null && ensMean != null) {
          const localHour = localHourFor(loc);
          const { latest: curMetar, prev: prevMetar } = metarTrend(mkt);
          const risingBuf = unit === "F" ? ENDGAME_RISING_F : ENDGAME_RISING_C;
          const rising = prevMetar != null && curMetar >= prevMetar + risingBuf;
          const afterPeakWindow = localHour >= ENDGAME_LOCAL_HOUR_MIN;
          const lockBuf = unit === "F" ? ENDGAME_LOCK_F : ENDGAME_LOCK_C;
          const locked = afterPeakWindow && !rising && metar >= ensMean - lockBuf;
          if (locked && openPositions(mkt).length < MAX_POSITIONS_PER_MARKET) {
            const cooling =
              localHour >= ENDGAME_COOLING_HOUR &&
              prevMetar != null &&
              curMetar <= prevMetar;
            const egMaxAsk = cooling ? ENDGAME_MAX_ASK : ENDGAME_MAX_ASK_EARLY;
            // Same one-buy-per-bucket rule applies in endgame (all history).
            const heldIds = new Set((mkt.positions ?? []).map((p) => p.market_id));
            const egCandidates: {
              o: OutcomeRow;
              p: number;
              ev: number;
              edge: number;
              kelly: number;
              size: number;
            }[] = [];
            for (const o of outcomes) {
              if (heldIds.has(o.market_id)) continue;
              const ask = o.ask;
              if (ask < ENDGAME_MIN_ASK || ask > egMaxAsk) continue;
              // Observation-based certainty: a locked obs that falls in the bucket
              // is essentially the outcome (continuous-Gaussian tail probs under-
              // state near-resolution certainty, so use a fixed locked probability).
              // NOTE: endgame is an INDEPENDENT strategy — MAX_OURP does NOT apply
              // here. The 0.93 probability reflects a locked METAR observation (near
              // certain), not model overconfidence. AI risk advisor is the sole gate.
              const p = inBucket(metar, o.range[0], o.range[1])
                ? ENDGAME_LOCKED_P
                : 0;
              if (p <= 0) continue;
              const edge = p - marketCalibrated(ask);
              if (edge < MIN_EDGE) continue;
              const kelly = calcKelly(p, ask);
              const size = betSize(kelly, balance, MAX_BET);
              if (size < 0.5) continue;
              egCandidates.push({ o, p, ev: calcEv(p, ask), edge, kelly, size });
            }
            egCandidates.sort((a, b) => b.edge - a.edge);
            console.log(
              `  [ENDGAME] ${loc.name} ${date} — METAR ${metar}${unitSym} local ${localHour.toFixed(1)}h ${rising ? "RISING" : "steady/falling"}, ${egCandidates.length} certain-bucket candidates (ask cap ${egMaxAsk})`,
            );
            const pick = egCandidates[0];
            // Endgame strategy: AI is the SOLE decision gate (independent of
            // LLM_GATE). The endgame buys high-probability ($0.75-0.95) buckets
            // based on a locked METAR obs — exactly the kind of "near-certain"
            // trade where AI judgment adds the most value (detecting obs errors,
            // microclimate mismatches, or a still-rising temp that could break
            // higher). LLM skip is ALWAYS binding here; proceed is the default
            // only when the AI is unavailable (fail-open to preserve liquidity).
            let llmSkip = false;
            let llmVerdict: { action: string; risk: string; reason: string } | null = null;
            if (pick) {
              const res = await askTradeAdvisor({
                city_name: loc.name,
                date,
                unit: unitSym,
                forecast: metar,
                forecast_source: "endgame (METAR)",
                ensemble_gap: snap.ens?.gap ?? null,
                ensemble_spread: snap.ens?.spread ?? null,
                sigma: lockBuf,
                metar,
                strategy: "endgame",
                open_positions: openPositions(mkt).length,
                candidates: [
                  {
                    bucket: `${pick.o.range[0]}-${pick.o.range[1]}${unitSym}`,
                    ask: pick.o.ask,
                    bid: pick.o.bid,
                    our_prob: pick.p,
                    edge: pick.edge,
                    ev: pick.ev,
                    volume: pick.o.volume,
                    spread: pick.o.spread,
                    hours_left: hours,
                  },
                ],
              });
              if (res) {
                const v = res.verdicts[0];
                if (v) {
                  llmVerdict = { action: v.action, risk: v.risk, reason: v.reason };
                  console.log(
                    `  [LLM ENDGAME] ${loc.name} ${date} ${pick.o.range[0]}-${pick.o.range[1]}${unitSym} — ${v.action} (risk ${v.risk}) ${v.reason}`,
                  );
                  // Endgame: AI skip is ALWAYS binding (independent of LLM_GATE).
                  if (v.action === "skip") llmSkip = true;
                }
              } else {
                console.log(
                  `  [LLM ENDGAME] ${loc.name} ${date} — AI unavailable, fail-open proceed`,
                );
              }
            }
            if (pick && !llmSkip) {
              const o = pick.o;
              const signal: Position = {
                market_id: o.market_id,
                question: o.question,
                bucket_low: o.range[0],
                bucket_high: o.range[1],
                entry_price: o.ask,
                bid_at_entry: o.bid,
                spread: o.spread,
                shares: Math.round((pick.size / o.ask) * 100) / 100,
                cost: pick.size,
                p: Math.round(pick.p * 10000) / 10000,
                ev: Math.round(pick.ev * 10000) / 10000,
                kelly: Math.round(pick.kelly * 10000) / 10000,
                forecast_temp: metar,
                forecast_src: "endgame",
                strategy: "endgame",
                sigma: lockBuf,
                opened_at: snap.ts,
                status: "open",
                pnl: null,
                exit_price: null,
                close_reason: null,
                closed_at: null,
              };
              const filled = await executeBuy(mkt, signal, {
                locName: loc.name,
                date,
                horizon,
                unitSym,
                maxPrice: egMaxAsk,
                wideStop: lockBuf > baseSigma,
              });
              if (filled) {
                balance -= signal.cost;
                state.total_trades += 1;
                newPos += 1;
              }
            }
          }
        }
      }

      if (hours < 0.5 && mkt.status === "open") {
        mkt.status = "closed";
      }

      saveMarket(mkt);
      await sleep(100);
    }

    console.log("ok");
  }

  for (const mkt of loadAllMarkets()) {
    if (mkt.status === "resolved") continue;
    const opens = openPositions(mkt);
    const hasOpenPos = opens.length > 0;
    if (!hasOpenPos && mkt.status !== "closed") continue;

    const parts = mkt.date.split("-").map(Number);
    const mo = parts[1];
    const day = parts[2];
    const year = parts[0];
    if (!mo || !day || !year) continue;
    const monthName = MONTHS[mo - 1];
    if (!monthName) continue;

    // 事件结算后恰好一个桶 YES ≈ 1，用它反推实际温度；同时免去额外请求即可判定胜负
    const info = await getResolvedEventInfo(mkt.city, monthName, day, year);
    let wonByMarket: Map<string, boolean> | null = null;

    if (info && info.resolved) {
      mkt.actual_temp = info.actualTemp;
      // Settlement-source alignment: compare Polymarket's resolved value (bucket
      // midpoint) with the station's true METAR daily max (the settlement source).
      const stationMax = metarMaxInUnit(mkt.station, mkt.date, mkt.unit);
      if (stationMax != null) {
        mkt.metar_max = stationMax;
        if (mkt.actual_temp != null && Math.abs(mkt.actual_temp - stationMax) > 1) {
          console.log(
            `  [SETTLEMENT CHECK] ${mkt.city_name} ${mkt.date}: Polymarket ${mkt.actual_temp}° vs METAR max ${stationMax}° (Δ>1, verify manually)`,
          );
        }
      }
      wonByMarket = new Map(
        opens.map((p) => [p.market_id, p.market_id === info.winningMarketId] as [string, boolean]),
      );
    } else if (hasOpenPos) {
      // 事件信息拿不到或未解析出胜出桶时，退回原逻辑逐个持仓市场判断
      wonByMarket = new Map();
      for (const p of opens) {
        const r = await checkMarketResolved(p.market_id);
        if (r === null) {
          wonByMarket = null;
          break;
        }
        wonByMarket.set(p.market_id, r);
      }
    }

    if (wonByMarket == null) continue;

    if (hasOpenPos) {
      let mktPnl = 0;
      let wins = 0;
      for (const p of opens) {
        const won = wonByMarket.get(p.market_id) ?? false;
        await liveSellSettlementAttempt(p, `${mkt.city_name} ${mkt.date}`);

        const price = p.entry_price;
        const size = p.cost;
        const shares = p.shares;
        const pnl = won ? Math.round(shares * (1 - price) * 100) / 100 : Math.round(-size * 100) / 100;

        balance += size + pnl;
        p.exit_price = won ? 1.0 : 0.0;
        p.pnl = pnl;
        p.close_reason = "resolved";
        p.closed_at = now.toISOString();
        p.status = "closed";
        mktPnl += pnl;
        if (won) wins += 1;

        const result = won ? "WIN" : "LOSS";
        console.log(
          `  [${result}] ${mkt.city_name} ${mkt.date} ${p.bucket_low}-${p.bucket_high} | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
        );
      }
      mkt.pnl = Math.round(mktPnl * 100) / 100;
      mkt.resolved_outcome = wins > 0 ? "win" : "loss";
    } else {
      const unitSym = mkt.unit === "F" ? "F" : "C";
      console.log(`  [SETTLED] ${mkt.city_name} ${mkt.date} | actual ${mkt.actual_temp}${unitSym}`);
    }

    // Count win/loss for ALL historical positions on this market (including ones
    // closed early via stop_loss / forecast_changed / metarDiverged), judged by
    // the true actual_temp. Idempotent via resolved_hit — pnl/balance are NOT
    // touched (early-closed positions keep their exit-time bookkeeping; this only
    // fixes the win/loss tally that previously missed them). (2026-08-03 audit)
    if (mkt.actual_temp != null) {
      for (const p of mkt.positions ?? []) {
        if (p.resolved_hit === true || p.resolved_hit === false) continue;
        const hit = inBucket(mkt.actual_temp, p.bucket_low, p.bucket_high);
        p.resolved_hit = hit;
        if (hit) state.wins += 1;
        else state.losses += 1;
      }
    }

    mkt.status = "resolved";
    resolved += 1;

    saveMarket(mkt);
    await sleep(200);
  }

  if (breakerTrips >= BREAKER_TRIPS) {
    state.circuit_until = Date.now() + BREAKER_COOLDOWN_H * 3600e3;
    console.log(
      `  [CIRCUIT] ${breakerTrips} market(s) tripped — global buy halt until ${new Date(state.circuit_until).toISOString()}`,
    );
  }

  state.balance = Math.round(balance * 100) / 100;
  state.peak_balance = Math.max(state.peak_balance ?? balance, balance);
  saveState(state);

  const allMkts = loadAllMarkets();
  const resolvedCount = allMkts.filter((m) => m.status === "resolved").length;
  if (resolvedCount >= CALIBRATION_MIN) {
    runCalibration(allMkts);
  }

  return { newPos, closed, resolved };
}

export async function monitorPositions(): Promise<number> {
  const markets = loadAllMarkets();
  const withOpen = markets.filter((m) => openPositions(m).length > 0);
  if (!withOpen.length) return 0;

  const state = loadState();
  let balance = state.balance;
  let closed = 0;

  for (const mkt of withOpen) {
    for (const pos of openPositions(mkt)) {
      const mid = pos.market_id;

      let currentPrice: number | null = null;
      try {
        const mdata = await fetchJson<{ bestBid?: number | string | null }>(
          `https://gamma-api.polymarket.com/markets/${mid}`,
        );
        const bestBid = mdata.bestBid;
        if (bestBid != null) currentPrice = Number(bestBid);
      } catch {
        /* fallback below */
      }

      if (currentPrice == null) {
        for (const o of mkt.all_outcomes ?? []) {
          if (o.market_id === mid) {
            currentPrice = o.bid ?? o.price;
            break;
          }
        }
      }

      if (currentPrice == null) continue;

      const entry = pos.entry_price;
      // Anchor stop to entry BID (see note in scanAndUpdate) to avoid the
      // bid/ask spread instantly triggering a stop on thin bucket markets.
      let stop = pos.stop_price ?? Math.min(entry * STOP_MULT, pos.bid_at_entry * STOP_MULT);
      const cityName = LOCATIONS[mkt.city]?.name ?? mkt.city;

      const endDate = mkt.event_end_date ?? "";
      const hoursLeft = hoursToResolution(endDate);

      // Live-observation divergence: actual temp clearly misses the bucket ->
      // close now (upper break any hour / lower break after the peak window).
      const locInfo = LOCATIONS[mkt.city];
      if (locInfo && metarDiverged(pos, metarTrend(mkt).latest, mkt.unit, localHourFor(locInfo))) {
        const soldOk = await liveSellExitOrKeepOpen(pos, `${cityName} ${mkt.date} metar_diverged`, {
          force: false,
          expectedPrice: currentPrice,
        });
        if (!soldOk) continue;
        const exitPrice = pos.exit_price ?? currentPrice;
        const pnl = Math.round((exitPrice - entry) * pos.shares * 100) / 100;
        balance += pos.cost + pnl;
        pos.closed_at = new Date().toISOString();
        pos.close_reason = "metar_diverged";
        pos.exit_price = exitPrice;
        pos.pnl = pnl;
        pos.status = "closed";
        closed += 1;
        console.log(
          `  [DIVERGE] ${cityName} ${mkt.date} — METAR ${metarTrend(mkt).latest} misses b${pos.bucket_low}-${pos.bucket_high} | exit $${exitPrice.toFixed(3)} | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
        );
        saveMarket(mkt);
        continue;
      }

      let takeProfit: number | null;
      if (hoursLeft < ENDGAME_HOURS && ENDGAME_SWEEP) {
        // Endgame: if live METAR obs has locked the result INTO our bucket, hold to
        // settlement and collect the full $1.00. If not yet locked, take profit at a
        // high price (e.g. 0.90) instead of gambling on an unsettled outcome.
        const lastMetar = lastMetarObs(mkt);
        const locked =
          lastMetar != null && inBucket(lastMetar, pos.bucket_low, pos.bucket_high);
        takeProfit = locked ? null : ENDGAME_TAKE_PROFIT;
      } else if (hoursLeft < 48) takeProfit = 0.85;
      else takeProfit = 0.75;

      if (currentPrice >= entry * 1.2 && stop < entry) {
        pos.stop_price = entry;
        pos.trailing_activated = true;
        console.log(`  [TRAILING] ${cityName} ${mkt.date} — stop moved to breakeven $${entry.toFixed(3)}`);
      }

      // Price-stop gate (2026-08-03 audit, see scanAndUpdate): only fire the
      // price-based stop on D+0 once the daily max has formed (local >=14h).
      // Before then the orderbook is information-noise and price-stops kill winning
      // tickets. D+1/D+2 rely on forecast_changed + metarDiverged. hardCrash always fires.
      const localHour = locInfo ? localHourFor(locInfo) : 24;
      const priceStopAllowed = hoursLeft < 24 && localHour >= ENDGAME_LOCAL_HOUR_MIN;
      const takeTriggered = takeProfit != null && currentPrice >= takeProfit;
      const hardCrash = currentPrice < entry * STOP_HARD_MULT;
      const stopTriggered = currentPrice <= stop && (priceStopAllowed || hardCrash);
      const stopHold = currentPrice <= stop && !stopTriggered;

      // Stop-loss confirm: a transient dip in a thin book shouldn't shake us out.
      // The first dip marks the position pending — it only executes if still below
      // the stop on a later scan. A hard crash (< STOP_HARD_MULT × entry) forces
      // the exit immediately, that's a black swan not a blip.
      if (stopHold && !takeTriggered) {
        console.log(
          `  [STOP HOLD] ${cityName} ${mkt.date} ${pos.bucket_low}-${pos.bucket_high} — bid $${currentPrice.toFixed(3)} below stop $${stop.toFixed(3)} but daily max not formed (local ${localHour.toFixed(1)}h, ${hoursLeft.toFixed(0)}h left), hold for info-stop`,
        );
        continue;
      }
      if (stopTriggered && !takeTriggered && !hardCrash && !pos.stop_pending) {
        pos.stop_pending = true;
        console.log(
          `  [STOP PENDING] ${cityName} ${mkt.date} ${pos.bucket_low}-${pos.bucket_high} — bid $${currentPrice.toFixed(3)} below stop $${stop.toFixed(3)}, confirm next scan`,
        );
        saveMarket(mkt);
        continue;
      }

      if (takeTriggered || stopTriggered) {
        const soldOk = await liveSellExitOrKeepOpen(pos, `${cityName} ${mkt.date}`, {
          force: stopTriggered,
          expectedPrice: currentPrice,
        });
        if (!soldOk) continue;
        const exitPrice = pos.exit_price ?? currentPrice;
        const pnl = Math.round((exitPrice - entry) * pos.shares * 100) / 100;
        balance += pos.cost + pnl;
        pos.closed_at = new Date().toISOString();
        let reason: string;
        if (takeTriggered) {
          pos.close_reason = "take_profit";
          reason = "TAKE";
        } else if (exitPrice < entry) {
          pos.close_reason = "stop_loss";
          reason = "STOP";
        } else {
          pos.close_reason = "trailing_stop";
          reason = "TRAILING BE";
        }
        pos.exit_price = exitPrice;
        pos.pnl = pnl;
        pos.status = "closed";
        closed += 1;
        console.log(
          `  [${reason}] ${cityName} ${mkt.date} ${pos.bucket_low}-${pos.bucket_high} | entry $${entry.toFixed(3)} exit $${exitPrice.toFixed(3)} | ${hoursLeft.toFixed(0)}h left | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
        );
        saveMarket(mkt);
      }
    }
  }

  if (closed) {
    state.balance = Math.round(balance * 100) / 100;
    saveState(state);
  }

  return closed;
}

export async function runLoop(): Promise<void> {
  loadCal();

  const onSigInt = () => {
    console.log("\n  Stopping — saving state...");
    saveState(loadState());
    console.log("  Done. Bye!");
    process.exit(0);
  };
  process.once("SIGINT", onSigInt);

  console.log(`\n${"=".repeat(55)}`);
  console.log("  WEATHERBET — STARTING");
  console.log(`${"=".repeat(55)}`);
  console.log(`  Cities:     ${Object.keys(LOCATIONS).length}`);
  console.log(`  Balance:    $${BALANCE.toLocaleString("en-US", { maximumFractionDigits: 0 })} | Max bet: $${MAX_BET}`);
  console.log(`  Scan:       ${SCAN_INTERVAL / 60} min | Monitor: ${MONITOR_INTERVAL / 60} min`);
  console.log("  Sources:    ENSEMBLE(ECMWF+GFS+ICON) + METAR(D+0)");
  console.log(`  CLOB:       ${isLiveClobEnabled() ? "LIVE (@polymarket/clob-client)" : "paper (Gamma prices only)"}`);
  console.log(`  Data:       ${path.join(process.cwd(), "data")}`);
  console.log("  Ctrl+C to stop\n");

  let lastFullScan = 0;

  while (true) {
    const nowTs = Date.now() / 1000;
    const nowStr = new Date().toISOString().replace("T", " ").slice(0, 19);

    if (nowTs - lastFullScan >= SCAN_INTERVAL) {
      console.log(`[${nowStr}] full scan...`);
      try {
        const { newPos, closed, resolved } = await scanAndUpdate();
        const st = loadState();
        console.log(
          `  balance: $${st.balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | ` +
            `new: ${newPos} | closed: ${closed} | resolved: ${resolved}`,
        );
        try {
          const xlsPath = exportAllToExcel();
          console.log(`  Excel: ${xlsPath}`);
        } catch (e) {
          console.log(`  Excel export failed: ${e}`);
        }
        lastFullScan = Date.now() / 1000;
      } catch (e) {
        const msg = String(e);
        if (msg.includes("fetch") || msg.includes("ECONNREFUSED") || msg.includes("network")) {
          console.log("  Connection lost — waiting 60 sec");
          await sleep(60_000);
          continue;
        }
        console.log(`  Error: ${e} — waiting 60 sec`);
        await sleep(60_000);
        continue;
      }
    } else {
      console.log(`[${nowStr}] monitoring positions...`);
      try {
        const stopped = await monitorPositions();
        if (stopped) {
          const st = loadState();
          console.log(
            `  balance: $${st.balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          );
        }
      } catch (e) {
        console.log(`  Monitor error: ${e}`);
      }
    }

    await sleep(MONITOR_INTERVAL * 1000);
  }
}
