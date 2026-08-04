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
/** Max concurrent open positions per city/date market. 双桶区间套利策略:
 *  原单桶反复买不确定桶导致持续亏损 (76 trades, 0 wins)。改为双桶策略:
 *  在 D-3 选相邻两个最优桶 (温度区间), D-2 用 ENS 成员频次验证, D-0 两桶
 *  合计 >= TOP2_SUM_TRIGGER 时卖出锁利。允许同一市场最多 2 个持仓 (相邻桶)。
 *  仍通过 heldIds 禁止同一桶重复买入。 */
export const MAX_POSITIONS_PER_MARKET = envNum(`${P}MAX_POSITIONS_PER_MARKET`, 2);
export const MIN_EV = envNum(`${P}MIN_EV`, 0.1);
/** Skip buckets priced below this. Raised 0.02->0.10 (2026-08-03): single-point
 *  buckets under $0.10 are lottery tickets — with model RMSE 1.7-2.3°C their true
 *  hit rate is <10%, far below the ~10% break-even these prices imply. The old
 *  0.02 floor let the bot accumulate cheap phantom-edge positions that rarely hit. */
export const MIN_ASK = envNum(`${P}MIN_ASK`, 0.10);
/** Trade same-day (D+0) markets. Default off: by D+0 the market has live-obs
 *  information our daily-max ensemble can't match, so tail "edges" are phantom. */
export const TRADE_D0 = envTruthy(`${P}TRADE_D0`);
/** Max entry price. Lowered 0.45->0.25 (2026-08-03): LOO hit rate is 28%, so
 *  break-even entry is $0.28. At $0.45 the bot needs >45% hit rate to profit
 *  (only in-sample 50% barely clears it). $0.25 gives a 3-point safety margin
 *  under the 28% LOO rate; $0.20 would give 8 points but cuts entry count too
 *  hard. $0.25 is the sweet spot. */
export const MAX_PRICE = envNum(`${P}MAX_PRICE`, 0.25);
export const MIN_VOLUME = envNum(`${P}MIN_VOLUME`, 500);
export const MIN_HOURS = envNum(`${P}MIN_HOURS`, 2.0);
/** 2026-08-04: 双桶区间套利策略要求 D-3 入场 (拿最低价), 由 24h 放宽到 80h
 *  让程序在 D-3 就能看到并买入。风险: 远 horizon 模型误差大 + 订单簿薄,
 *  由双桶 D-2 验证 + D-0 合计卖出控制 (见 INTERVAL_* 配置)。 */
export const MAX_HOURS = envNum(`${P}MAX_HOURS`, 80.0);
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
/**
 * P2 优化: 相对 gap 阈值的倍数。最终阈值 = max(固定阈值, 近期平均gap × 此倍数)。
 * 夏季对流天气 gap 天然大 (3-4°C), 固定 2.0°C 会误杀; 此倍数允许阈值随波动率自适应。
 * 默认 1.5: 当前 gap 超过近 14 个快照均值 1.5 倍才跳过 (兼顾异常检测与适应性)。
 * 设为 0 可禁用相对阈值, 回退到纯固定阈值。
 */
export const CONSENSUS_GAP_RELATIVE_MULT = envNum(`${P}CONSENSUS_GAP_RELATIVE_MULT`, 1.5);
/** Min probability edge over the market's (calibrated) probability to open a trade.
 * Weather markets are mildly overconfident (slope ~0.91): extreme prices overstate the truth.
 */
export const MIN_EDGE = envNum(`${P}MIN_EDGE`, 0.07);
/** Logit calibration slope for market prices in the weather domain.
 * 原 0.91 过于乐观，现调整为 0.85，对模型预测的高置信度进行"打折"。 */
export const MARKET_CAL_SLOPE = 0.85;

/**
 * 过滤高概率交易阈值: 当模型预测概率 ourP 超过此值时，直接跳过交易。
 * 这类交易看似胜率极高，但在实践中胜率极低（假阳性）。
 * 原默认 1.0 (100%), 现设为 0.90 (90%), 即过滤掉 90% 以上置信度的交易。
 */
export const MAX_OURP = envNum(`${P}MAX_OURP`, 0.90);
/**
 * 集成成员频次概率的放宽阈值。当有 ECMWF ENS 51 成员数据支撑时, 概率是由
 * 物理扰动直接生成的 (50 个成员里 40 个落在该桶 = 80%), 远比正态 CDF 可靠,
 * 所以允许更高的 ourP 上限。默认 0.95: 仅过滤近乎确定的 95%+ 桶 (这些桶
 * 市场价通常已 $0.90+, 无 edge 可言)。
 */
export const MAX_OURP_ENSEMBLE = envNum(`${P}MAX_OURP_ENSEMBLE`, 0.95);

/**
 * 动态市场校准斜率 (Logistic 回归拟合) 参数。
 * 用已结算市场的 entry_price (隐含概率) vs resolved_hit (真实发生) 拟合 logit 斜率,
 * 替代写死的 MARKET_CAL_SLOPE=0.85。当样本不足时回退到固定斜率。
 */
/** 拟合所需最少样本数 (太少会过拟合, 40 笔约 3 周数据)。 */
export const MARKET_SLOPE_MIN_N = envNum(`${P}MARKET_SLOPE_MIN_N`, 40);
/** 斜率钳位下限 (市场再狂热也不低于 0.5, 否则校准后概率过度压缩)。 */
export const MARKET_SLOPE_MIN = envNum(`${P}MARKET_SLOPE_MIN`, 0.5);
/** 斜率钳位上限 (市场再理性也不超过 1.2, 否则等于不校准)。 */
export const MARKET_SLOPE_MAX = envNum(`${P}MARKET_SLOPE_MAX`, 1.2);

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
 * Local hour after which the daily max is considered "formed" (peaks at
 * 15:00-16:00 in most cities). Gate for THREE exits that must NOT fire before
 * the max is set (else we kill winning tickets on morning noise):
 *  - price-based stop-loss (scan.ts priceStopAllowed)
 *  - metarDiverged lower break (a low morning METAR proves nothing)
 *  - forecast_changed exit (a transient forecast wobble is not a real shift)
 * Raised 14->15 (2026-08-03): Miami 7-31 was killed at local 12:00 by a single
 * forecast_changed trigger; the max formed later and the bucket hit 96.5.
 */
export const ENDGAME_LOCAL_HOUR_MIN = envNum(`${P}ENDGAME_LOCAL_HOUR_MIN`, 15);
/** Min consecutive scans the forecast must stay outside a position's bucket
 *  before the forecast_changed exit fires (after the ENDGAME_LOCAL_HOUR_MIN
 *  gate opens). Filters single-scan wobbles: Miami 7-31 hrrr dipped 96->93 for
 *  one scan then returned to 96 — streak>=2 would have held it. */
export const FORECAST_CHANGE_MIN_STREAK = envNum(`${P}FORECAST_CHANGE_MIN_STREAK`, 2);
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
 * Two-bucket D-0 exit trigger (策略: 双桶区间套利).
 * When the sum of the two highest-adjacent-bucket YES prices crosses this
 * threshold on D-0, the market has effectively confirmed the temperature
 * interval — sell both buckets to lock in ~$1.00 before resolution risk.
 * 2026-08-04: 策略定稿为 85%。
 */
export const TOP2_SUM_TRIGGER = envNum(`${P}TOP2_SUM_TRIGGER`, 0.85);

/**
 * D-2 双桶验证: ENS 集成成员落在"双桶区间"的比例阈值。
 * 区间概率 = 落在 [low_first, high_second] 的成员数 / 成员总数。
 * - >= INTERVAL_HOLD_MIN: 持有 (D-0 等两桶合计达标卖出)
 * - [INTERVAL_REDUCE_MIN, INTERVAL_HOLD_MIN): 减仓 (卖 edge 较弱的桶)
 * - <  INTERVAL_REDUCE_MIN: 平仓 (预报已跑出区间, 认亏离场)
 */
export const INTERVAL_HOLD_MIN = envNum(`${P}INTERVAL_HOLD_MIN`, 0.30);
export const INTERVAL_REDUCE_MIN = envNum(`${P}INTERVAL_REDUCE_MIN`, 0.15);

/**
 * 双桶区间策略: 剩余单桶的平仓阈值。
 * D-2 减仓/另一桶止损后, 组内只剩 1 个 open 桶时不再等双桶合计达标,
 * 也不持有到结算 — 当该单桶 bid 超过此阈值即平仓锁利 (2026-08-04 定稿:
 * 不持有到结算, 单桶价格超 50% 就离场)。
 */
export const INTERVAL_SINGLE_EXIT = envNum(`${P}INTERVAL_SINGLE_EXIT`, 0.50);

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
 * Maker-first execution ("尽可能用 Maker"): every buy/sell first rests a
 * post-only GTC limit order at the touch (buy @ best bid, sell @ best ask) and
 * polls up to CLOB_MAKER_WAIT_MS for a fill — no crossing the spread, and
 * Polymarket pays no maker fee. If the order does not fill in time it is
 * canceled and we fall back to the market order (taker), so a missed fill
 * never blocks a decision. Stop-loss sells (force) skip straight to taker.
 */
export const CLOB_MAKER_MODE = process.env[`${P}CLOB_MAKER`] == null ? true : envTruthy(`${P}CLOB_MAKER`);
export const CLOB_MAKER_WAIT_MS = envNum(`${P}CLOB_MAKER_WAIT_MS`, 8000);
export const CLOB_MAKER_POLL_MS = envNum(`${P}CLOB_MAKER_POLL_MS`, 1500);

/**
 * Stop-loss confirm logic: a price dip below the stop is first marked pending
 * and only executed if it persists on the next scan (avoids getting shaken out
 * by a transient quote in a thin book). If the price craters below this fraction
 * of the entry price, the stop is forced immediately regardless.
 */
export const STOP_HARD_MULT = envNum(`${P}STOP_HARD_MULT`, 0.5);

/**
 * Dynamic (sigma-aware) stop-loss: the tight multiplier applies when the trade's
 * sigma is <= the city's base (calibrated) sigma; when model disagreement pushes
 * sigma ABOVE the base, the weather is genuinely uncertain, so the stop is
 * widened to avoid shaking out positions on normal volatility. Anchored to the
 * bid at entry so low-price buckets are never stopped out instantly.
 *
 * REVERTED 2026-08-03 (backtest): settled stop-losses show 0% wrong-kill (20/20
 * lost; holding to settlement lost $162 more), so the wide stop only let 9
 * positions ride to a full loss (+$111 worse). Both multipliers are back to
 * 0.8 (fixed stop). Re-enable by lowering STOP_MULT_WIDE once non-extreme
 * window data shows positions being shaken out that would have won.
 */
export const STOP_MULT = envNum(`${P}STOP_MULT`, 0.8);
export const STOP_MULT_WIDE = envNum(`${P}STOP_MULT_WIDE`, 0.8);

/**
 * Per-city, per-date exposure cap: the total COST of open positions for the
 * same (city, date) must stay below this amount. Prevents one city's weather
 * black-swan from dragging the whole account into a deep drawdown.
 * Raised 40->60 (2026-08-03): with MAX_POSITIONS_PER_MARKET=1 + horizon/p
 * weighting a high-conviction D+0 bucket can size up to $60 (MAX_BET 20 ×
 * horizon 1.5 × p-tier 2.0); the old 40 cap would have clipped it.
 */
export const MAX_CITY_COST_PER_DATE = envNum(`${P}MAX_CITY_COST_PER_DATE`, 60);

/**
 * Confidence-weighted position sizing (2026-08-03). Replaces the flat MAX_BET
 * cap with a multiplier on MAX_BET based on three signals validated in
 * scripts/backtest-optimize.ts (+$1273 combined vs flat $20):
 *  - horizon: D+0 hits 60% vs D+1 52% (backtest-horizon.ts) -> D+0 sized up
 *  - p-tier:  p>=0.30 hits 67% vs p<0.20 43% -> high-p sized up, low-p down
 *  - bias-n:  n>=8 hits 55% vs n<8 27% -> low-confidence bias sized down
 * Final bet = betSize(kelly, balance, MAX_BET × horizonMult × pMult × biasMult),
 * still gated by MAX_CITY_COST_PER_DATE and the depth guard.
 */
export const HORIZON_D0_MULT = envNum(`${P}HORIZON_D0_MULT`, 1.5);
export const P_TIER_HIGH = envNum(`${P}P_TIER_HIGH`, 0.3);
export const P_TIER_HIGH_MULT = envNum(`${P}P_TIER_HIGH_MULT`, 2.0);
export const P_TIER_LOW = envNum(`${P}P_TIER_LOW`, 0.2);
export const P_TIER_LOW_MULT = envNum(`${P}P_TIER_LOW_MULT`, 0.5);
export const BIAS_HIGH_N = envNum(`${P}BIAS_HIGH_N`, 8);
export const BIAS_LOW_N_MULT = envNum(`${P}BIAS_LOW_N_MULT`, 0.5);

/**
 * METAR divergence exit: when the live observation clearly misses an open
 * position's bucket, the bucket will not be the outcome — exit immediately
 * instead of waiting for a stop-loss. Upper break (`metar > bucket_high +
 * margin`) holds at any local hour; lower break only after the local peak
 * window (ENDGAME_LOCAL_HOUR_MIN) since the daily max is still forming before.
 */
export const METAR_DIVERGE_MARGIN_C = envNum(`${P}METAR_DIVERGE_MARGIN_C`, 1.5);
export const METAR_DIVERGE_MARGIN_F = envNum(`${P}METAR_DIVERGE_MARGIN_F`, 2.7);

/**
 * Horizon-aware rolling forecast-bias correction (city × horizon × source).
 * Computed from resolved markets (mean signed error, forecast - actual) and
 * stored in data/bias.json; the weekly LLM review validates it.
 *
 * ENABLED in CI (2026-08-03): collect.yml sets WEATHERBOT_BIAS_ENABLED=true.
 * The per-city signal splits BOTH directions (Dallas/Tel Aviv/Toronto forecast
 * high, Tokyo/Munich/Singapore low), which is why a GLOBAL correction fails
 * but per-city correction works (backtest: 18.3% -> 28.3% LOO hit rate).
 *
 * History: was DEFAULT OFF because applying it DEGRADED accuracy (1.76° ->
 * 3.01° avg error) — but that was an inverted-sign bug in applyBias (forecast
 * + bias instead of forecast - bias), fixed 2026-08-03 in src/bias.ts. With
 * the fix, per-city bias correction pulls predictions toward actual.
 */
export const BIAS_ENABLED = envTruthy(`${P}BIAS_ENABLED`);
/** Min resolved samples per (city,horizon,source) before the bias is applied. */
export const BIAS_MIN_N = envNum(`${P}BIAS_MIN_N`, 2);
/** Magnitude cap of a single correction in °C (F locations use ×1.8).
 *  Kept at 2.0 (2026-08-03): tested 2.5 in verify-bias-fix.ts — no net gain.
 *  Tel Aviv (+3.42 bias) still missed at cap 2.5 (needs 3.5+ to reach its
 *  actual bucket, too risky), while Miami (-5.0 anomalous bias) got
 *  over-corrected (error +0.1°→+1.0°, survived only by tied p). cap 2.0
 *  protects Miami's outlier bias while still rescuing it; extreme outliers
 *  (Tokyo/Tel Aviv) are accepted as un-rescuable random variance. */
export const BIAS_MAX_C = envNum(`${P}BIAS_MAX_C`, 2.0);
/** Bias is shrunk toward 0 below this sample count (guard against tiny samples). */
export const BIAS_SHRINK_N = envNum(`${P}BIAS_SHRINK_N`, 4);
/** Rolling window: keep only the latest N samples per key. */
export const BIAS_FORGET_N = envNum(`${P}BIAS_FORGET_N`, 12);

/**
 * D+0 METAR confirmation ("safe same-day trading"): regular buys on the event
 * day are only allowed when live METAR observations confirm the target bucket.
 * The obs must be within METAR_CONFIRM_MARGIN of the bucket's low edge and not
 * collapsing; the local hour must be >= METAR_CONFIRM_LOCAL_HOUR_MIN so the
 * daytime max has developed. This replaces the all-or-nothing TRADE_D0 gate.
 */
export const METAR_CONFIRM_ENABLED =
  process.env[`${P}METAR_CONFIRM`] == null ? true : envTruthy(`${P}METAR_CONFIRM`);
/** Only confirm D+0 within this many hours of resolution (obs relevance window). */
export const METAR_CONFIRM_HOURS = envNum(`${P}METAR_CONFIRM_HOURS`, 24);
/** Local hour before which the obs is not trusted (morning obs don't predict the max). */
export const METAR_CONFIRM_LOCAL_HOUR_MIN = envNum(`${P}METAR_CONFIRM_LOCAL_HOUR_MIN`, 11);
/** Obs must be >= bucket low - margin, and not falling by more than margin. */
export const METAR_CONFIRM_MARGIN_C = envNum(`${P}METAR_CONFIRM_MARGIN_C`, 1.0);
export const METAR_CONFIRM_MARGIN_F = envNum(`${P}METAR_CONFIRM_MARGIN_F`, 1.8);

/**
 * METAR hourly archive (aviationweather.gov, free): per-station per-LOCAL
 * calendar-day true daily max temperature (°C) stored in data/metar_max.json.
 * It is the settlement source itself — same feed AND same day definition as
 * Polymarket (verified: Seattle 08-01 = 70.5°F local-day, not 82°F UTC-day).
 * Used to (a) verify Polymarket's resolved value, (b) compute forecast error
 * against the real station max instead of the bucket midpoint, and (c) feed
 * sigma/bias calibration with true values. Each station fetches at most once/day.
 */
export const METAR_ARCHIVE_HOURS = envNum(`${P}METAR_ARCHIVE_HOURS`, 192); // 8 days

/**
 * Extreme-weather circuit breaker (black-swan guard): when the ensemble models
 * blow apart (spread above the threshold), that market's forecasts are
 * untrustworthy — skip buying it. If >= BREAKER_TRIPS markets trip in one run,
 * trading is halted globally for BREAKER_COOLDOWN_H hours (new buys only;
 * monitoring/selling always stay live) to avoid consecutive stop-losses during
 * storms / fronts / strong convection. Spread is in the market's own unit.
 */
export const BREAKER_SPREAD_C = envNum(`${P}BREAKER_SPREAD_C`, 3.5);
export const BREAKER_SPREAD_F = envNum(`${P}BREAKER_SPREAD_F`, 6.3);
export const BREAKER_TRIPS = envNum(`${P}BREAKER_TRIPS`, 3);
export const BREAKER_COOLDOWN_H = envNum(`${P}BREAKER_COOLDOWN_H`, 24);

/**
 * Net-edge guard: before buying, the expected round-trip cost is deducted from
 * the edge. We buy at the ask; an early exit (take-profit / forecast-change /
 * stop-loss) crosses the spread again on the way out. This fraction of the live
 * spread is subtracted so MIN_EDGE means NET edge, not gross edge.
 */
export const EXIT_SPREAD_FRAC = envNum(`${P}EXIT_SPREAD_FRAC`, 0.5);

/**
 * Free-LLM risk advisor (default provider: Google Gemini free tier).
 * The LLM reviews candidate buys before execution (advisory log by default,
 * optional hard gate) and produces a weekly performance review.
 * IMPORTANT: the LLM is a QUALITATIVE safety net only — it never blocks a
 * trade on an API failure (fail-open). It cannot guarantee profitability.
 */
export const LLM_ENABLED =
  process.env[`${P}LLM_ENABLED`] == null ? true : envTruthy(`${P}LLM_ENABLED`);
/** Provider: "gemini" | "groq" | "deepseek" | "openrouter" | "custom". */
export const LLM_PROVIDER = envStr(`${P}LLM_PROVIDER`, "gemini");
/** Override the provider's default (free) model, e.g. "gemini-2.5-flash". */
export const LLM_MODEL = envStr(`${P}LLM_MODEL`, "");
/**
 * Optional 2nd-opinion provider (same values as LLM_PROVIDER, e.g. "deepseek").
 * When set AND its API key is present, every buy-time risk review is sent to
 * BOTH models independently and merged with "buy only when both agree" logic
 * (either model's skip vetoes under LLM_GATE; otherwise logged). Empty = off.
 */
export const LLM_PROVIDER2 = envStr(`${P}LLM_PROVIDER2`, "");
/** Override the 2nd provider's default (free) model. */
export const LLM_MODEL2 = envStr(`${P}LLM_MODEL2`, "");
/** When true, an LLM "skip" verdict vetoes the buy. Default false = log only. */
export const LLM_GATE = envTruthy(`${P}LLM_GATE`);
/** Max LLM calls per scan per provider (free tiers are rate-limited). */
export const LLM_MAX_CALLS_PER_SCAN = envNum(`${P}LLM_MAX_CALLS_PER_SCAN`, 8);
/** LLM request timeout (ms) — AI responses can be slow. */
export const LLM_TIMEOUT_MS = envNum(`${P}LLM_TIMEOUT_MS`, 30000);
/**
 * LLM 集合模式: 使用 LLM (如 DeepSeek) 作为后处理器融合多模型预报。
 * 当启用时, getEnsembleForecast 会调用 LLM 将 ECMWF/GFS/ICON 的预报值
 * 融合为更准确的单一预测, 替代简单的加权平均。
 * 默认 false = 仅使用加权平均 (更快, 无 API 消耗)。
 */
export const LLM_ENSEMBLE = envTruthy(`${P}LLM_ENSEMBLE`);
/**
 * P0 优化: LLM 融合只在模型分歧足够大时才调用。
 * 模型高度一致时 (spread < 阈值), 加权平均已足够准确, 调用 LLM 只会增加
 * 延迟和 API 成本而无额外收益。实测: 80次/扫描 → ~15次/扫描, 扫描时间 4分→2分。
 * 阈值单位: °C / °F (F 城市 ×1.8)。默认 1.0°C / 1.8°F。
 */
export const LLM_ENSEMBLE_MIN_SPREAD_C = envNum(`${P}LLM_ENSEMBLE_MIN_SPREAD_C`, 1.0);
export const LLM_ENSEMBLE_MIN_SPREAD_F = envNum(`${P}LLM_ENSEMBLE_MIN_SPREAD_F`, 1.8);

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
