import {
  managementUnresolved,
  type Journal,
  type OrderOperation,
  type LifecycleCompletion,
} from "./order-journal";
import type { OrderHistory } from "./perpl-order-history";
import type { TradingState } from "./perpl-trading-state";

/**
 * Settles one entry from Perpl's own record that its position ended, however it ended:
 * a manual close, a stop or target trigger, or a liquidation.
 *
 * Positive evidence only. The position must be absent from a fresh reconciled snapshot
 * AND signed position history must hold exactly one terminal event for that position id,
 * at a block every snapshot source has reached. Absence alone never settles.
 */
export function reconcileLifecycleCompletion(
  journal: Journal,
  entry: OrderOperation,
  state: TradingState,
  history: OrderHistory,
): LifecycleCompletion | null {
  const pid = entry.positionId;
  if (
    !pid ||
    !entry.settlement ||
    !entry.filled ||
    !history.complete ||
    state.positions.some(
      (p) => p.market.marketId === entry.payload.mkt && p.id === pid,
    )
  )
    return null;
  const events = (history.positions ?? []).filter(
    (r) =>
      r.account === journal.accountId &&
      r.market === entry.payload.mkt &&
      r.positionId === pid &&
      r.side === entry.payload.t,
  );
  // Status 1 is an open position (opened or decreased). Anything else ended it.
  // 2 closed, 3 liquidated, 4 deleveraged, 5 unwound. 6 is a failed open, not an end.
  const ended = events.filter((r) => [2, 3, 4, 5].includes(r.status));
  const opened = events.filter((r) => r.status === 1 && r.reason === 21);
  const end = ended[0];
  if (
    ended.length !== 1 ||
    opened.length !== 1 ||
    !end.hash ||
    end.block < entry.settlement.block ||
    state.sources.some((s) => s.block < end.block) ||
    state.lastRequestId < entry.payload.rq
  )
    return null;
  let pnl = 0n,
    funding = 0n,
    fees = BigInt(opened[0].fee);
  for (const event of events) {
    if (event === opened[0]) continue;
    // Every reduction must carry its settled amounts; a missing field is not zero.
    if (
      event.pnl === undefined ||
      event.funding === undefined ||
      event.closeFee === undefined
    )
      return null;
    pnl += BigInt(event.pnl);
    funding += BigInt(event.funding);
    fees += BigInt(event.closeFee);
  }
  // The position no longer exists, so nothing recorded against it can still act on it.
  // A sent close, cancel or collateral request is left to its own reconcile: history can
  // show the position's end before it indexes the close that ended it, and only a request
  // that was never sent may be called discarded.
  for (const op of journal.management ?? []) {
    if (op.positionId !== pid || op.payload.mkt !== entry.payload.mkt) continue;
    const protective = op.payload.tp !== undefined && op.payload.t !== 5;
    if (protective && (op.phase === "observed" || managementUnresolved(op)))
      op.phase = "cancelled";
    else if (op.phase === "prepared") op.phase = "discarded";
  }
  return {
    positionId: pid,
    hash: end.hash,
    block: end.block,
    orderId: end.order,
    balance: state.balance.toString(),
    locked: state.locked.toString(),
    pnl: pnl.toString(),
    funding: funding.toString(),
    fees: fees.toString(),
  };
}
