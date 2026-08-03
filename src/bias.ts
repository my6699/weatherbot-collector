import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import {
  BIAS_ENABLED,
  BIAS_FORGET_N,
  BIAS_MAX_C,
  BIAS_MIN_N,
  BIAS_SHRINK_N,
  DATA_DIR,
  LOCATIONS,
} from "./config.js";
import type { MarketRecord } from "./storage.js";
import { metarMaxInUnit } from "./metar-archive.js";

/**
 * Horizon-aware rolling forecast-bias table.
 *
 * Key = `${city}|${horizon}|${source}` where source is one of
 *   "best"  -> the chosen best forecast (ensemble mean) stored in snapshots,
 *   "ecmwf" -> the ECMWF model value (already corrected in-model),
 *   "hrrr"  -> the GFS value.
 * Each entry holds the mean signed error (forecast - actual) in the location's
 * unit. Corrections are applied in scan.ts before bucket probability, and the
 * weekly LLM review (llm.ts) validates the table qualitatively.
 */

export interface BiasEntry {
  /** Mean signed error (forecast - actual) in the location's unit. */
  bias: number;
  n: number;
  updated_at: string;
}

export type BiasTable = Record<string, BiasEntry>;

export function biasKey(city: string, horizon: string, source: string): string {
  return `${city}|${horizon}|${source.toLowerCase()}`;
}

export function biasFilePath(): string {
  return path.join(DATA_DIR, "bias.json");
}

let tableCache: BiasTable | null = null;

export function loadBiasTable(): BiasTable {
  if (tableCache) return tableCache;
  const p = biasFilePath();
  if (existsSync(p)) {
    try {
      tableCache = JSON.parse(readFileSync(p, "utf-8")) as BiasTable;
      return tableCache;
    } catch {
      tableCache = {};
      return tableCache;
    }
  }
  tableCache = {};
  return tableCache;
}

/** Recompute the table from resolved markets (rolling window) and persist it. */
export function refreshBias(markets: MarketRecord[]): BiasTable {
  if (!BIAS_ENABLED) return loadBiasTable();
  const resolved = markets
    .filter((m) => m.status === "resolved" && m.actual_temp != null)
    .sort((a, b) => a.date.localeCompare(b.date));

  const series: Record<string, number[]> = {};
  for (const m of resolved) {
    // Prefer the TRUE station daily max (METAR archive, settlement source)
    // over the bucket midpoint; falls back when the archive has no data.
    const actual = metarMaxInUnit(m.station, m.date, m.unit) ?? m.actual_temp;
    if (actual == null) continue;
    for (const snap of m.forecast_snapshots ?? []) {
      const horizon = snap.horizon ?? "D+0";
      const samples: [string, number | null | undefined][] = [
        ["best", snap.best],
        ["ecmwf", snap.ecmwf],
        ["hrrr", snap.hrrr],
      ];
      for (const [src, v] of samples) {
        if (v == null) continue;
        const key = biasKey(m.city, horizon, src);
        const arr = series[key] ?? (series[key] = []);
        arr.push(v - actual);
        if (arr.length > BIAS_FORGET_N) arr.shift();
      }
    }
  }

  const table: BiasTable = {};
  const now = new Date().toISOString();
  for (const [key, arr] of Object.entries(series)) {
    if (arr.length < BIAS_MIN_N) continue;
    const bias = arr.reduce((a, b) => a + b, 0) / arr.length;
    table[key] = {
      bias: Math.round(bias * 1000) / 1000,
      n: arr.length,
      updated_at: now,
    };
  }
  tableCache = table;
  writeFileSync(biasFilePath(), JSON.stringify(table, null, 2), "utf-8");
  return table;
}

/** Unit-aware magnitude cap (°C; F locations ×1.8). */
function capFor(city: string): number {
  const unit = LOCATIONS[city]?.unit;
  return unit === "F" ? BIAS_MAX_C * 1.8 : BIAS_MAX_C;
}

/**
 * Effective bias (signed, forecast - actual) for (city, horizon, source).
 * Returns 0 when disabled or not enough samples. Shrinks toward 0 below
 * BIAS_SHRINK_N samples so a single outlier market cannot dominate.
 */
export function getBias(city: string, horizon: string, source: string): number {
  if (!BIAS_ENABLED) return 0;
  const entry = loadBiasTable()[biasKey(city, horizon, source)];
  if (!entry || entry.n < BIAS_MIN_N) return 0;
  const shrink = Math.min(1, entry.n / BIAS_SHRINK_N);
  const cap = capFor(city);
  const capped = Math.max(-cap, Math.min(cap, entry.bias));
  return Math.round(capped * shrink * 1000) / 1000;
}

/** Apply the correction: forecast - bias (0 when no correction applies).
 *  bias = mean(forecast - actual), so subtracting it pulls the forecast toward
 *  the actual. (Previously `forecast + bias` here pushed the forecast in the
 *  WRONG direction — config.ts recorded avg error 1.76° -> 3.01° when enabled,
 *  which is the signature of this sign error.) */
export function applyBias(
  forecast: number,
  city: string,
  horizon: string,
  source: string,
): number {
  const b = getBias(city, horizon, source);
  return b === 0 ? forecast : Math.round((forecast - b) * 100) / 100;
}
