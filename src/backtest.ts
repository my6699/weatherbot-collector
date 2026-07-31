/**
 * backtest.ts — Walk through resolved Polymarket weather markets and simulate
 * what the bot would have done given historical weather data.
 *
 * Usage: npx tsx src/backtest.ts [--days 30]
 *
 * LIMITATIONS (read carefully):
 *   1. Open-Meteo Archive returns ACTUAL weather, NOT historical forecasts.
 *      This means the "forecast" used in backtest is a perfect prediction —
 *      results are an UPPER BOUND, better than real-life performance.
 *   2. For realistic backtest you need Visual Crossing API key (WEATHERBOT_VC_KEY)
 *      which provides actual historical forecast data.
 *   3. Market prices are from current Gamma API snapshots — we don't have
 *      historical order book data, so entry prices are approximated.
 */

import { loadCal } from "./storage.js";
import { LOCATIONS, MONTHS, MAX_BET, MIN_EV, MAX_PRICE, MIN_VOLUME } from "./config.js";
import { getPolymarketEvent, checkMarketResolved } from "./polymarket.js";
import { parseTempRange, inBucket, bucketProb, calcEv, calcKelly, betSize } from "./math.js";
import { getSigma } from "./storage.js";
import { fetchJson, sleep } from "./http.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BacktestTrade {
  city: string;
  date: string;
  question: string;
  bucket_low: number;
  bucket_high: number;
  entry_price: number;
  shares: number;
  cost: number;
  ev: number;
  forecast_temp: number;
  actual_temp: number | null;
  resolved_yes: boolean | null;
  pnl: number | null;
  rejected: string | null; // reason if not entered
}

interface BacktestResult {
  total_markets: number;
  trades_entered: number;
  resolved_wins: number;
  resolved_losses: number;
  unresolved: number;
  total_pnl: number;
  win_rate: string;
  trades: BacktestTrade[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDate(dateStr: string): { month: string; day: number; year: number } {
  const parts = dateStr.split("-").map(Number);
  if (parts.length !== 3) throw new Error(`Invalid date: ${dateStr}`);
  const [y, m, d] = parts;
  return { month: MONTHS[(m ?? 1) - 1] ?? "january", day: d ?? 1, year: y ?? 2026 };
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Main backtest
// ---------------------------------------------------------------------------

export async function runBacktest(options: { lookbackDays?: number } = {}): Promise<BacktestResult> {
  const { lookbackDays = 30 } = options;
  loadCal();

  const trades: BacktestTrade[] = [];
  let totalMarkets = 0;
  let entered = 0;
  let wins = 0;
  let losses = 0;
  let unresolved = 0;

  const today = new Date().toISOString().slice(0, 10);

  for (const [citySlug, loc] of Object.entries(LOCATIONS)) {
    const unit = loc.unit;
    const unitSym = unit === "F" ? "F" : "C";
    process.stdout.write(`  ${loc.name}... `);

    for (let d = 0; d < lookbackDays; d++) {
      const dateStr = daysAgo(d);
      const { month, day, year } = parseDate(dateStr);

      // 1. Fetch Polymarket event
      const event = await getPolymarketEvent(citySlug, month, day, year);
      if (!event) continue;

      // 2. Parse outcomes (temperature buckets)
      const outcomes: { question: string; market_id: string; range: [number, number]; price: number; volume: number }[] = [];
      for (const market of event.markets ?? []) {
        const question = market.question ?? "";
        const mid = String(market.id ?? "");
        const rng = parseTempRange(question);
        if (!rng) continue;
        const volume = Number(market.volume ?? 0);
        let price = 0.5;
        try {
          const prices = JSON.parse(market.outcomePrices ?? "[0.5,0.5]") as number[];
          price = Number(prices[0]);
        } catch { /* ignore */ }
        outcomes.push({ question, market_id: mid, range: rng, price, volume });
      }

      if (outcomes.length === 0) continue;
      totalMarkets++;

      // 3. Get actual historical temperature via Open-Meteo Archive (free, no key needed)
      const unit = loc.unit;
      const tempUnit = unit === "F" ? "fahrenheit" : "celsius";
      const archiveUrl =
        `https://archive-api.open-meteo.com/v1/archive` +
        `?latitude=${loc.lat}&longitude=${loc.lon}` +
        `&daily=temperature_2m_max&start_date=${dateStr}&end_date=${dateStr}` +
        `&temperature_unit=${tempUnit}&timezone=UTC`;
      let actualTemp: number | null = null;
      try {
        const archiveData = await fetchJson<{ daily?: { temperature_2m_max?: (number | null)[] } }>(archiveUrl);
        const raw = archiveData.daily?.temperature_2m_max?.[0];
        if (raw != null) actualTemp = unit === "C" ? Math.round(raw * 10) / 10 : Math.round(raw);
      } catch (e) {
        console.error(`    [ARCHIVE] ${loc.name} ${dateStr}: ${e}`);
      }
      if (actualTemp == null) continue;
      await sleep(200);

      // 4. Find which bucket the actual temp falls into
      const matchedBucket = outcomes.find((o) => inBucket(actualTemp, o.range[0], o.range[1]));

      if (!matchedBucket) {
        // No bucket matched — not a tradeable situation, but note it
        trades.push({
          city: loc.name,
          date: dateStr,
          question: "(no matching bucket)",
          bucket_low: 0,
          bucket_high: 0,
          entry_price: 0,
          shares: 0,
          cost: 0,
          ev: 0,
          forecast_temp: actualTemp,
          actual_temp: actualTemp,
          resolved_yes: null,
          pnl: null,
          rejected: "no_bucket_match",
        });
        continue;
      }

      const [tLow, tHigh] = matchedBucket.range;
      const volume = matchedBucket.volume;
      const price = matchedBucket.price;

      // 5. Check if the market has resolved
      const resolvedYes = dateStr < today ? await checkMarketResolved(matchedBucket.market_id) : null;
      await sleep(200);

      // 6. Run strategy logic
      const sigma = getSigma(citySlug, "ecmwf");
      const p = bucketProb(actualTemp, tLow, tHigh, sigma);
      const ev = calcEv(p, price);
      const kelly = calcKelly(p, price);
      const size = betSize(kelly, 10000, MAX_BET);

      let rejected: string | null = null;
      if (volume < MIN_VOLUME) rejected = `low_volume_${volume}`;
      else if (ev < MIN_EV) rejected = `low_ev_${ev}`;
      else if (price >= MAX_PRICE) rejected = `high_price_${price}`;
      else if (size < 0.5) rejected = `small_size_${size}`;

      let pnl: number | null = null;
      if (resolvedYes === true) {
        pnl = Math.round(size * (1 - price) * 100) / 100;
        wins++;
      } else if (resolvedYes === false) {
        pnl = Math.round(-size * 100) / 100;
        losses++;
      } else if (resolvedYes === null && dateStr < today) {
        unresolved++;
      }

      if (resolvedYes != null) {
        entered++;
      }

      trades.push({
        city: loc.name,
        date: dateStr,
        question: matchedBucket.question.slice(0, 60),
        bucket_low: tLow,
        bucket_high: tHigh,
        entry_price: price,
        shares: size > 0 ? Math.round((size / price) * 100) / 100 : 0,
        cost: size,
        ev: Math.round(ev * 10000) / 10000,
        forecast_temp: actualTemp,
        actual_temp: actualTemp,
        resolved_yes: resolvedYes,
        pnl,
        rejected,
      });
    }

    console.log(`${trades.filter((t) => t.city === loc.name).length} markets`);
  }

  const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);

  return {
    total_markets: totalMarkets,
    trades_entered: entered,
    resolved_wins: wins,
    resolved_losses: losses,
    unresolved,
    total_pnl: totalPnl,
    win_rate: wins + losses > 0 ? `${(wins / (wins + losses) * 100).toFixed(1)}%` : "N/A",
    trades,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const daysIdx = args.indexOf("--days");
  const lookbackDays = daysIdx >= 0 && args[daysIdx + 1] ? Number(args[daysIdx + 1]) : 14;
  const minIdx = args.indexOf("--min");
  const lookbackMin = minIdx >= 0 && args[minIdx + 1] ? Number(args[minIdx + 1]) : 0;

  console.log(`\n${"=".repeat(55)}`);
  console.log("  BACKTEST — Walk through resolved markets");
  console.log(`${"=".repeat(55)}`);
  console.log(`  Lookback:     ${lookbackDays} days`);
  console.log(`  Balance:      $10,000 (fixed)`);
  console.log(`  Max bet:      $${MAX_BET}`);
  console.log(`  Min EV:       ${MIN_EV}`);
  console.log(`  Max price:    $${MAX_PRICE}`);
  console.log(`  Cities:       ${Object.keys(LOCATIONS).length}`);
  console.log(`  Data:         Open-Meteo Archive (ACTUAL temps = perfect forecast)`);
  console.log(`  ⚠️  This is an UPPER BOUND — real forecasts are less certain\n`);

  const result = await runBacktest({ lookbackDays });

  console.log(`\n${"-".repeat(55)}`);
  console.log("  RESULTS");
  console.log(`${"-".repeat(55)}`);
  console.log(`  Total markets scanned:    ${result.total_markets}`);
  console.log(`  Trades entered (resolved): ${result.trades_entered}`);
  console.log(`  Wins:                     ${result.resolved_wins}`);
  console.log(`  Losses:                   ${result.resolved_losses}`);
  console.log(`  Unresolved:               ${result.unresolved}`);
  console.log(`  Win rate:                 ${result.win_rate}`);
  console.log(`  Total PnL:                $${result.total_pnl.toFixed(2)}`);

  // Show rejected breakdown
  const rejectReasons: Record<string, number> = {};
  for (const t of result.trades) {
    if (t.rejected) rejectReasons[t.rejected] = (rejectReasons[t.rejected] ?? 0) + 1;
  }

  if (Object.keys(rejectReasons).length > 0) {
    console.log(`\n  Rejection reasons:`);
    for (const [reason, count] of Object.entries(rejectReasons).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${reason}: ${count}`);
    }
  }

  // Show recent trades
  const recentTrades = result.trades
    .filter((t) => t.pnl != null || t.rejected === null)
    .slice(0, 15);

  if (recentTrades.length > 0) {
    console.log(`\n  Sample trades (up to 15):`);
    for (const t of recentTrades) {
      const status = t.pnl != null ? `PnL $${t.pnl.toFixed(2)}` : (t.rejected ?? "?");
      const resolved = t.resolved_yes === true ? "✅" : t.resolved_yes === false ? "❌" : "⏳";
      console.log(`    ${resolved} ${t.city} ${t.date} | bucket ${t.bucket_low}-${t.bucket_high} | ${status}`);
    }
  }

  console.log(`\n  NOTE: This backtest uses ACTUAL weather as forecast proxy.`);
  console.log(`  For realistic results, configure WEATHERBOT_VC_KEY in .env`);
  console.log(`  (Visual Crossing API provides historical forecast data).\n`);
}

main().catch(console.error);
