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
  POLY_CHAIN_ID,
  POLY_CLOB_API_KEY,
  POLY_CLOB_API_PASSPHRASE,
  POLY_CLOB_API_SECRET,
  POLY_PRIVATE_KEY,
  POLY_PROXY_WALLET,
} from "./config.js";
import { getGammaMarketDetail, parseYesTokenId } from "./polymarket.js";

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
