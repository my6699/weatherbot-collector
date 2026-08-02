import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { DATA_DIR, LOCATIONS, METAR_ARCHIVE_HOURS } from "./config.js";
import { fetchJson, sleep } from "./http.js";

/**
 * METAR hourly archive (aviationweather.gov, free).
 *
 * Stores the per-station per-LOCAL-calendar-day TRUE daily max temperature (°C)
 * computed from the official hourly METAR observations — the same feed and the
 * same day definition Polymarket uses for settlement (verified: Seattle
 * 2026-08-01 settled at 70.5°F, matching the local-day max, not the UTC-day max
 * of 82°F). The local offset is estimated from the station's longitude
 * (same approximation as localHourFor). Consumers convert °C -> the location's
 * unit via LOCATIONS. Each station is fetched at most once per day.
 */

export type MetarMaxTable = Record<string, Record<string, number>>;

interface MetarRow {
  icaoId?: string;
  reportTime?: string;
  temp?: number;
}

/** Station -> estimated UTC offset (hours), from LOCATIONS longitude. */
function stationOffsetMap(): Record<string, number> {
  const map: Record<string, number> = {};
  for (const loc of Object.values(LOCATIONS)) {
    if (loc.station && loc.lon != null) map[loc.station] = Math.round(loc.lon / 15);
  }
  return map;
}

function localDateOf(reportTime: string, offsetH: number): string {
  const t = new Date(reportTime).getTime();
  if (Number.isNaN(t)) return reportTime.slice(0, 10);
  return new Date(t + offsetH * 3600e3).toISOString().slice(0, 10);
}

export function metarMaxFilePath(): string {
  return path.join(DATA_DIR, "metar_max.json");
}

let cache: MetarMaxTable | null = null;

export function loadMetarMaxes(): MetarMaxTable {
  if (cache) return cache;
  const p = metarMaxFilePath();
  if (existsSync(p)) {
    try {
      cache = JSON.parse(readFileSync(p, "utf-8")) as MetarMaxTable;
      return cache;
    } catch {
      cache = {};
      return cache;
    }
  }
  cache = {};
  return cache;
}

async function fetchStationMaxes(station: string): Promise<Record<string, number>> {
  const url = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(station)}&format=json&hours=${METAR_ARCHIVE_HOURS}`;
  const rows = (await fetchJson(url)) as MetarRow[] | null;
  if (!Array.isArray(rows)) return {};
  const offsetH = stationOffsetMap()[station] ?? 0;
  const byDate: Record<string, number> = {};
  for (const r of rows) {
    if (r.temp == null) continue;
    const date = r.reportTime ? localDateOf(r.reportTime, offsetH) : undefined;
    if (!date) continue;
    byDate[date] = byDate[date] === undefined ? r.temp : Math.max(byDate[date], r.temp);
  }
  return byDate;
}

/** Refresh stations not updated today; persist and return the table. */
export async function refreshMetarMaxes(): Promise<MetarMaxTable> {
  const table = loadMetarMaxes();
  const today = new Date().toISOString().slice(0, 10);
  const updated = (table as unknown as { _updated?: Record<string, string> })._updated ?? {};
  const needs: string[] = [];
  for (const loc of Object.values(LOCATIONS)) {
    if (!loc.station) continue;
    if (updated[loc.station] !== today) needs.push(loc.station);
  }
  if (needs.length > 0) {
    console.log(`  [METAR ARCHIVE] refreshing ${needs.length} station(s) (daily guard)`);
    for (const st of needs) {
      try {
        const byDate = await fetchStationMaxes(st);
        for (const [d, v] of Object.entries(byDate)) {
          (table[st] ??= {})[d] = v;
        }
        updated[st] = today;
      } catch (e) {
        console.log(`  [METAR ARCHIVE] ${st} failed: ${(e as Error).message}`);
      }
      await sleep(120);
    }
  }
  (table as unknown as { _updated?: Record<string, string> })._updated = updated;
  cache = table;
  writeFileSync(metarMaxFilePath(), JSON.stringify(table, null, 2), "utf-8");
  return table;
}

/** True station daily max (°C) for a UTC date, or null when unavailable. */
export function metarMaxFor(station: string, date: string): number | null {
  const v = loadMetarMaxes()[station]?.[date];
  return v ?? null;
}

/** Convert the °C archive value into the location's unit (C stays, F = C*9/5+32). */
export function metarMaxInUnit(station: string, date: string, unit: "F" | "C"): number | null {
  const c = metarMaxFor(station, date);
  if (c == null) return null;
  const v = unit === "F" ? (c * 9) / 5 + 32 : c;
  return Math.round(v * 10) / 10;
}
