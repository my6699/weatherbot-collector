import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from "fs";
import path from "path";
import {
  BALANCE,
  CALIBRATION_FILE,
  CALIBRATION_MIN,
  LOCATIONS,
  MARKET_CAL_SLOPE,
  MARKET_SLOPE_MAX,
  MARKET_SLOPE_MIN,
  MARKET_SLOPE_MIN_N,
  MARKETS_DIR,
  SIGMA_C,
  SIGMA_F,
  STATE_FILE,
} from "./config.js";
import type { GammaEvent } from "./polymarket.js";
import type { EnsembleForecast } from "./forecasts.js";

export interface OutcomeRow {
  question: string;
  market_id: string;
  range: [number, number];
  bid: number;
  ask: number;
  price: number;
  spread: number;
  volume: number;
}

export interface ForecastSnap {
  ts?: string;
  horizon?: string;
  hours_left?: number;
  ecmwf?: number | null;
  hrrr?: number | null;
  metar?: number | null;
  best?: number | null;
  best_source?: string | null;
  /** Multi-model ensemble data (when available). */
  ens?: EnsembleForecast | null;
}

export interface MarketSnap {
  ts?: string;
  top_bucket: string | null;
  top_price: number | null;
}

export interface Position {
  market_id: string;
  question: string;
  bucket_low: number;
  bucket_high: number;
  entry_price: number;
  bid_at_entry: number;
  spread: number;
  shares: number;
  cost: number;
  p: number;
  ev: number;
  kelly: number;
  forecast_temp: number;
  forecast_src: string | null;
  sigma: number;
  opened_at?: string;
  status: string;
  pnl: number | null;
  exit_price: number | null;
  close_reason: string | null;
  closed_at: string | null;
  stop_price?: number;
  trailing_activated?: boolean;
  /** True once the stop-loss fired once; exit only on a confirming scan (avoids
   *  being shaken out by a transient dip in a thin book). */
  stop_pending?: boolean;
  /** Consecutive-scan counter for the forecast_changed exit. Incremented each
   *  scan the forecast stays outside the bucket (past the buffer); reset to 0
   *  on any in-bucket scan. The exit fires only at streak >=
   *  FORECAST_CHANGE_MIN_STREAK AND local hour >= ENDGAME_LOCAL_HOUR_MIN. */
  forecast_change_streak?: number;
  /** True once this position's hit/miss has been counted into state.wins/losses
   *  at market resolution (idempotent — protects against double counting on repeat
   *  resolution scans; pnl/balance are NOT touched here). */
  resolved_hit?: boolean;
  /** Strategy tag, e.g. "endgame" for near-resolution certainty buys. */
  strategy?: string;
  /** Polymarket CLOB YES token id (only set for live fills). */
  clob_yes_token_id?: string;
}

export interface MarketRecord {
  city: string;
  city_name: string;
  date: string;
  unit: "F" | "C";
  station: string;
  event_end_date: string;
  hours_at_discovery: number;
  status: string;
  position: Position | null;
  /** Multiple positions per market (bucket spread); `position` mirrors the first. */
  positions?: Position[];
  actual_temp: number | null;
  /** True station daily max (from METAR archive, in the market's unit). */
  metar_max?: number | null;
  resolved_outcome: string | null;
  pnl: number | null;
  forecast_snapshots: ForecastSnap[];
  market_snapshots: MarketSnap[];
  all_outcomes: OutcomeRow[];
  created_at: string;
}

export interface SimState {
  balance: number;
  starting_balance: number;
  total_trades: number;
  wins: number;
  losses: number;
  peak_balance: number;
  /** Epoch ms until which new buys are halted (extreme-weather circuit breaker). */
  circuit_until?: number;
}

export interface CalEntry {
  sigma: number;
  n: number;
  /** Mean signed error (forecast - actual) used for rolling bias correction. */
  bias?: number;
  updated_at: string;
  /** 动态市场校准斜率 (Logistic 回归拟合), 存在 __market__ 键下。
   *  用已结算市场的 entry_price vs resolved_hit 拟合, 替代写死的 MARKET_CAL_SLOPE。 */
  marketSlope?: number;
  marketSlopeN?: number;
}

let calCache: Record<string, CalEntry> | null = null;

export function loadCal(): Record<string, CalEntry> {
  if (calCache) return calCache;
  if (existsSync(CALIBRATION_FILE)) {
    calCache = JSON.parse(readFileSync(CALIBRATION_FILE, "utf-8")) as Record<string, CalEntry>;
    return calCache;
  }
  calCache = {};
  return calCache;
}

export function resetCalLoad(): void {
  calCache = null;
}

export function persistCal(cal: Record<string, CalEntry>): void {
  calCache = cal;
  writeFileSync(CALIBRATION_FILE, JSON.stringify(cal, null, 2), "utf-8");
}

export function getSigma(citySlug: string, source = "ecmwf"): number {
  const cal = loadCal();
  const key = `${citySlug}_${source}`;
  if (cal[key]) return cal[key].sigma;
  const loc = LOCATIONS[citySlug];
  return loc?.unit === "F" ? SIGMA_F : SIGMA_C;
}

/** Rolling signed-error bias for a (city, source). Returns 0 if no calibration yet. */
export function getBias(citySlug: string, source: string): number | null {
  const cal = loadCal();
  const key = `${citySlug}_${source}`;
  const entry = cal[key];
  return entry?.bias ?? null;
}

/**
 * 读取动态市场校准斜率。优先用 __market__ 键下 Logistic 回归拟合的斜率
 * (样本充足时), 否则回退到 config 的固定 MARKET_CAL_SLOPE=0.85。
 * 被 math.ts marketCalibrated() 调用。
 */
export function getMarketSlope(): number {
  const cal = loadCal();
  const entry = cal["__market__"];
  if (entry?.marketSlope != null && entry.marketSlopeN != null && entry.marketSlopeN >= MARKET_SLOPE_MIN_N) {
    return entry.marketSlope;
  }
  return MARKET_CAL_SLOPE;
}

/**
 * Logistic 回归拟合市场校准斜率: 用已结算市场的 entry_price (市场隐含概率)
 * vs resolved_hit (真实是否发生) 拟合 logit 斜率。
 *
 * 市场校准: p_calibrated = sigmoid(slope × logit(p_market))。
 * slope<1 → 市场过度自信 (极端价格高估真相), 需"打折";
 * slope>1 → 市场保守, 需"加码"; slope=1 → 市场完美校准。
 *
 * 牛顿法迭代 (Logistic 损失的凸性保证收敛), 钳位到 [MIN, MAX] 防过拟合。
 */
export function fitMarketSlope(
  samples: { p: number; y: 0 | 1 }[],
): { slope: number; n: number } | null {
  if (samples.length < MARKET_SLOPE_MIN_N) return null;
  // 过滤极端价格 (0.01/0.99 的 logit 无穷大, 扰动拟合)
  const valid = samples.filter((s) => s.p > 0.01 && s.p < 0.99);
  if (valid.length < MARKET_SLOPE_MIN_N) return null;

  let slope = MARKET_CAL_SLOPE; // 从固定值起步, 加快收敛
  for (let iter = 0; iter < 50; iter++) {
    let grad = 0;
    let hess = 0;
    for (const s of valid) {
      const x = Math.log(s.p / (1 - s.p)); // logit(p_market)
      const z = slope * x;
      const sig = 1 / (1 + Math.exp(-z));
      grad += (s.y - sig) * x;
      hess -= sig * (1 - sig) * x * x;
    }
    if (Math.abs(hess) < 1e-10) break;
    const step = grad / hess;
    slope += step;
    if (Math.abs(step) < 1e-6) break;
  }
  slope = Math.max(MARKET_SLOPE_MIN, Math.min(MARKET_SLOPE_MAX, slope));
  return { slope: Math.round(slope * 1000) / 1000, n: valid.length };
}

function lastTempForSource(snaps: ForecastSnap[], source: string): number | null {
  for (let i = snaps.length - 1; i >= 0; i--) {
    const s = snaps[i];
    if (!s) continue;
    if (source === "ecmwf" && s.ecmwf != null) return s.ecmwf;
    if (source === "hrrr" && s.hrrr != null) return s.hrrr;
    if (source === "metar" && s.metar != null) return s.metar;
  }
  return null;
}

export function runCalibration(markets: MarketRecord[]): Record<string, CalEntry> {
  const resolved = markets.filter((m) => m.status === "resolved" && m.actual_temp != null);
  const cal: Record<string, CalEntry> = { ...loadCal() };
  const updated: string[] = [];

  for (const source of ["ecmwf", "hrrr", "metar"] as const) {
    const cities = new Set(resolved.map((m) => m.city));
    for (const city of cities) {
      const loc = LOCATIONS[city];
      if (!loc) continue;
      const group = resolved.filter((m) => m.city === city);
      const errors: number[] = [];
      const signed: number[] = [];
      for (const m of group) {
        const t = lastTempForSource(m.forecast_snapshots ?? [], source);
        if (t != null && m.actual_temp != null) {
          errors.push(Math.abs(t - m.actual_temp));
          signed.push(t - m.actual_temp);
        }
      }
      if (errors.length < CALIBRATION_MIN) continue;
      const mae = errors.reduce((a, b) => a + b, 0) / errors.length;
      const bias = signed.reduce((a, b) => a + b, 0) / signed.length;
      const key = `${city}_${source}`;
      const old = cal[key]?.sigma ?? (loc.unit === "F" ? SIGMA_F : SIGMA_C);
      const newSigma = Math.round(mae * 1000) / 1000;
      cal[key] = {
        sigma: newSigma,
        n: errors.length,
        bias: Math.round(bias * 1000) / 1000,
        updated_at: new Date().toISOString(),
      };
      if (Math.abs(newSigma - old) > 0.05) {
        updated.push(`${loc.name} ${source}: ${old.toFixed(2)}->${newSigma.toFixed(2)}`);
      }
    }
  }

  // 动态市场校准斜率: 用已结算市场的 entry_price (隐含概率) vs resolved_hit
  // (真实发生) 拟合 Logistic logit 斜率, 替代写死的 MARKET_CAL_SLOPE。
  // 市场过度自信时 slope<1 (打折), 市场保守时 slope>1 (加码)。
  const slopeSamples: { p: number; y: 0 | 1 }[] = [];
  for (const m of resolved) {
    for (const p of m.positions ?? []) {
      if (p.entry_price == null || p.resolved_hit === undefined) continue;
      // 过滤极端价格 (fitMarketSlope 内部也会过滤, 这里提前跳过省计算)
      if (p.entry_price <= 0.01 || p.entry_price >= 0.99) continue;
      slopeSamples.push({ p: p.entry_price, y: p.resolved_hit ? 1 : 0 });
    }
  }
  const fit = fitMarketSlope(slopeSamples);
  if (fit) {
    const old = cal["__market__"]?.marketSlope ?? MARKET_CAL_SLOPE;
    cal["__market__"] = {
      sigma: 0,
      n: 0,
      marketSlope: fit.slope,
      marketSlopeN: fit.n,
      updated_at: new Date().toISOString(),
    };
    if (Math.abs(fit.slope - old) > 0.02) {
      updated.push(`market slope: ${old.toFixed(2)}->${fit.slope.toFixed(2)} (n=${fit.n})`);
    }
  }

  persistCal(cal);
  if (updated.length) console.log(`  [CAL] ${updated.join(", ")}`);
  return cal;
}

export function marketPath(citySlug: string, dateStr: string): string {
  return path.join(MARKETS_DIR, `${citySlug}_${dateStr}.json`);
}

export function loadMarket(citySlug: string, dateStr: string): MarketRecord | null {
  const p = marketPath(citySlug, dateStr);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as MarketRecord;
}

export function saveMarket(market: MarketRecord): void {
  const p = marketPath(market.city, market.date);
  writeFileSync(p, JSON.stringify(market, null, 2), "utf-8");
}

export function loadAllMarkets(): MarketRecord[] {
  const markets: MarketRecord[] = [];
  if (!existsSync(MARKETS_DIR)) return markets;
  for (const f of readdirSync(MARKETS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const text = readFileSync(path.join(MARKETS_DIR, f), "utf-8");
      markets.push(JSON.parse(text) as MarketRecord);
    } catch {
      /* skip bad file */
    }
  }
  return markets;
}

/** All positions of a market (legacy `position` treated as the single position). */
export function allPositions(m: MarketRecord): Position[] {
  if (m.positions && m.positions.length) return m.positions;
  return m.position ? [m.position] : [];
}

/** Positions still open for a market. */
export function openPositions(m: MarketRecord): Position[] {
  return allPositions(m).filter((p) => p.status === "open");
}

/** Append a position and mirror it into the legacy single `position` field. */
export function appendPosition(m: MarketRecord, pos: Position): void {
  if (!m.positions) m.positions = [];
  m.positions.push(pos);
  m.position = m.positions[0] ?? null;
}

export function newMarket(citySlug: string, dateStr: string, event: GammaEvent, hours: number): MarketRecord {
  const loc = LOCATIONS[citySlug]!;
  return {
    city: citySlug,
    city_name: loc.name,
    date: dateStr,
    unit: loc.unit,
    station: loc.station,
    event_end_date: event.endDate ?? "",
    hours_at_discovery: Math.round(hours * 10) / 10,
    status: "open",
    position: null,
    positions: [],
    actual_temp: null,
    resolved_outcome: null,
    pnl: null,
    forecast_snapshots: [],
    market_snapshots: [],
    all_outcomes: [],
    created_at: new Date().toISOString(),
  };
}

export function loadState(): SimState {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as SimState;
  }
  return {
    balance: BALANCE,
    starting_balance: BALANCE,
    total_trades: 0,
    wins: 0,
    losses: 0,
    peak_balance: BALANCE,
  };
}

export function saveState(state: SimState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}
