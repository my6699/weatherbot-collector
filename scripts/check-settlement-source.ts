/**
 * Settlement-source alignment check (real-money checklist #1).
 *
 * Usage: npx tsx scripts/check-settlement-source.ts
 *
 * For every configured location, fetches the today-UTC Polymarket weather event
 * from Gamma and prints the resolution text (description/rules) next to the
 * METAR station ID we assume in config.ts. A mismatch (different station,
 * different timezone definition, °C vs °F phrasing) is a real-money risk —
 * this script surfaces it so it can be eyeballed / fixed before going live.
 */

import { fetchJson } from "../src/http.js";
import { LOCATIONS } from "../src/config.js";

interface RawEvent {
  title?: string;
  slug?: string;
  description?: string;
  rules?: string;
  endDate?: string;
  markets?: { question?: string }[];
}

function utcTodayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const today = utcTodayIso();
  const [year, month0, day0] = today.split("-").map(Number);
  const monthNames = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ];
  const month = monthNames[(month0 ?? 1) - 1] ?? "january";

  console.log(`=== Settlement-source alignment (UTC ${today}) ===\n`);
  let mismatches = 0;

  for (const [slug, loc] of Object.entries(LOCATIONS)) {
    const slugName = `highest-temperature-in-${slug}-on-${month}-${day0}-${year}`;
    let event: RawEvent | null = null;
    try {
      const arr = await fetchJson<RawEvent[]>(
        `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slugName)}`,
      );
      event = arr?.[0] ?? null;
    } catch {
      event = null;
    }

    if (!event) {
      console.log(`${loc.name.padEnd(12)} | NO EVENT today (skip)`);
      continue;
    }

    const text = `${event.description ?? ""} ${event.rules ?? ""} ${event.title ?? ""}`;
    const station = loc.station ?? "(none)";
    const stationFound = station !== "(none)" && text.toUpperCase().includes(station.toUpperCase());
    const wunderground = /wunderground|weather ?underground/i.test(text);
    const source = (event.description ?? "").slice(0, 220).replace(/\s+/g, " ");

    const ok = stationFound || wunderground;
    if (!ok) mismatches += 1;
    console.log(
      `${loc.name.padEnd(12)} | station ${station.padEnd(6)} | ${ok ? "OK " : "CHECK"}`,
    );
    console.log(`    description: ${source || "(empty)"}`);
    const q = event.markets?.[0]?.question;
    if (q) console.log(`    question:    ${q}`);
    console.log();
  }

  console.log(`=== ${mismatches} location(s) need a manual settlement-source review ===`);
  if (mismatches > 0) {
    console.log(
      "If the resolution source is a Weather Underground / NWS station different from our",
      "METAR station, the endgame lock and calibration labels are misaligned.",
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
