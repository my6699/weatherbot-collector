import {
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureType,
} from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { polygon, polygonAmoy } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  CLOB_LIVE_ENABLED,
  CLOB_MAKER_MODE,
  CLOB_MAKER_POLL_MS,
  CLOB_MAKER_WAIT_MS,
  POLY_CHAIN_ID,
  POLY_CLOB_API_KEY,
  POLY_CLOB_API_PASSPHRASE,
  POLY_CLOB_API_SECRET,
  POLY_PRIVATE_KEY,
  POLY_PROXY_WALLET,
} from "./config.js";
import { getGammaMarketDetail, parseYesTokenId } from "./polymarket.js";
import { sleep } from "./http.js";

const CLOB_HOST = "https://clob.polymarket.com";

export function isLiveClobEnabled(): boolean {
  return CLOB_LIVE_ENABLED && Boolean(POLY_PRIVATE_KEY && POLY_PROXY_WALLET);
}

function assertLiveConfig(): void {
  if (!POLY_PRIVATE_KEY) throw new Error("WEATHERBOT_POLY_PRIVATE_KEY required for live CLOB");
  if (!POLY_PROXY_WALLET) throw new Error("WEATHERBOT_POLY_PROXY_WALLET required for live CLOB");
}

function clobChainId(): Chain {
  if (POLY_CHAIN_ID === 80002) return Chain.AMOY;
  return Chain.POLYGON;
}

function viemChain() {
  if (POLY_CHAIN_ID === 80002) return polygonAmoy;
  return polygon;
}

let cached: ClobClient | null = null;

export async function getClobClient(): Promise<ClobClient> {
  if (cached) return cached;
  assertLiveConfig();
  const pk = POLY_PRIVATE_KEY.startsWith("0x") ? POLY_PRIVATE_KEY : `0x${POLY_PRIVATE_KEY}`;
  const account = privateKeyToAccount(pk as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: viemChain(),
    transport: http(),
  });

  const sigRaw = process.env.WEATHERBOT_POLY_SIGNATURE_TYPE;
  const sigParsed = sigRaw != null && sigRaw !== "" ? Number(sigRaw) : NaN;
  const signatureType = Number.isFinite(sigParsed) ? (sigParsed as SignatureType) : SignatureType.POLY_PROXY;

  let creds;
  if (POLY_CLOB_API_KEY && POLY_CLOB_API_SECRET && POLY_CLOB_API_PASSPHRASE) {
    creds = {
      key: POLY_CLOB_API_KEY,
      secret: POLY_CLOB_API_SECRET,
      passphrase: POLY_CLOB_API_PASSPHRASE,
    };
  } else {
    const temp = new ClobClient(CLOB_HOST, clobChainId(), walletClient);
    creds = await temp.createOrDeriveApiKey();
  }

  cached = new ClobClient(
    CLOB_HOST,
    clobChainId(),
    walletClient,
    creds,
    signatureType,
    POLY_PROXY_WALLET,
  );
  return cached;
}

function assertOrderOk(resp: unknown): void {
  if (resp == null) throw new Error("empty CLOB response");
  if (typeof resp === "object") {
    const r = resp as Record<string, unknown>;
    if (r.error) throw new Error(String(r.error));
    if (r.success === false) throw new Error(String(r.errorMsg ?? "order rejected"));
  }
}

function entryOrderType(): OrderType.FOK | OrderType.FAK {
  const t = (process.env.WEATHERBOT_CLOB_ENTRY_ORDER_TYPE ?? "FAK").toUpperCase();
  return t === "FOK" ? OrderType.FOK : OrderType.FAK;
}

function exitOrderType(): OrderType.FOK | OrderType.FAK {
  const t = (process.env.WEATHERBOT_CLOB_EXIT_ORDER_TYPE ?? "FAK").toUpperCase();
  return t === "FOK" ? OrderType.FOK : OrderType.FAK;
}

/** Market-buy YES: `amount` is USDC notional (CLOB client convention). */
export async function clobBuyYesUsd(yesTokenId: string, usdAmount: number): Promise<unknown> {
  const client = await getClobClient();
  const ot = entryOrderType();
  const resp = await client.createAndPostMarketOrder(
    { tokenID: yesTokenId, amount: usdAmount, side: Side.BUY, orderType: ot },
    {},
    ot,
  );
  assertOrderOk(resp);
  return resp;
}

/** Market-sell YES: `shareAmount` is conditional token size. */
export async function clobSellYesShares(yesTokenId: string, shareAmount: number): Promise<unknown> {
  const client = await getClobClient();
  const ot = exitOrderType();
  const resp = await client.createAndPostMarketOrder(
    { tokenID: yesTokenId, amount: shareAmount, side: Side.SELL, orderType: ot },
    {},
    ot,
  );
  assertOrderOk(resp);
  return resp;
}

interface MakerFill {
  filled: boolean;
  fillPrice: number | null;
  orderId: string | null;
}

/**
 * Maker-first fill attempt: rest a post-only GTC limit order at `limitPrice`
 * (the touch — buy @ best bid / sell @ best ask), poll up to CLOB_MAKER_WAIT_MS
 * for a fill, then cancel if unfilled. Returns the fill state so the caller can
 * fall back to a taker market order. When CLOB_MAKER_MODE is off this returns
 * unfilled immediately and the caller uses the plain taker path.
 */
async function clobTryMakerFill(
  yesTokenId: string,
  size: number,
  limitPrice: number,
  side: Side,
): Promise<MakerFill> {
  if (!CLOB_MAKER_MODE) return { filled: false, fillPrice: null, orderId: null };
  const client = await getClobClient();
  const safeSize = Math.max(0.01, Math.round(size * 100) / 100);
  const safePrice = Math.max(0.001, Math.min(0.999, Math.round(limitPrice * 1000) / 1000));
  const resp = await client.createAndPostOrder(
    { tokenID: yesTokenId, price: safePrice, size: safeSize, side },
    {},
    OrderType.GTC,
    false,
    true, // postOnly
  );
  assertOrderOk(resp);
  const orderId =
    (resp as { orderID?: string } | null)?.orderID ??
    (resp as { id?: string } | null)?.id ??
    null;
  if (!orderId) return { filled: false, fillPrice: null, orderId: null };

  const deadline = Date.now() + CLOB_MAKER_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(CLOB_MAKER_POLL_MS);
    try {
      const o = await client.getOrder(orderId);
      const matched = Number((o as { size_matched?: string | number } | null)?.size_matched ?? 0);
      const orig = Number((o as { original_size?: string | number } | null)?.original_size ?? size);
      const status = (o as { status?: string } | null)?.status;
      if (status === "MATCHED" || (orig > 0 && matched >= orig * 0.999)) {
        return { filled: true, fillPrice: safePrice, orderId };
      }
    } catch {
      /* keep polling until the deadline */
    }
  }
  // Not filled in time — cancel and let the caller fall back to taker.
  try {
    await client.cancelOrder({ orderID: orderId });
  } catch {
    /* already filled / already gone */
  }
  return { filled: false, fillPrice: null, orderId };
}

/** Maker-first buy of YES; returns the fill state (caller falls back to taker). */
export async function clobTryMakerBuy(
  yesTokenId: string,
  usdAmount: number,
  limitPrice: number,
): Promise<MakerFill> {
  const size = usdAmount / Math.max(0.001, limitPrice);
  return clobTryMakerFill(yesTokenId, size, limitPrice, Side.BUY);
}

/** Maker-first sell of YES shares; returns the fill state (caller falls back to taker). */
export async function clobTryMakerSell(
  yesTokenId: string,
  shareAmount: number,
  limitPrice: number,
): Promise<MakerFill> {
  return clobTryMakerFill(yesTokenId, shareAmount, limitPrice, Side.SELL);
}

export async function resolveYesTokenId(marketId: string): Promise<string | null> {
  const detail = await getGammaMarketDetail(marketId);
  if (!detail) return null;
  return parseYesTokenId(detail);
}

interface OrderLevel {
  price: number;
  size: number;
}

function toLevels(rows: unknown): OrderLevel[] {
  // clob-client returns {price, size} objects or [price, size] pairs depending on
  // the version — parse both defensively.
  if (!Array.isArray(rows)) return [];
  const out: OrderLevel[] = [];
  for (const row of rows) {
    if (Array.isArray(row)) {
      const p = Number(row[0]);
      const s = Number(row[1]);
      if (Number.isFinite(p) && Number.isFinite(s)) out.push({ price: p, size: s });
    } else if (row && typeof row === "object") {
      const p = Number((row as { price?: unknown }).price);
      const s = Number((row as { size?: unknown }).size);
      if (Number.isFinite(p) && Number.isFinite(s)) out.push({ price: p, size: s });
    }
  }
  return out;
}

/**
 * Total notional ($) resting on the top `levels` levels of the YES bid side.
 * Returns null when the book is unavailable (e.g. API failure / not live).
 */
export async function getYesBidDepth(yesTokenId: string, levels = 2): Promise<number | null> {
  try {
    const client = await getClobClient();
    const book = (await client.getOrderBook(yesTokenId)) as { bids?: unknown };
    const bids = toLevels(book?.bids);
    let total = 0;
    let i = 0;
    for (const b of bids) {
      if (i >= levels) break;
      total += b.price * b.size;
      i += 1;
    }
    return total;
  } catch {
    return null;
  }
}
