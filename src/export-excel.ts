import { renameSync, unlinkSync, existsSync } from "fs";
import path from "path";
import * as XLSX from "xlsx";
import { DATA_DIR, LOCATIONS } from "./config.js";
import { allPositions, loadAllMarkets, type MarketRecord } from "./storage.js";

/**
 * Export all collected market data into a single Excel workbook (data/weatherbot_data.xlsx).
 * Each sheet aggregates a different aspect of the collected data.
 */

interface MarketSummary {
  City: string;
  Date: string;
  Status: string;
  "End (UTC)": string;
  "Actual Temp": number | string;
  "METAR Max": number | string;
  Result: string;
  PnL: number | string;
  "Forecast Snaps": number;
  "Price Snaps": number;
  Position: string;
  "Open Positions": number;
  "Position PnL": number | string;
  "Best Forecast": number | string;
  "Best Source": string;
  "Top Bucket": string;
  "Top Price": number | string;
}

interface ForecastRow {
  Ts: string;
  City: string;
  Date: string;
  Horizon: string;
  "Hours Left": number | string;
  ECMWF: number | string;
  GFS: number | string;
  ICON: number | string;
  METAR: number | string;
  Best: number | string;
  "Best Source": string;
  "Ens Mean": number | string;
  "Ens Spread": number | string;
  "Ens Gap": number | string;
}

interface OutcomeRowExport {
  Ts: string;
  City: string;
  Date: string;
  Bucket: string;
  MarketID: string;
  Bid: number;
  Ask: number;
  Price: number;
  Spread: number;
  Volume: number;
}

interface PositionExport {
  City: string;
  Date: string;
  MarketID: string;
  Question: string;
  Bucket: string;
  "Entry Price": number;
  "Bid at Entry": number;
  Spread: number;
  Shares: number;
  Cost: number;
  P: number;
  EV: number;
  Kelly: number;
  Sigma: number | string;
  Strategy: string;
  "Forecast Temp": number;
  "Forecast Source": string;
  Status: string;
  "Open At": string;
  "Close At": string;
  "Close Reason": string;
  "Exit Price": number | string;
  PnL: number | string;
}

export function exportAllToExcel(): string {
  const markets = loadAllMarkets();
  const summaries: MarketSummary[] = [];
  const forecasts: ForecastRow[] = [];
  const outcomes: OutcomeRowExport[] = [];
  const positions: PositionExport[] = [];

  for (const m of markets) {
    const loc = LOCATIONS[m.city];
    const unit = m.unit === "F" ? "F" : "C";
    const latestSnap = m.forecast_snapshots[m.forecast_snapshots.length - 1];

    summaries.push({
      City: m.city_name,
      Date: m.date,
      Status: m.status,
      "End (UTC)": m.event_end_date,
      "Actual Temp": m.actual_temp ?? "",
      "METAR Max": m.metar_max ?? "",
      Result: m.resolved_outcome ?? "",
      PnL: m.pnl ?? "",
      "Forecast Snaps": m.forecast_snapshots.length,
      "Price Snaps": m.market_snapshots.length,
      Position: m.position ? `${m.position.bucket_low}-${m.position.bucket_high}${unit}@${m.position.entry_price}` : "",
      "Open Positions": allPositions(m).filter((p) => p.status === "open").length,
      "Position PnL": m.position?.pnl ?? "",
      "Best Forecast": latestSnap?.best ?? "",
      "Best Source": latestSnap?.best_source ?? "",
      "Top Bucket": m.market_snapshots[m.market_snapshots.length - 1]?.top_bucket ?? "",
      "Top Price": m.market_snapshots[m.market_snapshots.length - 1]?.top_price ?? "",
    });

    for (const f of m.forecast_snapshots) {
      forecasts.push({
        Ts: f.ts ?? "",
        City: m.city_name,
        Date: m.date,
        Horizon: f.horizon ?? "",
        "Hours Left": f.hours_left ?? "",
        ECMWF: f.ecmwf ?? "",
        GFS: f.hrrr ?? "",
        ICON: f.ens?.models.icon_seamless ?? "",
        METAR: f.metar ?? "",
        Best: f.best ?? "",
        "Best Source": f.best_source ?? "",
        "Ens Mean": f.ens?.mean ?? "",
        "Ens Spread": f.ens?.spread ?? "",
        "Ens Gap": f.ens?.gap ?? "",
      });
    }

    const lastOutcomeTs = m.market_snapshots[m.market_snapshots.length - 1]?.ts ?? "";
    for (const o of m.all_outcomes) {
      const [lo, hi] = o.range;
      outcomes.push({
        Ts: lastOutcomeTs,
        City: m.city_name,
        Date: m.date,
        Bucket: lo === -999 ? `<=${hi}${unit}` : hi === 999 ? `>=${lo}${unit}` : `${lo}-${hi}${unit}`,
        MarketID: o.market_id,
        Bid: o.bid,
        Ask: o.ask,
        Price: o.price,
        Spread: o.spread,
        Volume: o.volume,
      });
    }

    for (const pos of allPositions(m)) {
      positions.push({
        City: m.city_name,
        Date: m.date,
        MarketID: pos.market_id,
        Question: pos.question,
        Bucket: `${pos.bucket_low}-${pos.bucket_high}${unit}`,
        "Entry Price": pos.entry_price,
        "Bid at Entry": pos.bid_at_entry,
        Spread: pos.spread,
        Shares: pos.shares,
        Cost: pos.cost,
        P: pos.p,
        EV: pos.ev,
        Kelly: pos.kelly,
        Sigma: pos.sigma ?? "",
        Strategy: pos.strategy ?? "ensemble",
        "Forecast Temp": pos.forecast_temp,
        "Forecast Source": pos.forecast_src ?? "",
        Status: pos.status,
        "Open At": pos.opened_at ?? "",
        "Close At": pos.closed_at ?? "",
        "Close Reason": pos.close_reason ?? "",
        "Exit Price": pos.exit_price ?? "",
        PnL: pos.pnl ?? "",
      });
    }
  }

  // Sort summaries by date
  summaries.sort((a, b) => a.Date.localeCompare(b.Date) || a.City.localeCompare(b.City));
  forecasts.sort((a, b) => a.Ts.localeCompare(b.Ts) || a.City.localeCompare(b.City));
  outcomes.sort((a, b) => a.Ts.localeCompare(b.Ts) || a.City.localeCompare(b.City));
  positions.sort((a, b) => (a["Open At"]).localeCompare(b["Open At"]));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaries), "Market Summary");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(forecasts), "Forecasts");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(outcomes), "Prices (buckets)");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(positions), "Positions");

  const outPath = path.join(DATA_DIR, "weatherbot_data.xlsx");
  const tmpPath = path.join(DATA_DIR, "weatherbot_data.xlsx.tmp");

  // Write to temp file first, then atomically replace the main file.
  // If the main file is locked (e.g. open in Excel), fall back to a timestamped copy.
  XLSX.writeFile(wb, tmpPath, { bookType: "xlsx" });
  try {
    if (existsSync(outPath)) unlinkSync(outPath);
    renameSync(tmpPath, outPath);
    return outPath;
  } catch (e) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const altPath = path.join(DATA_DIR, `weatherbot_data_${ts}.xlsx`);
    renameSync(tmpPath, altPath);
    return altPath;
  }
}
