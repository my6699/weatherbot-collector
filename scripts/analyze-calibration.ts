/**
 * Calibration analysis: measure per-source forecast error against settled actual temps.
 * Usage: npm run analyze:calibration
 * Reads data/markets/*.json, prints per-market errors and per-source MAE/RMSE/bias.
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import path from "path";

interface Snap {
  ts?: string;
  hours_left?: number;
  ecmwf?: number | null;
  hrrr?: number | null;
  metar?: number | null;
  best?: number | null;
  best_source?: string | null;
  ens?: {
    models?: Record<string, number>;
    mean?: number;
    spread?: number;
    gap?: number;
  } | null;
}

interface Market {
  city_name: string;
  date: string;
  unit: string;
  status: string;
  actual_temp: number | null;
  forecast_snapshots: Snap[];
  position?: { forecast_src: string | null; bucket_low: number; bucket_high: number } | null;
}

const dir = path.join(process.cwd(), "data", "markets");

function lastVal(snaps: Snap[], src: "ecmwf" | "hrrr" | "metar"): number | null {
  for (let i = snaps.length - 1; i >= 0; i--) {
    const v = snaps[i]?.[src];
    if (v != null) return v;
  }
  return null;
}

function errorsFor(m: Market, src: "ecmwf" | "hrrr" | "metar"): { err: number; signed: number } | null {
  if (m.actual_temp == null) return null;
  const f = lastVal(m.forecast_snapshots, src);
  if (f == null) return null;
  return { err: Math.abs(f - m.actual_temp), signed: f - m.actual_temp };
}

function lastEnsMean(snaps: Snap[]): number | null {
  for (let i = snaps.length - 1; i >= 0; i--) {
    const mean = snaps[i]?.ens?.mean;
    if (mean != null) return mean;
  }
  return null;
}

const srcs = ["ecmwf", "hrrr", "metar"] as const;

function analyze() {
  if (!existsSync(dir)) {
    console.log(`no data dir: ${dir}`);
    return;
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const resolved: Market[] = [];
  for (const f of files) {
    try {
      const m = JSON.parse(readFileSync(path.join(dir, f), "utf-8")) as Market;
      if (m.status === "resolved" && m.actual_temp != null) resolved.push(m);
    } catch {
      /* skip */
    }
  }

  console.log(`\n=== Resolved markets with actual temp: ${resolved.length} ===\n`);
  for (const m of resolved.sort((a, b) => a.date.localeCompare(b.date))) {
    const row = [`${m.city_name} ${m.date}`, `actual ${m.actual_temp}${m.unit}`];
    for (const s of srcs) {
      const e = errorsFor(m, s);
      row.push(`${s}: ${e ? `${e.signed >= 0 ? "+" : ""}${e.signed.toFixed(1)}°` : "-"}`);
    }
    const best = m.forecast_snapshots[m.forecast_snapshots.length - 1];
    row.push(`best: ${best?.best != null ? best.best : "-"}(${best?.best_source ?? "-"})`);
    console.log(row.join(" | "));
  }

  console.log("\n=== Per-source error stats (all resolved, last snapshot) ===");
  console.log(
    "src     | n  | MAE   | RMSE  | bias(mean signed) | maxErr",
  );
  for (const s of srcs) {
    const es = resolved
      .map((m) => errorsFor(m, s))
      .filter((e): e is { err: number; signed: number } => e != null);
    if (!es.length) continue;
    const n = es.length;
    const mae = es.reduce((a, e) => a + e.err, 0) / n;
    const rmse = Math.sqrt(es.reduce((a, e) => a + e.err * e.err, 0) / n);
    const bias = es.reduce((a, e) => a + e.signed, 0) / n;
    const maxErr = Math.max(...es.map((e) => e.err));
    console.log(
      `${s.padEnd(8)} | ${n} | ${mae.toFixed(2)} | ${rmse.toFixed(2)} | ${(bias >= 0 ? "+" : "")}${bias.toFixed(2)}          | ${maxErr.toFixed(1)}`,
    );
  }

  // Best-source stats
  const bestEs = resolved
    .map((m) => {
      if (m.actual_temp == null) return null;
      const b = m.forecast_snapshots[m.forecast_snapshots.length - 1]?.best;
      if (b == null) return null;
      return { err: Math.abs(b - m.actual_temp), signed: b - m.actual_temp };
    })
    .filter((e): e is { err: number; signed: number } => e != null);
  if (bestEs.length) {
    const n = bestEs.length;
    const mae = bestEs.reduce((a, e) => a + e.err, 0) / n;
    const rmse = Math.sqrt(bestEs.reduce((a, e) => a + e.err * e.err, 0) / n);
    const bias = bestEs.reduce((a, e) => a + e.signed, 0) / n;
    console.log(`best    | ${n} | ${mae.toFixed(2)} | ${rmse.toFixed(2)} | ${(bias >= 0 ? "+" : "")}${bias.toFixed(2)}          | ${Math.max(...bestEs.map((e) => e.err)).toFixed(1)}`);
  }

  // Ensemble mean stats (weighted ECMWF+GFS+ICON blend)
  const ensEs = resolved
    .map((m) => {
      if (m.actual_temp == null) return null;
      const mean = lastEnsMean(m.forecast_snapshots);
      if (mean == null) return null;
      return { err: Math.abs(mean - m.actual_temp), signed: mean - m.actual_temp };
    })
    .filter((e): e is { err: number; signed: number } => e != null);
  if (ensEs.length) {
    const n = ensEs.length;
    const mae = ensEs.reduce((a, e) => a + e.err, 0) / n;
    const rmse = Math.sqrt(ensEs.reduce((a, e) => a + e.err * e.err, 0) / n);
    const bias = ensEs.reduce((a, e) => a + e.signed, 0) / n;
    console.log(`ensmean | ${n} | ${mae.toFixed(2)} | ${rmse.toFixed(2)} | ${(bias >= 0 ? "+" : "")}${bias.toFixed(2)}          | ${Math.max(...ensEs.map((e) => e.err)).toFixed(1)}`);
  }

  // Ensemble disagreement summary (avg spread / gap of the last snapshot per market)
  const dis = resolved
    .map((m) => {
      const last = m.forecast_snapshots[m.forecast_snapshots.length - 1]?.ens;
      return last ? { spread: last.spread ?? 0, gap: last.gap ?? 0 } : null;
    })
    .filter((e): e is { spread: number; gap: number } => e != null);
  if (dis.length) {
    const avg = (k: "spread" | "gap") => dis.reduce((a, d) => a + d[k], 0) / dis.length;
    console.log(`\n=== Ensemble disagreement (last snapshot) ===`);
    console.log(`  n=${dis.length} | avg spread ${avg("spread").toFixed(2)}° | avg ECMWF-vs-GFS gap ${avg("gap").toFixed(2)}°`);
    console.log(`  (when gap exceeds ~1C/2F, the bot skips the trade — consensus gate)`);
  }

  // Suggested sigma (RMSE as sigma) vs current defaults
  console.log("\n=== Suggested sigma (RMSE as sigma, else current defaults) ===");
  console.log(`SIGMA_F default = 1.7 | SIGMA_C default = 2.3`);
}

analyze();
