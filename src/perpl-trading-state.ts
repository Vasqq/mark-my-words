import { getAddress } from "viem";
import { readTestnetAccount, type TestnetAccount } from "./perpl-account";
import {
  normalizeContext,
  type PublicMarketMetadata,
} from "./perpl-market-data";

const maximumAge = 30_000;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Incomplete Perpl trading state.");
  return value as Record<string, unknown>;
};
const integer = (value: unknown, min = 0): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    throw Error("Invalid integer in Perpl trading state.");
  return value;
};
const amount = (value: unknown, signed = false): bigint => {
  if (
    typeof value !== "string" ||
    !(signed ? /^-?\d{1,78}$/ : /^\d{1,78}$/).test(value)
  )
    throw Error("Invalid collateral amount in Perpl trading state.");
  return BigInt(value);
};
const list = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value) || value.length > 1000)
    throw Error("Incomplete or oversized Perpl trading snapshot.");
  return value.map(object);
};
function envelope(value: unknown, type: number, now: number) {
  const data = object(value);
  const at = object(data.at);
  const block = integer(at.b, 1);
  const time = integer(at.t, 1);
  if (data.mt !== type || integer(data.sn, 1) !== block)
    throw Error("Unexpected Perpl snapshot type or block.");
  if (now - time > maximumAge || time > now + 2000)
    throw Error("Perpl trading snapshot is stale. Refresh before continuing.");
  return { data, block, time };
}

export interface TradingPosition {
  id: number;
  market: PublicMarketMetadata;
  side: "Long" | "Short";
  size: bigint; // Native market size units, not micro-lots.
  entryPrice: bigint; // Native market price units; residue is kept separately.
  entryResidueQ16: number;
  collateral: bigint; // AUSD CNS, six decimals.
  fees: bigint;
}
export interface TradingOrder {
  id: number;
  market: PublicMarketMetadata;
  type: number;
  status: number;
  size: bigint;
  filled: bigint;
  request?: number;
  price?: bigint;
  flags?: number;
  leverage?: number;
  triggerCondition?: number;
  triggerPrice?: bigint;
  linkedPosition?: number;
}
export interface TradingState {
  owner: string;
  accountId: number;
  balance: bigint;
  free: bigint;
  locked: bigint;
  forwarding: boolean;
  frozen: boolean;
  feeTier: number;
  lastRequestId: number;
  markets: PublicMarketMetadata[];
  restrictions: TestnetAccount["funding"];
  positions: TradingPosition[];
  orders: TradingOrder[];
  sources: { name: string; block: number; time: number }[];
  receivedAt: number;
  reconciled: boolean;
  discrepancy?: string;
}

/** Independent API snapshots are observations, never an atomic execution quote. */
export function normalizeTradingState(
  owner: string,
  responses: {
    wallet: unknown;
    positions: unknown;
    orders: unknown;
    context: unknown;
  },
  chain: TestnetAccount,
  now = Date.now(),
): TradingState {
  const wallet = envelope(responses.wallet, 19, now);
  const positions = envelope(responses.positions, 26, now);
  const orders = envelope(responses.orders, 23, now);
  const markets = [
    normalizeContext(responses.context, "ETH"),
    normalizeContext(responses.context, "BTC"),
  ];
  if (markets[0].instanceId !== markets[1].instanceId)
    throw Error("Trading markets belong to different protocol instances.");
  if (
    typeof wallet.data.addr !== "string" ||
    getAddress(wallet.data.addr) !== getAddress(owner) ||
    getAddress(chain.owner) !== getAddress(owner) ||
    chain.chainId !== 10143
  )
    throw Error("Trading state belongs to a different wallet or chain.");
  const accounts = list(wallet.data.as);
  if (accounts.length !== 1 || accounts[0].in !== markets[0].instanceId)
    throw Error("Expected one account in the supported Perpl instance.");
  const account = accounts[0];
  const accountId = integer(account.id, 1);
  if (typeof account.fw !== "boolean" || typeof account.fr !== "boolean")
    throw Error("Perpl account permissions are missing.");
  const marketFor = (row: Record<string, unknown>) => {
    if (integer(row.acc, 1) !== accountId)
      throw Error("Trading snapshot contains another account's exposure.");
    const market = markets.find((m) => m.marketId === integer(row.mkt, 1));
    if (!market)
      throw Error(
        "Exposure exists in an unsupported market. Review it on Perpl.",
      );
    return market;
  };
  const parsedPositions = list(positions.data.d).map((row): TradingPosition => {
    const market = marketFor(row);
    if (row.st !== 1 || ![1, 2].includes(integer(row.sd, 1)))
      throw Error("Unexpected position state in the open snapshot.");
    const residue = row.epr === undefined ? 0 : integer(row.epr);
    if (residue > 65535) throw Error("Invalid fractional entry price.");
    return {
      id: integer(row.pid, 1),
      market,
      side: row.sd === 1 ? "Long" : "Short",
      size: BigInt(integer(row.s, 1)),
      entryPrice: BigInt(integer(row.ep, 1)),
      entryResidueQ16: residue,
      collateral: amount(row.c),
      fees: amount(row.fee, true),
    };
  });
  const parsedOrders = list(orders.data.d).map((row): TradingOrder => {
    const market = marketFor(row);
    const status = integer(row.st, 1);
    const type = integer(row.t, 1);
    if (![1, 2, 3, 8, 9].includes(status) || type > 7 || row.r === true)
      throw Error("Unexpected order state in the open snapshot.");
    if (
      status === 8 &&
      (integer(row.tp, 1) < 1 || ![1, 2, 3, 4].includes(integer(row.tpc, 1)))
    )
      throw Error("Trigger order is missing its condition or price.");
    const size = BigInt(integer(row.os));
    const filled = BigInt(integer(row.fs));
    if (filled > size) throw Error("Order fill exceeds its original quantity.");
    return {
      id: integer(row.oid, 1),
      market,
      type,
      status,
      size,
      filled,
      ...(row.rq === undefined ? {} : { request: integer(row.rq) }),
      ...(row.p === undefined ? {} : { price: BigInt(integer(row.p)) }),
      ...(row.fl === undefined ? {} : { flags: integer(row.fl) }),
      ...(row.lv === undefined ? {} : { leverage: integer(row.lv) }),
      ...(row.tpc === undefined ? {} : { triggerCondition: integer(row.tpc) }),
      ...(row.tp === undefined
        ? {}
        : { triggerPrice: BigInt(integer(row.tp)) }),
      ...(row.lp === undefined ? {} : { linkedPosition: integer(row.lp) }),
    };
  });
  for (const rows of [parsedPositions, parsedOrders])
    if (
      new Set(rows.map((row) => `${row.market.marketId}:${row.id}`)).size !==
      rows.length
    )
      throw Error("Duplicate exposure in Perpl trading snapshot.");
  if (
    new Set(parsedPositions.map((row) => row.market.marketId)).size !==
    parsedPositions.length
  )
    throw Error("Multiple positions in one market require reconciliation.");
  const sources = [
    { name: "Wallet", block: wallet.block, time: wallet.time },
    { name: "Positions", block: positions.block, time: positions.time },
    { name: "Orders", block: orders.block, time: orders.time },
    {
      name: "Finalized chain",
      block: Number(chain.block),
      time: chain.blockTime,
    },
  ];
  if (
    !Number.isSafeInteger(Number(chain.block)) ||
    now - chain.blockTime > maximumAge ||
    chain.blockTime > now + 2000 ||
    Math.max(...sources.map((s) => s.time)) -
      Math.min(...sources.map((s) => s.time)) >
      25_000
  )
    throw Error("Trading snapshots are too far apart. Refresh to reconcile.");
  const balance = amount(account.b);
  const locked = amount(account.lb);
  const free = balance > locked ? balance - locked : 0n;
  const observed = chain.exchangeAccount;
  const reconciled =
    !!observed &&
    observed.id === BigInt(accountId) &&
    observed.balance === balance &&
    observed.free === free &&
    observed.locked === locked &&
    (observed.frozen !== 0) === account.fr &&
    observed.hasPosition === parsedPositions.length > 0;
  return {
    owner: getAddress(owner),
    accountId,
    balance,
    free,
    locked,
    forwarding: account.fw,
    frozen: account.fr,
    feeTier: integer(account.ft),
    lastRequestId: integer(account.lfr),
    markets,
    restrictions: { ...chain.funding },
    positions: parsedPositions,
    orders: parsedOrders,
    sources,
    receivedAt: now,
    reconciled,
    ...(reconciled
      ? {}
      : {
          discrepancy:
            "API account balances or exposure differ from the finalized chain. Refresh before trading.",
        }),
  };
}

export function tradingStateFresh(state: TradingState, now = Date.now()) {
  return (
    now - state.receivedAt <= maximumAge &&
    state.sources.every(
      (source) => now - source.time <= maximumAge && source.time <= now + 2000,
    )
  );
}

export async function readTradingState(
  owner: string,
  read: (
    route: "wallet" | "positions" | "orders",
    signal?: AbortSignal,
  ) => Promise<unknown>,
  options: {
    fetcher?: typeof fetch;
    readChain?: typeof readTestnetAccount;
    signal?: AbortSignal;
  } = {},
) {
  options.signal?.throwIfAborted();
  const [wallet, positions, orders, context, chain] = await Promise.all([
    read("wallet", options.signal),
    read("positions", options.signal),
    read("orders", options.signal),
    (async () => {
      const response = await (options.fetcher ?? fetch)(
        "/perpl-public/v1/pub/context",
        {
          credentials: "omit",
          signal: options.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(12_000)])
            : AbortSignal.timeout(12_000),
        },
      );
      if (!response.ok) throw Error("Market configuration is unavailable.");
      return response.json();
    })(),
    (options.readChain ?? readTestnetAccount)(owner, {
      signal: options.signal,
    }),
  ]);
  options.signal?.throwIfAborted();
  return normalizeTradingState(
    owner,
    { wallet, positions, orders, context },
    chain,
  );
}
