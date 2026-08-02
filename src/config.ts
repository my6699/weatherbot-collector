import "dotenv/config";
import { mkdirSync } from "fs";
import path from "path";

export type Region = "us" | "eu" | "asia" | "ca" | "sa" | "oc";

export interface LocationInfo {
  lat: number;
  lon: number;
  name: string;
  station: string;
  unit: "F" | "C";
  region: Region;
}

function envNum(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw == null || raw === "") return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaultValue;
}

function envStr(key: string, defaultValue: string): string {
  const raw = process.env[key];
  return raw != null && raw !== "" ? raw : defaultValue;
}

function envTruthy(key: string): boolean {
  const raw = process.env[key];
  if (raw == null || raw === "") return false;
  const l = raw.toLowerCase();
  return raw === "1" || l === "true" || l === "yes";
}

const P = "WEATHERBOT_" as const;

export const BALANCE = envNum(`${P}BALANCE`, 10000.0);
export const MAX_BET = envNum(`${P}MAX_BET`, 20.0);
/** Max concurrent open positions per city/date market (bucket spread). */
export const MAX_POSITIONS_PER_MARKET = envNum(`${P}MAX_POSITIONS_PER_MARKET`, 3);
export const MIN_EV = envNum(`${P}MIN_EV`, 0.1);
/** Skip buckets priced below this (ultra-cheap quotes are stale / phantom-edge lottery tickets). */
export const MIN_ASK = envNum(`${P}MIN_ASK`, 0.02);
/** Trade same-day (D+0) markets. Default off: by D+0 the market has live-obs
 *  information our daily-max ensemble can't match, so tail "edges" are phantom. */
export const TRADE_D0 = envTruthy(`${P}TRADE_D0`);
export const MAX_PRICE = envNum(`${P}MAX_PRICE`, 0.45);
export const MIN_VOLUME = envNum(`${P}MIN_VOLUME`, 500);
export const MIN_HOURS = envNum(`${P}MIN_HOURS`, 2.0);
export const MAX_HOURS = envNum(`${P}MAX_HOURS`, 72.0);
export const KELLY_FRACTION = envNum(`${P}KELLY_FRACTION`, 0.25);
export const MAX_SLIPPAGE = envNum(`${P}MAX_SLIPPAGE`, 0.03);
export const SCAN_INTERVAL = envNum(`${P}SCAN_INTERVAL`, 3600);
export const CALIBRATION_MIN = envNum(`${P}CALIBRATION_MIN`, 30);
export const VC_KEY = envStr(`${P}VC_KEY`, "");

/** Enable real CLOB orders when combined with Polygon keys below (still paper/sim if unset). */
export const CLOB_LIVE_ENABLED = envTruthy(`${P}CLOB_LIVE`);

/**
 * Polymarket on-chain / CLOB credentials (Polygon).
 * When `WEATHERBOT_CLOB_LIVE` is set and keys are present, the bot places real orders via `@polymarket/clob-client`.
 * When you add trading, read these from `process.env` via this module — keep secrets in `.env` only.
 */
export const POLY_PRIVATE_KEY = envStr(`${P}POLY_PRIVATE_KEY`, "").replace(/^0x/i, "");
/** Polymarket “proxy” / funder address (the wallet that holds USDC on Polymarket). */
export const POLY_PROXY_WALLET = envStr(`${P}POLY_PROXY_WALLET`, "");
export const POLY_CHAIN_ID = envNum(`${P}POLY_CHAIN_ID`, 137);
/** CLOB L2 API (if your integration uses API key auth after deriving credentials). */
export const POLY_CLOB_API_KEY = envStr(`${P}POLY_CLOB_API_KEY`, "");
export const POLY_CLOB_API_SECRET = envStr(`${P}POLY_CLOB_API_SECRET`, "");
export const POLY_CLOB_API_PASSPHRASE = envStr(`${P}POLY_CLOB_API_PASSPHRASE`, "");

/**
 * Calibrated from 20 settled markets (2026-07-31):
 * - US/GFS (hrrr source): RMSE 1.71 -> SIGMA_F 1.7
 * - ECMWF:               RMSE 2.31 -> SIGMA_C 2.3
 * Auto-recalibrated via data/calibration.json once enough samples accumulate.
 */
export const SIGMA_F = 1.7;
export const SIGMA_C = 2.3;

/**
 * ECMWF systematically under-forecasts daily max temp:
 * C cities bias -1.34C, F cities bias -1.0F (20 settled samples).
 * Added inside getEcmwf() before best-bucket selection.
 */
export const ECMWF_BIAS_C = 1.34;
export const ECMWF_BIAS_F = 1.0;

/** Ensemble models fetched from Open-Meteo (comma list in one request). */
export const ENSEMBLE_MODELS = ["ecmwf_ifs025", "gfs_seamless", "icon_seamless"] as const;
/** Weight of each model in the ensemble mean (ECMWF is the historic gold standard). */
export const ENSEMBLE_WEIGHTS: Record<string, number> = {
  ecmwf_ifs025: 0.5,
  gfs_seamless: 0.3,
  icon_seamless: 0.2,
};
/**
 * Consensus gate: when the gap between ECMWF and GFS exceeds this,
 * models disagree strongly -> skip the trade (research: 62% win rate
 * when models agree within ~1C, 44% when they diverge).
 * Daily-max-temp model-to-model spread is typically ~1-2C, so the gate
 * is set at ~2C to only block the extreme disagreements.
 */
export const CONSENSUS_MAX_GAP_F = 3.5; // °F
export const CONSENSUS_MAX_GAP_C = 2.0; // °C
/** Min probability edge over the market's (calibrated) probability to open a trade.
 * Weather markets are mildly overconfident (slope ~0.91): extreme prices overstate the truth.
 */
export const MIN_EDGE = envNum(`${P}MIN_EDGE`, 0.07);
/** Logit calibration slope for market prices in the weather domain. */
export const MARKET_CAL_SLOPE = 0.91;

/**
 * Endgame / near-resolution trading (highest-certainty window).
 * Live METAR obs often lock the daily max a few hours before settlement while the
 * market still prices with lag — sweep the near-certain bucket and hold to settle.
 */
/** Enter endgame mode within this many hours of resolution. */
export const ENDGAME_HOURS = envNum(`${P}ENDGAME_HOURS`, 6.0);
/** Enable endgame sweep on D+0 markets (buy near-certain buckets from live obs). Default on. */
export const ENDGAME_SWEEP =
  process.env[`${P}ENDGAME_SWEEP`] == null ? true : envTruthy(`${P}ENDGAME_SWEEP`);
/** Ask range for endgame buys (high-certainty buckets only). */
export const ENDGAME_MIN_ASK = envNum(`${P}ENDGAME_MIN_ASK`, 0.75);
export const ENDGAME_MAX_ASK = envNum(`${P}ENDGAME_MAX_ASK`, 0.95);
/** Obs "locks" the daily max when METAR >= ensemble mean - this buffer. */
export const ENDGAME_LOCK_F = envNum(`${P}ENDGAME_LOCK_F`, 2.0);
export const ENDGAME_LOCK_C = envNum(`${P}ENDGAME_LOCK_C`, 1.0);
/**
 * Probability assigned to the bucket the locked METAR observation falls into.
 * Near resolution a locked obs is essentially the outcome (small residual risk
 * that the max still creeps up / obs-reads the wrong microclimate).
 */
export const ENDGAME_LOCKED_P = envNum(`${P}ENDGAME_LOCKED_P`, 0.93);
/** Take-profit price in endgame when the result is NOT yet locked (lock in profit). */
export const ENDGAME_TAKE_PROFIT = envNum(`${P}ENDGAME_TAKE_PROFIT`, 0.90);
/**
 * Endgame time-trap guards: the daily max usually peaks at local 14:00-16:00.
 * Before that, a METAR value at/near the forecast peak is NOT a locked max —
 * a short cloud gap can spike it, or the sun keeps heating. Only treat an obs
 * as "locked" after this local hour.
 */
export const ENDGAME_LOCAL_HOUR_MIN = envNum(`${P}ENDGAME_LOCAL_HOUR_MIN`, 14);
/** If the latest METAR rose by >= this (vs the previous obs) it is still heating
 *  up — do NOT lock the current bucket. */
export const ENDGAME_RISING_C = envNum(`${P}ENDGAME_RISING_C`, 0.5);
export const ENDGAME_RISING_F = envNum(`${P}ENDGAME_RISING_F`, 1.0);
/** Buy-cap while the cooling trend is not yet confirmed (local >= 16:00 AND obs
 *  falling). Stricter than ENDGAME_MAX_ASK so we don't pay up for a "locked" peak
 *  that might still break higher. */
export const ENDGAME_MAX_ASK_EARLY = envNum(`${P}ENDGAME_MAX_ASK_EARLY`, 0.88);
/** Local hour after which, combined with a falling obs, cooling is confirmed and
 *  the full ENDGAME_MAX_ASK cap applies. */
export const ENDGAME_COOLING_HOUR = envNum(`${P}ENDGAME_COOLING_HOUR`, 16);

/**
 * Sell slippage guard: before market-selling, we check the live best bid.
 * Take-profit / trailing exits skip the sell when the bid is more than this
 * fraction below the expected exit price (thin weather markets) and retry next
 * round. Stop-losses force through regardless — protecting capital wins.
 */
export const SELL_SLIPPAGE_TOL = envNum(`${P}SELL_SLIPPAGE_TOL`, 0.05);

/**
 * Orderbook depth guard: never open a position whose notional exceeds this
 * fraction of the top-2 levels of YES bid depth. Thin weather books would
 * otherwise be impossible to exit without severe slippage.
 */
export const MAX_DEPTH_FRACTION = envNum(`${P}MAX_DEPTH_FRACTION`, 0.3);

/**
 * Stop-loss confirm logic: a price dip below the stop is first marked pending
 * and only executed if it persists on the next scan (avoids getting shaken out
 * by a transient quote in a thin book). If the price craters below this fraction
 * of the entry price, the stop is forced immediately regardless.
 */
export const STOP_HARD_MULT = envNum(`${P}STOP_HARD_MULT`, 0.5);

/**
 * Free-LLM risk advisor (default provider: Google Gemini free tier).
 * The LLM reviews candidate buys before execution (advisory log by default,
 * optional hard gate) and produces a weekly performance review.
 * IMPORTANT: the LLM is a QUALITATIVE safety net only — it never blocks a
 * trade on an API failure (fail-open). It cannot guarantee profitability.
 */
export const LLM_ENABLED =
  process.env[`${P}LLM_ENABLED`] == null ? true : envTruthy(`${P}LLM_ENABLED`);
/** Provider: "gemini" | "groq" | "openrouter" | "custom". */
export const LLM_PROVIDER = envStr(`${P}LLM_PROVIDER`, "gemini");
/** Override the provider's default (free) model, e.g. "gemini-2.5-flash". */
export const LLM_MODEL = envStr(`${P}LLM_MODEL`, "");
/** When true, an LLM "skip" verdict vetoes the buy. Default false = log only. */
export const LLM_GATE = envTruthy(`${P}LLM_GATE`);
/** Max LLM calls per scan (free tiers are rate-limited). */
export const LLM_MAX_CALLS_PER_SCAN = envNum(`${P}LLM_MAX_CALLS_PER_SCAN`, 8);
/** LLM request timeout (ms) — AI responses can be slow. */
export const LLM_TIMEOUT_MS = envNum(`${P}LLM_TIMEOUT_MS`, 30000);

/**
 * Generate a beginner-friendly investment-advice report (data/reports/) every
 * time a buy is executed. The report is deterministic (offline-safe) plus an
 * optional AI plain-language section when the LLM provider is available.
 */
export const ADVICE_ENABLED =
  process.env[`${P}ADVICE`] == null ? true : envTruthy(`${P}ADVICE`);

const root = process.cwd();
export const DATA_DIR = path.join(root, "data");
mkdirSync(DATA_DIR, { recursive: true });
export const STATE_FILE = path.join(DATA_DIR, "state.json");
export const MARKETS_DIR = path.join(DATA_DIR, "markets");
mkdirSync(MARKETS_DIR, { recursive: true });
/** Beginner-friendly investment-advice reports (one file per executed buy). */
export const ADVICE_DIR = path.join(DATA_DIR, "reports");
mkdirSync(ADVICE_DIR, { recursive: true });
export const CALIBRATION_FILE = path.join(DATA_DIR, "calibration.json");

export const LOCATIONS: Record<string, LocationInfo> = {
  nyc: { lat: 40.7772, lon: -73.8726, name: "New York City", station: "KLGA", unit: "F", region: "us" },
  chicago: { lat: 41.9742, lon: -87.9073, name: "Chicago", station: "KORD", unit: "F", region: "us" },
  miami: { lat: 25.7959, lon: -80.287, name: "Miami", station: "KMIA", unit: "F", region: "us" },
  dallas: { lat: 32.8471, lon: -96.8518, name: "Dallas", station: "KDAL", unit: "F", region: "us" },
  seattle: { lat: 47.4502, lon: -122.3088, name: "Seattle", station: "KSEA", unit: "F", region: "us" },
  atlanta: { lat: 33.6407, lon: -84.4277, name: "Atlanta", station: "KATL", unit: "F", region: "us" },
  london: { lat: 51.5048, lon: 0.0495, name: "London", station: "EGLC", unit: "C", region: "eu" },
  paris: { lat: 48.9962, lon: 2.5979, name: "Paris", station: "LFPG", unit: "C", region: "eu" },
  munich: { lat: 48.3537, lon: 11.775, name: "Munich", station: "EDDM", unit: "C", region: "eu" },
  ankara: { lat: 40.1281, lon: 32.9951, name: "Ankara", station: "LTAC", unit: "C", region: "eu" },
  seoul: { lat: 37.4691, lon: 126.4505, name: "Seoul", station: "RKSI", unit: "C", region: "asia" },
  tokyo: { lat: 35.7647, lon: 140.3864, name: "Tokyo", station: "RJTT", unit: "C", region: "asia" },
  shanghai: { lat: 31.1443, lon: 121.8083, name: "Shanghai", station: "ZSPD", unit: "C", region: "asia" },
  singapore: { lat: 1.3502, lon: 103.994, name: "Singapore", station: "WSSS", unit: "C", region: "asia" },
  lucknow: { lat: 26.7606, lon: 80.8893, name: "Lucknow", station: "VILK", unit: "C", region: "asia" },
  "tel-aviv": { lat: 32.0114, lon: 34.8867, name: "Tel Aviv", station: "LLBG", unit: "C", region: "asia" },
  toronto: { lat: 43.6772, lon: -79.6306, name: "Toronto", station: "CYYZ", unit: "C", region: "ca" },
  "sao-paulo": { lat: -23.4356, lon: -46.4731, name: "Sao Paulo", station: "SBGR", unit: "C", region: "sa" },
  "buenos-aires": { lat: -34.8222, lon: -58.5358, name: "Buenos Aires", station: "SAEZ", unit: "C", region: "sa" },
  wellington: { lat: -41.3272, lon: 174.8052, name: "Wellington", station: "NZWN", unit: "C", region: "oc" },
};

export const TIMEZONES: Record<string, string> = {
  nyc: "America/New_York",
  chicago: "America/Chicago",
  miami: "America/New_York",
  dallas: "America/Chicago",
  seattle: "America/Los_Angeles",
  atlanta: "America/New_York",
  london: "Europe/London",
  paris: "Europe/Paris",
  munich: "Europe/Berlin",
  ankara: "Europe/Istanbul",
  seoul: "Asia/Seoul",
  tokyo: "Asia/Tokyo",
  shanghai: "Asia/Shanghai",
  singapore: "Asia/Singapore",
  lucknow: "Asia/Kolkata",
  "tel-aviv": "Asia/Jerusalem",
  toronto: "America/Toronto",
  "sao-paulo": "America/Sao_Paulo",
  "buenos-aires": "America/Argentina/Buenos_Aires",
  wellington: "Pacific/Auckland",
};

export const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

export const MONITOR_INTERVAL = 600;
