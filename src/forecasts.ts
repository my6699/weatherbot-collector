import {
  ECMWF_BIAS_C,
  ECMWF_BIAS_F,
  ENSEMBLE_MODELS,
  ENSEMBLE_WEIGHTS,
  TIMEZONES,
  type LocationInfo,
} from "./config.js";
import { fetchJson, sleep } from "./http.js";
import { getBias } from "./bias.js";

interface OpenMeteoDaily {
  daily?: Record<string, unknown> & { time?: string[] };
  error?: boolean | string;
}

/** One day's ensemble forecast for a city. */
export interface EnsembleForecast {
  /** Per-model daily max temp in the location unit (ecmwf already bias-corrected). */
  models: Record<string, number>;
  /** Weighted ensemble mean (our best estimate). */
  mean: number;
  /** Max absolute deviation of any model from the mean (forecast uncertainty). */
  spread: number;
  /** |ecmwf - gfs| model disagreement in the location unit. */
  gap: number;
}

export async function getEnsembleForecast(
  citySlug: string,
  dates: Set<string>,
  loc: LocationInfo,
): Promise<Record<string, EnsembleForecast>> {
  const unit = loc.unit;
  const tempUnit = unit === "F" ? "fahrenheit" : "celsius";
  const result: Record<string, EnsembleForecast> = {};
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&daily=temperature_2m_max&temperature_unit=${tempUnit}` +
    `&forecast_days=7&timezone=${encodeURIComponent(TIMEZONES[citySlug] ?? "UTC")}` +
    `&models=${ENSEMBLE_MODELS.join(",")}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await fetchJson<OpenMeteoDaily>(url);
      const daily = data.daily;
      if (!data.error && daily?.time) {
        const times = daily.time;
        // Pull each model's series, bias-correct ECMWF (horizon-aware rolling
        // bias via getBias — D+1 daily-max errors run far larger than D+0).
        const series: Record<string, (number | null)[]> = {};
        for (const model of ENSEMBLE_MODELS) {
          const raw = daily[`temperature_2m_max_${model}`];
          if (Array.isArray(raw)) series[model] = raw as (number | null)[];
        }
        const models = Object.keys(series);
        if (models.length === 0) break;

        const datesArr = Array.from(dates);
        const horizonFor = (d: string): string => {
          const idx = datesArr.indexOf(d);
          return idx >= 0 ? `D+${idx}` : "D+0";
        };
        for (let i = 0; i < times.length; i++) {
          const date = times[i];
          if (!date || !dates.has(date)) continue;
          const calBias = getBias(citySlug, horizonFor(date), "ecmwf"); // signed error (forecast - actual)
          const ecmwfBias =
            calBias !== 0 ? -calBias : unit === "C" ? ECMWF_BIAS_C : ECMWF_BIAS_F;
          const modelTemps: Record<string, number> = {};
          for (const model of models) {
            const v = series[model]?.[i];
            if (v == null) continue;
            let t = Number(v);
            if (model === "ecmwf_ifs025") t += ecmwfBias;
            modelTemps[model] = unit === "C" ? Math.round(t * 10) / 10 : Math.round(t);
          }
          if (Object.keys(modelTemps).length === 0) continue;
          // Weighted mean.
          let wsum = 0;
          let msum = 0;
          for (const [model, t] of Object.entries(modelTemps)) {
            const w = ENSEMBLE_WEIGHTS[model] ?? 0;
            if (w <= 0) continue;
            wsum += w;
            msum += w * t;
          }
          if (wsum <= 0) continue;
          const mean = msum / wsum;
          let spread = 0;
          for (const t of Object.values(modelTemps)) {
            spread = Math.max(spread, Math.abs(t - mean));
          }
          const ecmwf = modelTemps.ecmwf_ifs025;
          const gfs = modelTemps.gfs_seamless;
          const gap = ecmwf != null && gfs != null ? Math.abs(ecmwf - gfs) : 0;
          result[date] = {
            models: modelTemps,
            mean: Math.round(mean * 10) / 10,
            spread: Math.round(spread * 10) / 10,
            gap: Math.round(gap * 10) / 10,
          };
        }
      }
      break;
    } catch (e) {
      if (attempt < 2) await sleep(3000);
      else console.error(`  [ENSEMBLE] ${citySlug}:`, e);
    }
  }
  return result;
}

interface MetarRow {
  temp?: number | string | null;
}

export async function getMetar(citySlug: string, loc: LocationInfo): Promise<number | null> {
  const station = loc.station;
  const unit = loc.unit;
  try {
    const url = `https://aviationweather.gov/api/data/metar?ids=${station}&format=json`;
    const data = await fetchJson<MetarRow[]>(url);
    if (data && Array.isArray(data)) {
      const tempC = data[0]?.temp;
      if (tempC != null) {
        if (unit === "F") return Math.round(Number(tempC) * (9 / 5) + 32);
        return Math.round(Number(tempC) * 10) / 10;
      }
    }
  } catch (e) {
    console.error(`  [METAR] ${citySlug}:`, e);
  }
  return null;
}

