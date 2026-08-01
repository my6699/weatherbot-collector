import path from "path";
import {
  BALANCE,
  CALIBRATION_MIN,
  CONSENSUS_MAX_GAP_C,
  CONSENSUS_MAX_GAP_F,
  ENDGAME_HOURS,
  ENDGAME_LOCK_C,
  ENDGAME_LOCK_F,
  ENDGAME_LOCKED_P,
  ENDGAME_MAX_ASK,
  ENDGAME_MIN_ASK,
  ENDGAME_TAKE_PROFIT,
  ENDGAME_SWEEP,
  LOCATIONS,
  MAX_BET,
  MAX_HOURS,
  MAX_POSITIONS_PER_MARKET,
  MAX_PRICE,
  MAX_SLIPPAGE,
  MIN_ASK,
  MIN_EDGE,
  MIN_EV,
  MIN_HOURS,
  MIN_VOLUME,
  MONTHS,
  MONITOR_INTERVAL,
  SCAN_INTERVAL,
  TRADE_D0,
} from "./config.js";
import { getEnsembleForecast, getMetar } from "./forecasts.js";
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
import { clobBuyYesUsd, clobSellYesShares, isLiveClobEnabled, resolveYesTokenId } from "./clob.js";
import { exportAllToExcel } from "./export-excel.js";
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

async function liveSellExitOrKeepOpen(pos: Position, label: string): Promise<boolean> {
  if (!isLiveClobEnabled() || !pos.clob_yes_token_id) return true;
  try {
    await clobSellYesShares(pos.clob_yes_token_id, pos.shares);
    console.log(`  [CLOB] sold YES (${label})`);
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
  let skipPosition = false;
  try {
    const prices = await fetchMarketBestPrices(signal.market_id);
    if (prices) {
      const realAsk = prices.bestAsk;
      const realBid = prices.bestBid;
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
        // Execution price changed — re-verify the edge before buying.
        if (
          realAsk < MIN_ASK ||
          signal.ev < MIN_EV ||
          signal.p - marketCalibrated(realAsk) < MIN_EDGE
        ) {
          console.log(
            `  [EDGE GONE] ${ctx.locName} ${ctx.date} — real ask $${realAsk.toFixed(3)} no longer profitable`,
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
      try {
        await clobBuyYesUsd(yesToken, signal.cost);
        signal.clob_yes_token_id = yesToken;
      } catch (e) {
        console.error(`  [CLOB BUY FAIL] ${ctx.locName} ${ctx.date}:`, e);
        proceed = false;
      }
    }
  }
  if (!proceed) return false;

  appendPosition(mkt, signal);
  const bucketLabel = `${signal.bucket_low}-${signal.bucket_high}${ctx.unitSym}`;
  console.log(
    `  [BUY]  ${ctx.locName} ${ctx.horizon} ${ctx.date} | ${bucketLabel} | ` +
      `$${signal.entry_price.toFixed(3)} | EV ${signal.ev >= 0 ? "+" : ""}${signal.ev.toFixed(2)} | ` +
      `edge ${(signal.p - marketCalibrated(signal.entry_price)).toFixed(3)} | ` +
      `$${signal.cost.toFixed(2)} (${(signal.forecast_src ?? "").toUpperCase()})`,
  );
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
  let balance = state.balance;
  let newPos = 0;
  let closed = 0;
  let resolved = 0;

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
          // Thin bucket markets have wide bid/ask spreads; anchor the stop to the
          // entry BID (what we could actually exit at) so the spread doesn't
          // instantly trigger a stop right after opening.
          const stop = pos.stop_price ?? Math.min(entry * 0.8, pos.bid_at_entry * 0.8);

          if (currentPrice >= entry * 1.2 && stop < entry) {
            pos.stop_price = entry;
            pos.trailing_activated = true;
          }

          if (currentPrice <= stop) {
            const exitLabel = `${loc.name} ${date}`;
            const soldOk = await liveSellExitOrKeepOpen(pos, exitLabel);
            if (!soldOk) continue;
            const pnl = Math.round((currentPrice - entry) * pos.shares * 100) / 100;
            balance += pos.cost + pnl;
            pos.closed_at = snap.ts ?? null;
            pos.close_reason = currentPrice < entry ? "stop_loss" : "trailing_stop";
            pos.exit_price = currentPrice;
            pos.pnl = pnl;
            pos.status = "closed";
            closed += 1;
            const reason = currentPrice < entry ? "STOP" : "TRAILING BE";
            console.log(
              `  [${reason}] ${loc.name} ${date} | entry $${entry.toFixed(3)} exit $${currentPrice.toFixed(3)} | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
            );
          }
        }
      }

      if (forecastTemp != null) {
        const open = openPositions(mkt);
        const buffer = unit === "F" ? 2.0 : 1.0;
        for (const pos of open) {
          const oldLow = pos.bucket_low;
          const oldHigh = pos.bucket_high;
          const midBucket =
            oldLow !== -999 && oldHigh !== 999 ? (oldLow + oldHigh) / 2 : forecastTemp;
          const forecastFar =
            Math.abs(forecastTemp - midBucket) > Math.abs(midBucket - oldLow) + buffer;
          if (!inBucket(forecastTemp, oldLow, oldHigh) && forecastFar) {
            let currentPrice: number | null = null;
            for (const o of outcomes) {
              if (o.market_id === pos.market_id) {
                currentPrice = o.price;
                break;
              }
            }
            if (currentPrice != null) {
              const exitLabel = `${loc.name} ${date}`;
              const soldOk = await liveSellExitOrKeepOpen(pos, `${exitLabel} forecast_changed`);
              if (!soldOk) continue;
              const pnl = Math.round((currentPrice - pos.entry_price) * pos.shares * 100) / 100;
              balance += pos.cost + pnl;
              pos.closed_at = snap.ts ?? null;
              pos.close_reason = "forecast_changed";
              pos.exit_price = currentPrice;
              pos.pnl = pnl;
              pos.status = "closed";
              closed += 1;
              console.log(
                `  [CLOSE] ${loc.name} ${date} — forecast changed | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
              );
            }
          }
        }
      }

      if (openPositions(mkt).length < MAX_POSITIONS_PER_MARKET && forecastTemp != null && hours >= MIN_HOURS && (TRADE_D0 || i > 0)) {
        const ens = snap.ens;
        // P0: model consensus gate — skip when major models disagree strongly.
        const maxGap = unit === "C" ? CONSENSUS_MAX_GAP_C : CONSENSUS_MAX_GAP_F;
        if (ens && ens.gap > maxGap) {
          console.log(
            `  [CONSENSUS SKIP] ${loc.name} ${date} — ECMWF vs GFS gap ${ens.gap.toFixed(1)}°${unitSym} > ${maxGap.toFixed(1)}°`,
          );
        } else {
          const baseSigma = getSigma(citySlug, bestSource ?? "ecmwf");
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

          // P2: scan every bucket, spread capital across the forecast distribution.
          const heldIds = new Set(openPositions(mkt).map((p) => p.market_id));
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
            const p = bucketProb(forecastTemp, tLow, tHigh, sigma);
            const ev = calcEv(p, ask);
            // P2: compare against the market's calibrated probability (weather markets overconfident).
            const calProb = marketCalibrated(ask);
            const edge = p - calProb;
            if (ev < MIN_EV || edge < MIN_EDGE) continue;
            const kelly = calcKelly(p, ask);
            const size = betSize(kelly, balance, MAX_BET);
            if (size < 0.5) continue;
            candidates.push({ o, p, ev, edge, kelly, size });
          }
          candidates.sort((a, b) => b.edge - a.edge);
          // Diagnostic: best achievable edge across tradeable buckets (unfiltered by EV/edge).
          let maxEdgeAll = -1;
          for (const o of outcomes) {
            const ask = o.ask;
            if (ask < MIN_ASK || ask >= MAX_PRICE) continue;
            const p = bucketProb(forecastTemp, o.range[0], o.range[1], sigma);
            maxEdgeAll = Math.max(maxEdgeAll, p - marketCalibrated(ask));
          }
          console.log(
            `  [SCAN] ${loc.name} ${date} — ${outcomes.length} buckets | gap ${ens?.gap != null ? ens.gap.toFixed(1) : "n/a"}° | ${candidates.length} candidates | maxEdge ${maxEdgeAll.toFixed(3)}`,
          );
          const picks = candidates.slice(0, MAX_POSITIONS_PER_MARKET - openPositions(mkt).length);

          for (const pick of picks) {
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
              forecast_temp: forecastTemp,
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
      if (ENDGAME_SWEEP && i === 0 && hours < ENDGAME_HOURS) {
        const metar = snap.metar;
        const ensMean = snap.ens?.mean ?? null;
        if (metar != null && ensMean != null) {
          const lockBuf = unit === "F" ? ENDGAME_LOCK_F : ENDGAME_LOCK_C;
          const locked = metar >= ensMean - lockBuf;
          if (locked && openPositions(mkt).length < MAX_POSITIONS_PER_MARKET) {
            const heldIds = new Set(openPositions(mkt).map((p) => p.market_id));
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
              if (ask < ENDGAME_MIN_ASK || ask > ENDGAME_MAX_ASK) continue;
              // Observation-based certainty: a locked obs that falls in the bucket
              // is essentially the outcome (continuous-Gaussian tail probs under-
              // state near-resolution certainty, so use a fixed locked probability).
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
              `  [ENDGAME] ${loc.name} ${date} — METAR ${metar}${unitSym} locks daily max, ${egCandidates.length} certain-bucket candidates`,
            );
            const pick = egCandidates[0];
            if (pick) {
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
                maxPrice: ENDGAME_MAX_ASK,
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
        if (won) {
          wins += 1;
          state.wins += 1;
        } else {
          state.losses += 1;
        }

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

    mkt.status = "resolved";
    resolved += 1;

    saveMarket(mkt);
    await sleep(200);
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
      let stop = pos.stop_price ?? Math.min(entry * 0.8, pos.bid_at_entry * 0.8);
      const cityName = LOCATIONS[mkt.city]?.name ?? mkt.city;

      const endDate = mkt.event_end_date ?? "";
      const hoursLeft = hoursToResolution(endDate);

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

      const takeTriggered = takeProfit != null && currentPrice >= takeProfit;
      const stopTriggered = currentPrice <= stop;

      if (takeTriggered || stopTriggered) {
        const soldOk = await liveSellExitOrKeepOpen(pos, `${cityName} ${mkt.date}`);
        if (!soldOk) continue;
        const pnl = Math.round((currentPrice - entry) * pos.shares * 100) / 100;
        balance += pos.cost + pnl;
        pos.closed_at = new Date().toISOString();
        let reason: string;
        if (takeTriggered) {
          pos.close_reason = "take_profit";
          reason = "TAKE";
        } else if (currentPrice < entry) {
          pos.close_reason = "stop_loss";
          reason = "STOP";
        } else {
          pos.close_reason = "trailing_stop";
          reason = "TRAILING BE";
        }
        pos.exit_price = currentPrice;
        pos.pnl = pnl;
        pos.status = "closed";
        closed += 1;
        console.log(
          `  [${reason}] ${cityName} ${mkt.date} ${pos.bucket_low}-${pos.bucket_high} | entry $${entry.toFixed(3)} exit $${currentPrice.toFixed(3)} | ${hoursLeft.toFixed(0)}h left | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
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
