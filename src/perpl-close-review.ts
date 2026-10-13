import { accountFee } from "./perpl-trade-review";
import { ceil, fee, U } from "./financial-model";
import {
  observationFresh,
  type PublicMarketObservation,
} from "./perpl-market-data";
import {
  assertManagementState,
  type ManagementAction,
  type PositionRisk,
} from "./perpl-lifecycle";
import type { TradingState } from "./perpl-trading-state";

/** Exact opposing-depth preview. Unknown attribution never prevents bounded reduce-only recovery. */
export function assessCloseReview(
  owner: string,
  state: TradingState,
  positionId: number,
  observation: PublicMarketObservation,
  percent: 25 | 50 | 100,
  risk?: PositionRisk,
  now = Date.now(),
) {
  assertManagementState(owner, state, now);
  const position = state.positions.find(
    (p) =>
      p.id === positionId &&
      p.market.marketId === observation.metadata.marketId,
  );
  if (!position || !observationFresh(observation, now))
    throw Error(
      "Refresh actual residual exposure and opposing depth before closing.",
    );
  const m = position.market;
  if (
    m.configBlock !== observation.metadata.configBlock ||
    m.contextVersion !== observation.metadata.contextVersion ||
    m.tick !== observation.metadata.tick ||
    m.lot !== observation.metadata.lot
  )
    throw Error("Position and book configuration changed.");
  if (![25, 50, 100].includes(percent))
    throw Error("Unsupported close fraction.");
  const lots =
    percent === 100 ? position.size : (position.size * BigInt(percent)) / 100n;
  if (lots <= 0n || (percent !== 100 && lots >= position.size))
    throw Error(
      "This fraction does not leave a native residual lot. Review full close.",
    );
  const long = position.side === "Long";
  const bound = long
    ? ceil(observation.mark * 9950n, 10000n * m.tick) * m.tick
    : ((observation.mark * 10050n) / (10000n * m.tick)) * m.tick;
  let left = lots,
    notional = 0n;
  for (const level of long ? observation.bids : observation.asks) {
    if (long ? level.price < bound : level.price > bound) break;
    const take = left < level.lots ? left : level.lots;
    notional += (level.price * take * m.lot) / U;
    left -= take;
    if (!left) break;
  }
  if (left)
    throw Error(
      "Opposing depth within the 0.5% bound cannot preview this amount. Lower the close fraction or refresh; no unbounded order is offered.",
    );
  const rate = accountFee(m, state.feeTier);
  const quantity = lots * m.lot;
  const entryQ16 =
    (position.entryPrice - (long && position.entryResidueQ16 ? 1n : 0n)) *
      65536n +
    BigInt(position.entryResidueQ16);
  const entryNumerator = entryQ16 * m.tick * quantity;
  const entryNotional = long
    ? ceil(entryNumerator, 65536n * U)
    : entryNumerator / (65536n * U);
  const gross = (long ? 1n : -1n) * (notional - entryNotional);
  // Snapshot fees are the outstanding entry share, not cumulative realized event fees.
  const entryFee =
    percent === 100
      ? position.fees
      : position.fees < 0n
        ? (position.fees * lots) / position.size
        : ceil(position.fees * lots, position.size);
  const exitFee = fee(notional, rate);
  const riskMatches =
    !!risk &&
    risk.block > 0n &&
    Math.max(risk.blockTime, ...state.sources.map((source) => source.time)) -
      Math.min(risk.blockTime, ...state.sources.map((source) => source.time)) <=
      10000 &&
    now - risk.blockTime < 30000 &&
    risk.blockTime <= now + 2000 &&
    risk.accountId === state.accountId &&
    risk.positionId === position.id &&
    risk.marketId === m.marketId &&
    risk.size === position.size &&
    risk.entryPrice === position.entryPrice &&
    risk.entryResidueQ16 === position.entryResidueQ16 &&
    risk.collateral === position.collateral &&
    risk.side === position.side;
  const funding = riskMatches
    ? (risk!.premiumPnl * lots) / position.size
    : undefined;
  const net =
    funding === undefined ? undefined : gross + funding - entryFee - exitFee;
  const releasedCollateral = (position.collateral * lots) / position.size;
  const back =
    funding === undefined
      ? undefined
      : releasedCollateral + gross + funding - exitFee;
  const price = Number(bound / m.tick);
  const size = Number(lots);
  if (!Number.isSafeInteger(price) || !Number.isSafeInteger(size) || price <= 0)
    throw Error("Close exceeds native exact integer bounds.");
  const action: ManagementAction =
    percent === 100
      ? { kind: "close", marketId: m.marketId as 16 | 32, positionId, price }
      : {
          kind: "partial-close",
          marketId: m.marketId as 16 | 32,
          positionId,
          price,
          size,
        };
  return {
    action,
    lots,
    quantity,
    bound,
    entry: (notional * U) / quantity,
    gross,
    entryFee,
    exitFee,
    fees: entryFee + exitFee,
    funding,
    net,
    back,
    remaining: position.size - lots,
    reason:
      funding === undefined
        ? "Finalized funding attribution unavailable · bounded reduce-only recovery remains available."
        : undefined,
  };
}
