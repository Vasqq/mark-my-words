import type { HistoryRow, OrderHistory } from "./perpl-order-history";

export type CloseReason = "tp" | "sl" | "liq" | "manual";
/** One position reduction or close, taken only from signed Perpl history. Native units. */
export interface ClosedTrade {
  id: string;
  marketId: number;
  positionId: number;
  side: "long" | "short";
  lots: number;
  entryPrice: number; // ticks
  exitPrice?: number; // ticks, size-weighted over the closing order's fills
  pnl: bigint; // micro AUSD, before funding and fees
  funding: bigint;
  fees: bigint; // close fee plus the entry fee released by this event
  net: bigint;
  reason: CloseReason;
  final: boolean; // true when this event ended the position
  returned?: bigint; // liquidation only: what Perpl paid back to the account, micro AUSD
  block: number;
  time?: number;
}

// Perpl's documented enums. PositionStatus: 1 open, 2 closed, 3 liquidated, 4 deleveraged,
// 5 unwound. PositionStatusReason: 21 opened, 14 decreased, 13 closed, 19 liquidated.
// AccountEventType: 5 liquidation.
const OPENED = 21;
const LIQUIDATED_STATUS = 3;
const LIQUIDATED_REASON = 19;
const LIQUIDATION_EVENT = 5;
/** The account-history liquidation row for this position event, if Perpl recorded one. */
const liquidation = (event: HistoryRow, history: OrderHistory) =>
  history.accounts.find(
    (r) =>
      r.type === LIQUIDATION_EVENT &&
      r.account === event.account &&
      r.block === event.block &&
      (!r.market || r.market === event.market) &&
      (!r.positionId || r.positionId === event.positionId),
  );

function reason(event: HistoryRow, history: OrderHistory): CloseReason {
  if (
    event.status === LIQUIDATED_STATUS ||
    event.reason === LIQUIDATED_REASON ||
    liquidation(event, history)
  )
    return "liq";
  const long = event.side === 1;
  // A long's exits are type 3: condition 3 fires at or above the trigger (target),
  // condition 4 at or below (stop). A short's exits are type 4 with the two reversed.
  const leg = (condition: number): CloseReason =>
    (condition === 3) === long ? "tp" : "sl";
  const mine = history.orders.filter(
    (r) => r.account === event.account && r.market === event.market,
  );
  // A fired trigger closes through a child order with its own id. The linked trigger
  // itself is marked triggered (9) or done (10) in the same block.
  const fired = mine.find(
    (r) =>
      r.linkedPosition === event.positionId &&
      r.triggerCondition !== undefined &&
      [9, 10].includes(r.status) &&
      r.block === event.block,
  );
  if (fired) return leg(fired.triggerCondition!);
  const order = mine.find((r) => r.order === event.order);
  if (
    order?.triggerCondition !== undefined &&
    order.linkedPosition === event.positionId
  )
    return leg(order.triggerCondition);
  // Liquidation needs Perpl to say so. A lagging order row is still an ordinary close.
  return "manual";
}

/** Newest first. Events without settled profit fields are skipped, never shown as zero. */
export function closedTrades(history: OrderHistory): ClosedTrade[] {
  const trades: ClosedTrade[] = [];
  for (const event of history.positions ?? []) {
    if (
      event.reason === OPENED ||
      !event.positionId ||
      !event.size ||
      event.pnl === undefined ||
      event.funding === undefined ||
      event.closeFee === undefined ||
      (event.side !== 1 && event.side !== 2)
    )
      continue;
    const fills = history.fills.filter(
      (r) =>
        r.account === event.account &&
        r.market === event.market &&
        r.order === event.order &&
        r.block === event.block &&
        event.order > 0,
    );
    const filled = fills.reduce((sum, r) => sum + r.filled, 0);
    const paid = liquidation(event, history);
    const pnl = BigInt(event.pnl);
    const funding = BigInt(event.funding);
    const fees =
      BigInt(event.fee) > BigInt(event.closeFee)
        ? BigInt(event.fee)
        : BigInt(event.closeFee);
    trades.push({
      id: `${event.market}:${event.positionId}:${event.block}:${event.log ?? 0}:${event.order}`,
      marketId: event.market,
      positionId: event.positionId,
      side: event.side === 1 ? "long" : "short",
      lots: event.size,
      entryPrice: event.price,
      ...(filled > 0
        ? {
            exitPrice: Number(
              fills.reduce(
                (sum, r) => sum + BigInt(r.price) * BigInt(r.filled),
                0n,
              ) / BigInt(filled),
            ),
          }
        : {}),
      pnl,
      funding,
      fees,
      net: pnl + funding - fees,
      reason: reason(event, history),
      final: event.status !== 1,
      ...(paid?.amount === undefined ? {} : { returned: BigInt(paid.amount) }),
      block: event.block,
      ...(event.time === undefined ? {} : { time: event.time }),
    });
  }
  return trades.sort((a, b) => b.block - a.block);
}
