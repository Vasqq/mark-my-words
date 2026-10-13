import type { PublicDraft } from "./public-draft";
import { parseAbi } from "viem";
import { ceil, U, type Intent } from "./financial-model";
import { maxLeverage, testnetLimits } from "./testnet-limits";
import {
  observationFresh,
  type PublicMarketObservation,
} from "./perpl-market-data";
import {
  testnet,
  testnetClient,
  type TestnetReadOptions,
} from "./testnet-config";

export interface LiveSize {
  lots: bigint; // Protocol LNS, not micro base assets.
  quantity: bigint;
  notional: bigint;
  entry: bigint;
  limit: bigint;
  targetGross: bigint;
  stopGross: bigint;
}

/** The entry's price bound: 0.1% past the mark, on the tick grid, never wider. */
export function entryLimit(
  side: PublicDraft["side"],
  mark: bigint,
  tick: bigint,
): bigint {
  const bps = testnetLimits.entryBoundBps;
  return side === "long"
    ? ((mark * (10000n + bps)) / 10000n / tick) * tick
    : ceil(mark * (10000n - bps), 10000n * tick) * tick;
}

/** Smallest quantity reaching the gross goal in the observed, price-bounded book. */
export function sizeLiveIntent(
  intent: PublicDraft,
  observation: PublicMarketObservation,
  now = Date.now(),
): LiveSize {
  const { metadata, mark } = observation;
  if (!observationFresh(observation, now))
    throw Error("Refresh stale market data before sizing.");
  if (metadata.symbol !== intent.market)
    throw Error(`Select ${intent.market} to review the current sentence.`);
  if (!metadata.open) throw Error("This market is closed to new entries.");
  if (intent.goal <= 0n || intent.target <= 0n || intent.stop <= 0n)
    throw Error("Goal, target and stop must be positive.");
  if (
    intent.leverage < 100n ||
    intent.leverage > maxLeverage(metadata.marketId)
  )
    throw Error(
      "Choose leverage between 1x and Perpl's maximum for this market.",
    );
  const { tick, lot } = metadata;
  // ETH and BTC currently settle each price-tick × quantity-lot in exact micro-AUSD.
  if ((tick * lot) % U !== 0n)
    throw Error("Unsupported market precision for exact sizing.");
  if (intent.target % tick || intent.stop % tick)
    throw Error("Target and stop must match the market price tick.");
  const direction = intent.side === "long" ? 1n : -1n;
  if (
    direction * (intent.target - mark) <= 0n ||
    direction * (mark - intent.stop) <= 0n
  )
    throw Error(
      "Move the target beyond the live mark and the stop to the opposite side.",
    );
  const limit = entryLimit(intent.side, mark, tick);
  // The journal's bracket rule compares the target with the limit, not the mark.
  if (direction * (intent.target - limit) <= 0n)
    throw Error("Move the target at least 0.1% beyond the live price.");
  let lots = 0n,
    notional = 0n,
    payoff = 0n;
  for (const level of intent.side === "long"
    ? observation.asks
    : observation.bids) {
    if (direction * (level.price - limit) > 0n) break;
    const cost = (level.price * lot) / U;
    const gain = direction * ((intent.target * lot) / U - cost);
    // Payoff can stop increasing after entry prices cross the target. Search only
    // within this level's linear segment; never binary-search the whole book.
    if (gain > 0n) {
      const needed = ceil(intent.goal - payoff, gain);
      if (needed <= level.lots) {
        lots += needed;
        notional += needed * cost;
        const quantity = lots * lot;
        const stopGross = direction * ((intent.stop * quantity) / U - notional);
        if (stopGross >= 0n)
          throw Error(
            "The stop must remain beyond the estimated entry on the loss side.",
          );
        if (lots > BigInt(Number.MAX_SAFE_INTEGER))
          throw Error("Quantity exceeds the API's exact integer range.");
        return {
          lots,
          quantity,
          notional,
          entry: (notional * U) / quantity,
          limit,
          targetGross: direction * ((intent.target * quantity) / U - notional),
          stopGross,
        };
      }
    }
    lots += level.lots;
    notional += level.lots * cost;
    payoff += level.lots * gain;
  }
  throw Error(
    "The observed depth within 0.1% of mark cannot reach this gross goal. Lower the goal or move the target.",
  );
}

// Read-only subset of Perpl's Exchange ABI, dex-sdk 78ce8a06.
export const sizingAbi = parseAbi([
  "function getMarginFractions(uint256 perpId, uint256 lotLNS) view returns (uint256 perpInitMarginFracHdths, uint256 perpMaintMarginFracHdths, uint256 dynamicInitMarginFracHdths, uint256 oiMaxLNS, uint256 unityDescentThreshHdths, uint256 overColDescentThreshHdths)",
]);
export interface LiveSizingReview<T extends PublicDraft = Intent> {
  size: LiveSize;
  observation: PublicMarketObservation;
  intent: T;
  block: bigint;
  blockTime: number;
  dynamicLeverage: bigint; // Hundredths, not basis points of collateral.
  maintenanceFactor: bigint;
  baseMargin: bigint; // Excludes adverse-mark top-up, fees and funding.
}
export function sizingReviewFresh(
  review: LiveSizingReview<PublicDraft>,
  now = Date.now(),
) {
  return (
    observationFresh(review.observation, now) &&
    now - review.blockTime < 30000 &&
    review.blockTime <= now + 2000
  );
}

/** Public reads only. A sizing review is not account admission or an execution quote. */
async function reviewSizing<T extends PublicDraft>(
  intent: T,
  observation: PublicMarketObservation,
  options: TestnetReadOptions = {},
): Promise<LiveSizingReview<T>> {
  const size = sizeLiveIntent(intent, observation);
  const client = testnetClient(options);
  if ((await client.getChainId()) !== 10143)
    throw Error("RPC is not Monad testnet. Sizing stopped.");
  const block = await client.getBlock({ blockTag: "finalized" });
  if (!block.hash || block.number === null)
    throw Error("Finalized margin data unavailable.");
  const blockTime = Number(block.timestamp) * 1000;
  // Compare when each was read: Perpl's change stamps say nothing about read time.
  const sourceTimes = [blockTime, observation.receivedAt];
  if (Math.max(...sourceTimes) - Math.min(...sourceTimes) > 25000)
    throw Error(
      "Market and margin observations are too far apart. Refresh and try again.",
    );
  const [base, maintenance, dynamic] = await client.readContract({
    address: testnet.exchange,
    abi: sizingAbi,
    functionName: "getMarginFractions",
    args: [BigInt(observation.metadata.marketId), size.lots],
    blockNumber: block.number,
  });
  if (
    base !== BigInt(observation.metadata.initialMarginFactor) ||
    maintenance !== BigInt(observation.metadata.maintenanceMarginFactor)
  )
    throw Error("Market configuration changed. Refresh before reviewing size.");
  if (maintenance === 0n || dynamic === 0n || dynamic > base)
    throw Error("Margin limits do not support this sizing review.");
  const review: LiveSizingReview<T> = {
    size,
    observation,
    intent: { ...intent },
    block: block.number,
    blockTime,
    dynamicLeverage: dynamic,
    maintenanceFactor: maintenance,
    baseMargin: ceil(size.notional * 100n, intent.leverage),
  };
  options.signal?.throwIfAborted();
  if (!sizingReviewFresh(review))
    throw Error(
      "Sizing expired while reading margin limits. Refresh and try again.",
    );
  return review;
}

export function reviewLiveSizing(
  intent: Intent,
  observation: PublicMarketObservation,
  options: TestnetReadOptions = {},
): Promise<LiveSizingReview> {
  return reviewSizing(intent, observation, options);
}
export function reviewPublicSizing(
  draft: PublicDraft,
  observation: PublicMarketObservation,
  options: TestnetReadOptions = {},
): Promise<LiveSizingReview<PublicDraft>> {
  return reviewSizing(draft, observation, options);
}
