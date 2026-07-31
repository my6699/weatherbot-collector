import { fetchJson } from "./http.js";
import { parseTempRange } from "./math.js";

export interface GammaMarket {
  id?: string | number;
  question?: string;
  volume?: number | string;
  outcomePrices?: string;
  bestAsk?: number | string;
  bestBid?: number | string;
  /** JSON string array: [yesTokenId, noTokenId] for CLOB */
  clobTokenIds?: string;
}

export interface GammaMarketDetail {
  id?: string;
  clobTokenIds?: string;
  outcomes?: string;
  negRisk?: boolean;
  orderPriceMinTickSize?: number | string;
}

export interface GammaEvent {
  endDate?: string;
  markets?: GammaMarket[];
}

export async function getPolymarketEvent(
  citySlug: string,
  month: string,
  day: number,
  year: number,
): Promise<GammaEvent | null> {
  const slug = `highest-temperature-in-${citySlug}-on-${month}-${day}-${year}`;
  try {
    const data = await fetchJson<GammaEvent[]>(
      `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`,
    );
    if (data && Array.isArray(data) && data.length > 0) return data[0] ?? null;
  } catch {
    /* ignore */
  }
  return null;
}

export async function getMarketPrice(marketId: string): Promise<number | null> {
  try {
    const r = await fetchJson<{ outcomePrices?: string }>(`https://gamma-api.polymarket.com/markets/${marketId}`);
    const prices = JSON.parse(r.outcomePrices ?? "[0.5,0.5]") as number[];
    return Number(prices[0]);
  } catch {
    return null;
  }
}

export async function checkMarketResolved(marketId: string): Promise<boolean | null> {
  try {
    const data = await fetchJson<{ closed?: boolean; outcomePrices?: string }>(
      `https://gamma-api.polymarket.com/markets/${marketId}`,
    );
    if (!data.closed) return null;
    const prices = JSON.parse(data.outcomePrices ?? "[0.5,0.5]") as number[];
    const yesPrice = Number(prices[0]);
    if (yesPrice >= 0.95) return true;
    if (yesPrice <= 0.05) return false;
    return null;
  } catch (e) {
    console.error(`  [RESOLVE] ${marketId}:`, e);
    return null;
  }
}

export async function fetchMarketBestPrices(marketId: string): Promise<{ bestAsk: number; bestBid: number } | null> {
  try {
    const mdata = await fetchJson<{ bestAsk?: number | string; bestBid?: number | string }>(
      `https://gamma-api.polymarket.com/markets/${marketId}`,
    );
    if (mdata.bestAsk == null || mdata.bestBid == null) return null;
    return { bestAsk: Number(mdata.bestAsk), bestBid: Number(mdata.bestBid) };
  } catch {
    return null;
  }
}

export async function getGammaMarketDetail(marketId: string): Promise<GammaMarketDetail | null> {
  try {
    return await fetchJson<GammaMarketDetail>(`https://gamma-api.polymarket.com/markets/${marketId}`);
  } catch {
    return null;
  }
}

/** First token in `clobTokenIds` is the YES outcome for standard Yes/No markets. */
export function parseYesTokenId(detail: GammaMarketDetail): string | null {
  const raw = detail.clobTokenIds;
  if (!raw) return null;
  try {
    const ids = JSON.parse(raw) as string[];
    return ids[0] ?? null;
  } catch {
    return null;
  }
}

export interface ResolvedEventInfo {
  resolved: boolean;
  winningMarketId: string | null;
  actualTemp: number | null;
}

/**
 * After a weather event settles, exactly one outcome bucket has YES price ≈ 1.
 * Returns whether the event has settled, the winning market id, and the actual
 * temperature (bucket midpoint; open-ended buckets use the boundary value).
 */
export async function getResolvedEventInfo(
  citySlug: string,
  month: string,
  day: number,
  year: number,
): Promise<ResolvedEventInfo | null> {
  const event = await getPolymarketEvent(citySlug, month, day, year);
  if (!event) return null;
  for (const m of event.markets ?? []) {
    let prices: number[] = [];
    try {
      prices = JSON.parse(m.outcomePrices ?? "[0.5,0.5]") as number[];
    } catch {
      continue;
    }
    const yes = Number(prices[0]);
    if (!Number.isFinite(yes) || yes < 0.95) continue;
    const rng = parseTempRange(m.question);
    if (!rng) continue;
    const [lo, hi] = rng;
    const actualTemp =
      lo === -999 ? hi : hi === 999 ? lo : Math.round(((lo + hi) / 2) * 10) / 10;
    return { resolved: true, winningMarketId: String(m.id ?? ""), actualTemp };
  }
  return { resolved: false, winningMarketId: null, actualTemp: null };
}
