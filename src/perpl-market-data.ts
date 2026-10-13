import type { Level, MarketId } from "./financial-model";
import { getAddress } from "viem";
import { testnet } from "./testnet-config";

export const TESTNET_API = "https://testnet.perpl.xyz/api";
const CHAIN_ID = 10143;
const POLL_MS = 4000;
// Perpl stamps a book or ticker only when it changes, so on a quiet market the stamp is
// routinely 10 to 20 s old and sometimes more. That is a quiet market, not stale data.
// Freshness is therefore two things: we read it just now, and Perpl's own stamp is not
// far in the past. Every order is still bounded by its limit price and expiry block.
export const SOURCE_MAX_AGE_MS = 120000;
export const RECEIPT_MAX_AGE_MS = 15000;
// The book and the ticker change independently, so their stamps can sit far apart.
const MAX_SKEW_MS = 60000;

type ObjectValue = Record<string, unknown>;
const object = (value: unknown, label: string): ObjectValue => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`Invalid ${label}.`);
  return value as ObjectValue;
};
const integer = (value: unknown, label: string, min = 0): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    throw Error(`Invalid ${label}: expected an exact integer.`);
  return value;
};
const precision = (value: unknown, label: string) => {
  const digits = integer(value, label);
  if (digits > 6)
    throw Error(
      `Unsupported ${label}: micro-unit conversion would lose precision.`,
    );
  return digits;
};
const scaled = (value: unknown, digits: number, label: string) =>
  BigInt(integer(value, label, 1)) * 10n ** BigInt(6 - digits);
const signed = (value: unknown, label: string) =>
  BigInt(integer(value, label, -1_000_000));
const stamp = (value: unknown, label: string) => {
  const at = object(value, label);
  return {
    block: integer(at.b, `${label} block`, 1),
    time: integer(at.t, `${label} time`, 1),
  };
};

export interface PublicMarketMetadata {
  symbol: MarketId;
  marketId: number;
  instanceId: number;
  configBlock: number;
  configTime: number;
  contextVersion: number;
  orderTtlBlocks?: number;
  tick: bigint;
  lot: bigint;
  priceDecimals: number;
  sizeDecimals: number;
  open: boolean;
  baseTakerFeePpm: bigint;
  takerFeeTiersPpm?: bigint[];
  /** Raw protocol factors: not account-/quantity-specific risk admission. */
  initialMarginFactor: number;
  maintenanceMarginFactor: number;
  fundingIntervalBlocks: number;
  fundingIntervalSeconds: number;
  reportedFunding?: { ratePpm: bigint; eventBlock: number; time: number };
}
export interface PublicMarketObservation {
  metadata: PublicMarketMetadata;
  mark: bigint;
  bestBid: bigint;
  bestAsk: bigint;
  bids: Level[];
  asks: Level[];
  bookBlock: number;
  bookTime: number;
  stateBlock: number;
  stateTime: number;
  receivedAt: number;
  previousPrice?: bigint; // Perpl's price 24 hours ago, micro AUSD. Absent when not reported.
}
export interface MarketDataSnapshot {
  source: "Perpl public REST";
  network: "Monad testnet";
  chainId: 10143;
  transport: "direct" | "development proxy" | "same-origin public relay";
  market: MarketId;
  revision: number;
  status: "idle" | "loading" | "ready" | "stale" | "unavailable";
  observation?: PublicMarketObservation;
  error?: string;
}
export interface MarketDataSource {
  subscribe(fn: () => void): () => void;
  getSnapshot(): MarketDataSnapshot;
  selectMarket(market: MarketId): void;
  retry(): void;
}

/** Resolve network, instance and collateral before accepting market units. */
export function normalizeContext(
  payload: unknown,
  symbol: MarketId,
): PublicMarketMetadata {
  const context = object(payload, "context");
  const chain = object(context.chain, "chain");
  if (chain.chain_id !== CHAIN_ID)
    throw Error("Wrong network: expected Monad testnet 10143.");
  if (
    !Array.isArray(context.markets) ||
    !Array.isArray(context.instances) ||
    !Array.isArray(context.tokens)
  )
    throw Error("Incomplete context.");
  const candidates = context.markets
    .map((m) => object(m, "market"))
    .filter((m) => m.symbol === symbol);
  if (candidates.length !== 1)
    throw Error(
      `${symbol} is unavailable or ambiguous in the testnet context.`,
    );
  const market = candidates[0];
  const instance = context.instances
    .map((i) => object(i, "instance"))
    .find((i) => i.id === market.instance_id);
  const token = context.tokens
    .map((t) => object(t, "token"))
    .find((t) => t.id === instance?.collateral_token_id);
  if (!instance || !token || token.decimals !== 6 || token.symbol !== "AUSD")
    throw Error("Unsupported collateral or missing protocol instance.");
  // Symbols and numeric IDs do not identify the contracts used by finalized reads.
  if (
    typeof instance.address !== "string" ||
    typeof token.address !== "string" ||
    getAddress(instance.address) !== getAddress(testnet.exchange) ||
    getAddress(token.address) !== getAddress(testnet.collateral)
  )
    throw Error(
      "Public context contracts do not match this testnet environment.",
    );
  const config = object(market.config, "market config");
  const at = stamp(config.at, "config");
  const priceDecimals = precision(config.price_decimals, "price decimals");
  const sizeDecimals = precision(config.size_decimals, "size decimals");
  if (typeof config.is_open !== "boolean")
    throw Error("Market availability is missing.");
  if (market.size_units !== symbol) throw Error("Unsupported base size unit.");
  if (config.taker_fees !== undefined && !Array.isArray(config.taker_fees))
    throw Error("Invalid fee tiers.");
  const takerFeeTiersPpm = (config.taker_fees as unknown[] | undefined)?.map(
    (f) => signed(f, "fee tier"),
  );
  const baseTakerFeePpm = signed(config.taker_fee, "base taker fee");
  if (
    takerFeeTiersPpm &&
    (!takerFeeTiersPpm.length || takerFeeTiersPpm[0] !== baseTakerFeePpm)
  )
    throw Error("Inconsistent base fee tier.");
  let reportedFunding: PublicMarketMetadata["reportedFunding"];
  if (market.funding !== undefined) {
    const funding = object(market.funding, "funding");
    const at = stamp(funding.at, "funding");
    reportedFunding = {
      ratePpm: signed(funding.rate, "funding rate"),
      eventBlock: integer(funding.feb, "funding event block", 1),
      time: at.time,
    };
  }
  return {
    symbol,
    marketId: integer(market.id, "market ID", 1),
    instanceId: integer(market.instance_id, "instance ID", 1),
    configBlock: at.block,
    configTime: at.time,
    contextVersion: integer(market.ver, "context version"),
    ...(market.order_ttl_blocks === undefined
      ? {}
      : { orderTtlBlocks: integer(market.order_ttl_blocks, "order TTL", 1) }),
    tick: 10n ** BigInt(6 - priceDecimals),
    lot: 10n ** BigInt(6 - sizeDecimals),
    priceDecimals,
    sizeDecimals,
    open: config.is_open,
    baseTakerFeePpm,
    takerFeeTiersPpm,
    initialMarginFactor: integer(
      config.initial_margin,
      "initial margin factor",
      1,
    ),
    maintenanceMarginFactor: integer(
      config.maintenance_margin,
      "maintenance margin factor",
      1,
    ),
    fundingIntervalBlocks: integer(
      market.funding_interval_blocks,
      "funding interval blocks",
      1,
    ),
    fundingIntervalSeconds: integer(
      market.funding_interval_sec,
      "funding interval seconds",
      1,
    ),
    reportedFunding,
  };
}

export function normalizeObservation(
  metadata: PublicMarketMetadata,
  tickerPayload: unknown,
  bookPayload: unknown,
  receivedAt: number,
): PublicMarketObservation {
  if (!metadata.open) throw Error(`${metadata.symbol} is closed on testnet.`);
  const ticker = object(tickerPayload, "ticker");
  if (ticker.mt !== 9) throw Error("Expected a full market state response.");
  const state = object(
    object(ticker.d, "ticker markets")[String(metadata.marketId)],
    "selected market state",
  );
  const stateAt = stamp(state.at, "state");
  const book = object(bookPayload, "book");
  if (book.mt !== 15)
    throw Error(
      "Expected a full book snapshot; deltas cannot be used as snapshots.",
    );
  const bookAt = stamp(book.at, "book");
  if (
    integer(book.sn, "book revision", 1) !== bookAt.block ||
    integer(ticker.sn, "ticker revision", 1) < stateAt.block
  )
    throw Error("Inconsistent source revision.");
  const levels = (value: unknown, side: "bids" | "asks"): Level[] => {
    if (!Array.isArray(value) || !value.length || value.length > 100)
      throw Error(`Unavailable ${side} depth.`);
    const result = value.map((v) => {
      const l = object(v, "book level");
      integer(l.o, "order count", 1);
      return {
        price: scaled(l.p, metadata.priceDecimals, "book price"),
        lots: BigInt(integer(l.s, "book size", 1)),
      };
    });
    for (let i = 1; i < result.length; i++)
      if (
        side === "asks"
          ? result[i].price <= result[i - 1].price
          : result[i].price >= result[i - 1].price
      )
        throw Error("Book levels are duplicated or out of order.");
    return result;
  };
  const bids = levels(book.bid, "bids"),
    asks = levels(book.ask, "asks");
  if (bids[0].price >= asks[0].price) throw Error("Crossed book snapshot.");
  if (Math.abs(bookAt.time - stateAt.time) > MAX_SKEW_MS)
    throw Error("Book and mark observations are too far apart.");
  return {
    metadata,
    mark: scaled(state.mrk, metadata.priceDecimals, "mark price"),
    bestBid: scaled(state.bid, metadata.priceDecimals, "best bid"),
    bestAsk: scaled(state.ask, metadata.priceDecimals, "best ask"),
    bids,
    asks,
    bookBlock: bookAt.block,
    bookTime: bookAt.time,
    stateBlock: stateAt.block,
    stateTime: stateAt.time,
    receivedAt,
    ...(typeof state.prv === "number" && state.prv > 0
      ? {
          previousPrice: scaled(
            state.prv,
            metadata.priceDecimals,
            "price 24 hours ago",
          ),
        }
      : {}),
  };
}

export function observationFresh(
  o: PublicMarketObservation,
  now: number,
): boolean {
  const oldest = Math.min(o.bookTime, o.stateTime);
  const newest = Math.max(o.bookTime, o.stateTime);
  return (
    now - o.receivedAt < RECEIPT_MAX_AGE_MS &&
    now - oldest < SOURCE_MAX_AGE_MS &&
    newest <= now + 2000
  );
}

/** One request group at a time, no persistent cache or account access. */
export class PerplMarketDataSource implements MarketDataSource {
  private snapshot: MarketDataSnapshot;
  private listeners = new Set<() => void>();
  private generation = 0;
  private controller?: AbortController;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private freshnessTimer?: ReturnType<typeof setInterval>;
  private failures = 0;
  constructor(
    private baseUrl = TESTNET_API,
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
    relay = false,
  ) {
    if (![TESTNET_API, "/perpl-public"].includes(baseUrl))
      throw Error("Only the fixed Perpl testnet public source is supported.");
    this.snapshot = {
      source: "Perpl public REST",
      network: "Monad testnet",
      chainId: CHAIN_ID,
      transport:
        baseUrl === TESTNET_API
          ? "direct"
          : relay
            ? "same-origin public relay"
            : "development proxy",
      market: "ETH",
      revision: 0,
      status: "idle",
    };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    if (this.listeners.size === 1) {
      this.freshnessTimer = setInterval(() => {
        const s = this.snapshot;
        if (
          s.status === "ready" &&
          s.observation &&
          !observationFresh(s.observation, Date.now())
        )
          this.publish({
            status: "stale",
            error:
              "Source timestamps are stale; waiting for a valid replacement.",
          });
      }, 1000);
      this.restart();
    }
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) {
        this.cancel();
        clearInterval(this.freshnessTimer);
        this.snapshot = { ...this.snapshot, status: "idle" };
      }
    };
  };
  selectMarket = (market: MarketId) => {
    if (market === this.snapshot.market) return;
    this.cancel();
    this.publish({
      market,
      observation: undefined,
      status: "idle",
      error: undefined,
    });
    if (this.listeners.size) this.restart();
  };
  retry = () => {
    if (this.listeners.size) this.restart();
  };
  private publish(next: Partial<MarketDataSnapshot>) {
    this.snapshot = {
      ...this.snapshot,
      ...next,
      revision: this.snapshot.revision + 1,
    };
    for (const fn of this.listeners) fn();
  }
  private cancel() {
    this.generation++;
    this.controller?.abort();
    clearTimeout(this.pollTimer);
  }
  private restart() {
    this.cancel();
    this.failures = 0;
    // Cached observations remain explicitly stale during reconnection.
    this.publish({
      status: this.snapshot.observation ? "stale" : "loading",
      error: undefined,
    });
    void this.poll(this.generation);
  }
  private async poll(generation: number) {
    const market = this.snapshot.market;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    const read = async (path: string) => {
      const response = await this.fetcher(`${this.baseUrl}/v1/${path}`, {
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
      });
      if (!response.ok)
        throw Error(`Perpl public data returned HTTP ${response.status}.`);
      return response.json() as Promise<unknown>;
    };
    try {
      const metadata = normalizeContext(await read("pub/context"), market);
      if (generation !== this.generation || !this.listeners.size) return;
      const [ticker, book] = await Promise.all([
        read(`market-data/${metadata.marketId}/ticker`),
        read(`market-data/${metadata.marketId}/book?levels=100`),
      ]);
      if (generation !== this.generation || !this.listeners.size) return;
      const observation = normalizeObservation(
        metadata,
        ticker,
        book,
        Date.now(),
      );
      const previous = this.snapshot.observation;
      if (previous && metadata.marketId !== previous.metadata.marketId) {
        this.publish({
          observation: undefined,
          status: "unavailable",
          error: "Market identity changed. Waiting for a replacement snapshot.",
        });
        throw Error(
          "Market identity changed. Waiting for a replacement snapshot.",
        );
      }
      if (
        previous &&
        (metadata.contextVersion < previous.metadata.contextVersion ||
          metadata.configBlock < previous.metadata.configBlock ||
          observation.bookBlock < previous.bookBlock ||
          observation.stateBlock < previous.stateBlock ||
          observation.bookTime < previous.bookTime ||
          observation.stateTime < previous.stateTime)
      ) {
        // Perpl's servers can answer with a snapshot a block or two behind one already
        // seen. That is not a failure: the newer one we hold is still the latest known,
        // and this read confirms it as of now.
        this.failures = 0;
        this.publish({
          observation: { ...previous, receivedAt: Date.now() },
          status: "ready",
          error: undefined,
        });
        return;
      }
      this.failures = 0;
      const fresh = observationFresh(observation, Date.now());
      this.publish({
        observation,
        status: fresh ? "ready" : "stale",
        error: fresh
          ? undefined
          : "Source timestamps are stale or in the future; observation is not current.",
      });
    } catch (error) {
      if (generation !== this.generation || !this.listeners.size) return;
      this.failures++;
      this.publish({
        status: this.snapshot.observation ? "stale" : "unavailable",
        error:
          error instanceof TypeError
            ? this.baseUrl === TESTNET_API
              ? "Public data could not be fetched. Direct browser access requires Perpl CORS permission or a permitted relay."
              : "Public data server could not be reached. Check the connection and retry."
            : error instanceof Error && error.name === "AbortError"
              ? "Public market request timed out."
              : error instanceof Error
                ? error.message
                : "Public market data is unavailable.",
      });
    } finally {
      clearTimeout(timeout);
      if (generation === this.generation && this.listeners.size) {
        this.controller = undefined;
        const delay = Math.min(
          60000,
          POLL_MS * 2 ** Math.min(this.failures, 4),
        );
        this.pollTimer = setTimeout(() => {
          void this.poll(generation);
        }, delay);
      }
    }
  }
}
