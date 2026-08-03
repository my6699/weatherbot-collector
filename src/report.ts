import { LOCATIONS } from "./config.js";
import { loadAllMarkets, loadState } from "./storage.js";
import { inBucket } from "./math.js";

export function printStatus(): void {
  const state = loadState();
  const markets = loadAllMarkets();
  const openPos = markets.filter((m) => m.position?.status === "open");
  const resolved = markets.filter((m) => m.status === "resolved" && m.pnl != null);

  const bal = state.balance;
  const start = state.starting_balance;
  const retPct = ((bal - start) / start) * 100;
  const wins = state.wins;
  const losses = state.losses;
  const total = wins + losses;

  console.log(`\n${"=".repeat(55)}`);
  console.log("  WEATHERBET — STATUS");
  console.log(`${"=".repeat(55)}`);
  console.log(
    `  Balance:     $${bal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}  (start $${start.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}, ${retPct >= 0 ? "+" : ""}${retPct.toFixed(1)}%)`,
  );
  if (total)
    console.log(`  Trades:      ${total} | W: ${wins} | L: ${losses} | WR: ${((wins / total) * 100).toFixed(0)}%`);
  else console.log("  No trades yet");
  console.log(`  Open:        ${openPos.length}`);
  console.log(`  Resolved:    ${resolved.length}`);

  if (openPos.length) {
    console.log("\n  Open positions:");
    let totalUnrealized = 0.0;
    for (const m of openPos) {
      const pos = m.position!;
      const unitSym = m.unit === "F" ? "F" : "C";
      const label = `${pos.bucket_low}-${pos.bucket_high}${unitSym}`;

      let currentPrice = pos.entry_price;
      for (const o of m.all_outcomes ?? []) {
        if (o.market_id === pos.market_id) {
          currentPrice = o.price;
          break;
        }
      }

      const unrealized = Math.round((currentPrice - pos.entry_price) * pos.shares * 100) / 100;
      totalUnrealized += unrealized;
      const pnlStr = `${unrealized >= 0 ? "+" : ""}${unrealized.toFixed(2)}`;

      console.log(
        `    ${m.city_name.padEnd(16, " ")} ${m.date} | ${label.padEnd(14, " ")} | ` +
          `entry $${pos.entry_price.toFixed(3)} -> $${currentPrice.toFixed(3)} | ` +
          `PnL: ${pnlStr} | ${(pos.forecast_src ?? "").toUpperCase()}`,
      );
    }
    console.log(`\n  Unrealized PnL: ${totalUnrealized >= 0 ? "+" : ""}${totalUnrealized.toFixed(2)}`);
  }

  console.log(`${"=".repeat(55)}\n`);
}

export function printReport(): void {
  const markets = loadAllMarkets();
  // A market counts as "settled" for reporting once we have the true actual_temp —
  // this includes markets closed early (stop / forecast_change / metarDiverged)
  // whose market-level pnl is null but whose positions still resolved against
  // the actual. (2026-08-03 audit)
  const resolved = markets.filter((m) => m.actual_temp != null);

  console.log(`\n${"=".repeat(55)}`);
  console.log("  WEATHERBET — FULL REPORT");
  console.log(`${"=".repeat(55)}`);

  if (!resolved.length) {
    console.log("  No resolved markets yet.");
    return;
  }

  // PnL lives on positions (early-closed markets have null market-level pnl), so
  // sum across all positions on settled markets for the true realized PnL.
  let totalPnl = 0;
  for (const m of resolved) {
    const positions = m.positions ?? (m.position ? [m.position] : []);
    for (const p of positions) totalPnl += p.pnl ?? 0;
  }

  // Position-level hit rate (true prediction accuracy, 2026-08-03 audit): a market
  // may hold several buckets; judge each position by actual_temp. This replaces
  // resolved_outcome (market-level, null for markets closed early via stop/forecast-
  // change) which under-counted wins and overstated losses.
  let posWins = 0;
  let posLosses = 0;
  for (const m of resolved) {
    if (m.actual_temp == null) continue;
    const positions = m.positions ?? (m.position ? [m.position] : []);
    for (const p of positions) {
      if (p.bucket_low == null || p.bucket_high == null) continue;
      if (inBucket(m.actual_temp, p.bucket_low, p.bucket_high)) posWins += 1;
      else posLosses += 1;
    }
  }
  const posTotal = posWins + posLosses;

  console.log(`\n  Total resolved markets: ${resolved.length}`);
  if (posTotal) {
    console.log(
      `  Position hits:  ${posWins} / ${posTotal}  (hit rate ${((posWins / posTotal) * 100).toFixed(1)}%)`,
    );
  } else {
    console.log("  No settled positions with actual_temp yet.");
  }
  console.log(`  Total PnL:      ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}`);

  console.log("\n  By city:");
  const citySet = [...new Set(resolved.map((m) => m.city))].sort();
  for (const city of citySet) {
    const group = resolved.filter((m) => m.city === city);
    let w = 0;
    let n = 0;
    let pnl = 0;
    for (const m of group) {
      const positions = m.positions ?? (m.position ? [m.position] : []);
      for (const p of positions) {
        if (m.actual_temp != null && p.bucket_low != null && p.bucket_high != null) {
          if (inBucket(m.actual_temp, p.bucket_low, p.bucket_high)) w += 1;
          n += 1;
        }
        pnl += p.pnl ?? 0;
      }
    }
    const name = LOCATIONS[city]?.name ?? city;
    console.log(
      `    ${name.padEnd(16, " ")} ${w}/${n} (${n ? ((w / n) * 100).toFixed(0) : 0}%)  PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
    );
  }

  console.log("\n  Market details:");
  const sorted = [...resolved].sort((a, b) => a.date.localeCompare(b.date));
  for (const m of sorted) {
    const pos = m.position ?? ({} as { bucket_low?: number; bucket_high?: number });
    const unitSym = m.unit === "F" ? "F" : "C";
    const snaps = m.forecast_snapshots ?? [];
    const firstFc = snaps[0]?.best ?? null;
    const lastFc = snaps.length ? snaps[snaps.length - 1]?.best ?? null : null;
    const label =
      pos.bucket_low != null && pos.bucket_high != null
        ? `${pos.bucket_low}-${pos.bucket_high}${unitSym}`
        : "no position";
    const result = (m.resolved_outcome ?? "").toUpperCase();
    const pnlStr = m.pnl != null ? `${m.pnl >= 0 ? "+" : ""}${m.pnl.toFixed(2)}` : "-";
    const fcStr =
      firstFc != null ? `forecast ${firstFc}->${lastFc}${unitSym}` : "no forecast";
    const actual =
      m.actual_temp != null ? `actual ${m.actual_temp}${unitSym}` : "";
    console.log(
      `    ${m.city_name.padEnd(16, " ")} ${m.date} | ${label.padEnd(14, " ")} | ${fcStr} | ${actual} | ${result} ${pnlStr}`,
    );
  }

  console.log(`${"=".repeat(55)}\n`);
}
