import { bindAccountAllowance } from "./public-draft";
import { getAddress } from "viem";
import { ceil, fee, U, type Intent } from "./financial-model";
import {
  normalizeObservation,
  type PublicMarketMetadata,
  type PublicMarketObservation,
} from "./perpl-market-data";
import {
  readTradingState,
  tradingStateFresh,
  type TradingState,
} from "./perpl-trading-state";
import {
  reviewLiveSizing,
  sizingReviewFresh,
  type LiveSizingReview,
} from "./perpl-sizing";

const max = (a: bigint, b: bigint) => (a > b ? a : b);
export const entryNegativePnlBps = 50n;
export interface TradeReview {
  sizing: LiveSizingReview;
  account: TradingState;
  feePpm: bigint;
  entryFee: bigint;
  estimatedCollateral: bigint;
  estimatedDebit: bigint;
  fundingAllowance: bigint;
  entryNotionalCeiling: bigint;
  liquidation: bigint;
  stopBoundary: bigint;
  targetAfterFees: bigint;
  stopAfterFees: bigint;
  fundingShortfall: bigint;
  budgetShortfall: bigint;
  blockers: string[];
}

export function accountFee(metadata: PublicMarketMetadata, tier: number) {
  const rate =
    metadata.takerFeeTiersPpm?.[tier] ??
    (tier === 0 && !metadata.takerFeeTiersPpm
      ? metadata.baseTakerFeePpm
      : undefined);
  if (rate === undefined || rate < 0n || rate > 100000n)
    throw Error(
      "This account's taker fee could not be verified. Refresh before trading.",
    );
  return rate;
}

/**
 * The money side of one sized entry, from inputs that may be public (base fee, market
 * maintenance factor) or account-specific. Pure and exact; it authorizes nothing.
 */
export function tradeEconomics(
  intent: Pick<Intent, "side" | "leverage" | "stop" | "target">,
  size: LiveSizingReview["size"],
  mark: bigint,
  tick: bigint,
  feePpm: bigint,
  maintenanceFactor: bigint,
) {
  const direction = intent.side === "long" ? 1n : -1n;
  const markNotional = (size.quantity * mark) / U;
  const topUp = max(0n, direction * (size.notional - markNotional));
  const estimatedCollateral =
    ceil(size.notional * 100n, intent.leverage) + topUp;
  const entryFee = fee(size.notional, feePpm);
  const estimatedDebit = estimatedCollateral + entryFee;
  const maintenance = ceil(size.notional * 100n, maintenanceFactor);
  const liquidationNumerator =
    (size.notional + direction * (maintenance - estimatedCollateral)) * U;
  const liquidation = max(
    0n,
    intent.side === "long"
      ? ceil(max(0n, liquidationNumerator), size.quantity)
      : liquidationNumerator / size.quantity,
  );

  // A long limit caps entry notional. A short limit is only a lower price bound, so
  // a short is committed at its stop price: no sell can fill above the stop while the
  // stop sits above the mark, and a stopped short loses no more than that.
  const allowanceNotional =
    intent.side === "long"
      ? (size.quantity * size.limit) / U
      : ceil(size.quantity * max(intent.stop, size.limit), U);
  const roundedNotional = allowanceNotional + ceil(size.quantity * tick, U);
  const fundingAllowance =
    ceil(roundedNotional * 100n, intent.leverage) +
    ceil(roundedNotional * entryNegativePnlBps, 10000n) +
    fee(roundedNotional, feePpm);
  const entryNotionalCeiling = allowanceNotional;
  const worstNotional = (size.quantity * size.limit) / U;
  // Ignore beneficial mark top-up when checking the stop at the adverse entry bound.
  const worstEquity =
    worstNotional +
    direction *
      (ceil(worstNotional * 100n, maintenanceFactor) -
        (worstNotional * 100n) / intent.leverage);
  const worstLiquidation = max(
    0n,
    intent.side === "long"
      ? ceil(max(0n, worstEquity) * U, size.quantity)
      : (worstEquity * U) / size.quantity,
  );
  const stopBuffer = max(ceil(mark, 100n), tick);
  const stopBoundary = worstLiquidation + direction * stopBuffer;
  return {
    topUp,
    estimatedCollateral,
    entryFee,
    estimatedDebit,
    liquidation,
    fundingAllowance,
    entryNotionalCeiling,
    stopBoundary,
    targetAfterFees:
      size.targetGross -
      entryFee -
      fee((size.quantity * intent.target) / U, feePpm),
    stopAfterFees:
      size.stopGross -
      entryFee -
      fee((size.quantity * intent.stop) / U, feePpm),
  };
}

/** Financial review only; it never authorizes a POST or assumes protection exists. */
export function assessTradeReview(
  owner: string,
  sizing: LiveSizingReview,
  account: TradingState,
  now = Date.now(),
): TradeReview {
  if (getAddress(owner) !== getAddress(account.owner))
    throw Error("The review belongs to another wallet.");
  if (!sizingReviewFresh(sizing, now) || !tradingStateFresh(account, now))
    throw Error("Trade review data is stale. Refresh before continuing.");
  const times = [
    ...account.sources.map((s) => s.time),
    sizing.blockTime,
    // When the market was read, not when Perpl last changed it (a quiet book is not old).
    sizing.observation.receivedAt,
  ];
  if (Math.max(...times) - Math.min(...times) > 25000)
    throw Error(
      "Account, book and margin reads are too far apart. Refresh together.",
    );
  const { intent, size, observation, maintenanceFactor, dynamicLeverage } =
    sizing;
  const metadata = account.markets.find((m) => m.symbol === intent.market);
  if (
    !metadata ||
    metadata.marketId !== observation.metadata.marketId ||
    metadata.instanceId !== observation.metadata.instanceId ||
    // Not configBlock: Perpl's servers stamp the same context version with different
    // config blocks, so two reads of an unchanged config can disagree on it.
    metadata.contextVersion !== observation.metadata.contextVersion ||
    metadata.tick !== observation.metadata.tick ||
    metadata.lot !== observation.metadata.lot
  )
    throw Error(
      "Account and sizing market configuration differ. Refresh together.",
    );
  const feePpm = accountFee(metadata, account.feeTier);
  const {
    topUp,
    estimatedCollateral,
    entryFee,
    estimatedDebit,
    liquidation,
    fundingAllowance,
    entryNotionalCeiling,
    stopBoundary,
  } = tradeEconomics(
    intent,
    size,
    observation.mark,
    metadata.tick,
    feePpm,
    maintenanceFactor,
  );
  const required = max(fundingAllowance, estimatedDebit);
  const fundingShortfall = max(0n, required - account.free);
  const budgetShortfall = max(0n, required - intent.budget);
  const blockers: string[] = [];
  if (!metadata.open)
    blockers.push(
      "This market is closed to new entries. Existing exposure and recovery remain available.",
    );
  if (!account.reconciled)
    blockers.push(
      "Account balances or exposure have not reconciled with finalized chain state.",
    );
  if (!account.forwarding)
    blockers.push("Enable order forwarding before submitting API orders.");
  if (account.frozen || account.restrictions.addressBlocked)
    blockers.push("This account is restricted by the Exchange.");
  if (account.restrictions.halted) blockers.push("The Exchange is halted.");
  if (
    account.restrictions.whitelistEnabled &&
    !account.restrictions.whitelisted
  )
    blockers.push("This wallet is not on the Exchange allowlist.");
  if (account.positions.some((p) => p.market.marketId === metadata.marketId))
    blockers.push(
      "This market already has a net position. Increasing or reversing it needs a separate review.",
    );
  if (account.orders.some((o) => o.market.marketId === metadata.marketId))
    blockers.push(
      "This market has open orders. Reconcile them before a new entry.",
    );
  if (intent.leverage > dynamicLeverage)
    blockers.push("Selected leverage exceeds the size-specific margin limit.");
  if (topUp > ceil(size.notional * entryNegativePnlBps, 10000n))
    blockers.push(
      "Observed entry requires more than the 0.5% negative-PnL collateral allowance.",
    );
  if ((intent.side === "long" ? 1n : -1n) * (intent.stop - stopBoundary) <= 0n)
    blockers.push(
      "Move the stop farther from liquidation or lower leverage. The review requires a 1% mark-price buffer.",
    );
  if (fundingShortfall)
    blockers.push(
      "Available exchange collateral is below the reviewed funding allowance.",
    );
  if (budgetShortfall)
    blockers.push(
      "The reviewed funding allowance exceeds the sentence budget.",
    );
  return {
    sizing,
    account,
    feePpm,
    entryFee,
    estimatedCollateral,
    estimatedDebit,
    fundingAllowance,
    entryNotionalCeiling,
    liquidation,
    stopBoundary,
    targetAfterFees:
      size.targetGross -
      entryFee -
      fee((size.quantity * intent.target) / U, feePpm),
    stopAfterFees:
      size.stopGross -
      entryFee -
      fee((size.quantity * intent.stop) / U, feePpm),
    fundingShortfall,
    budgetShortfall,
    blockers,
  };
}

export function tradeReviewFresh(review: TradeReview, now = Date.now()) {
  return (
    sizingReviewFresh(review.sizing, now) &&
    tradingStateFresh(review.account, now)
  );
}

export async function readTradeReview(
  owner: string,
  intent: Intent,
  read: Parameters<typeof readTradingState>[1],
  options: {
    fetcher?: typeof fetch;
    readAccount?: typeof readTradingState;
    readSizing?: (
      intent: Intent,
      observation: PublicMarketObservation,
      options?: Parameters<typeof reviewLiveSizing>[2],
    ) => Promise<LiveSizingReview>;
    signal?: AbortSignal;
    observation?: PublicMarketObservation;
  } = {},
) {
  options.signal?.throwIfAborted();
  const account = await (options.readAccount ?? readTradingState)(owner, read, {
    fetcher: options.fetcher,
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  const metadata = account.markets.find((m) => m.symbol === intent.market);
  if (!metadata)
    throw Error("The selected market is unavailable for this account.");
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(12000)])
    : AbortSignal.timeout(12000);
  const fetchData = async (suffix: string) => {
    const response = await (options.fetcher ?? fetch)(
      `/perpl-public/v1/market-data/${metadata.marketId}/${suffix}`,
      { credentials: "omit", cache: "no-store", signal },
    );
    if (!response.ok)
      throw Error("Live market data is unavailable for the account review.");
    return response.json() as Promise<unknown>;
  };
  const observation =
    options.observation ??
    (await (async () => {
      const [ticker, book] = await Promise.all([
        fetchData("ticker"),
        fetchData("book?levels=100"),
      ]);
      return normalizeObservation(metadata, ticker, book, Date.now());
    })());
  const sizing = await (options.readSizing ?? reviewLiveSizing)(
    intent,
    observation,
    { signal },
  );
  signal.throwIfAborted();
  return assessTradeReview(owner, sizing, account);
}

/** Bind public sizing to fresh authenticated spendable collateral; never to a fixture allowance. */
export function assessPublicTradeReview(
  owner: string,
  sizing: LiveSizingReview<import("./public-draft").PublicDraft>,
  account: TradingState,
  now = Date.now(),
): TradeReview {
  const intent = bindAccountAllowance(sizing.intent, account.free);
  const review = assessTradeReview(owner, { ...sizing, intent }, account, now);
  // The consumer has no user budget. Its single financial limit is observed free collateral.
  return {
    ...review,
    blockers: review.blockers.filter(
      (reason) =>
        reason !==
        "The reviewed funding allowance exceeds the sentence budget.",
    ),
  };
}
