import { describe, expect, it } from "vitest";
import { closedTrades } from "./perpl-trade-history";
import type { HistoryRow, OrderHistory } from "./perpl-order-history";

const row = (over: Partial<HistoryRow>): HistoryRow => ({
  block: 200,
  account: 1057,
  market: 32,
  order: 50,
  request: 20,
  type: 3,
  status: 5,
  reason: 0,
  size: 10,
  filled: 10,
  price: 250000,
  fee: "0",
  ...over,
});

// One position closed by order 50 (or no order), with fills at 2 prices to check weighting.
function trade(side: 1 | 2, order: number, orderRow?: Partial<HistoryRow>) {
  const close = row({
    order,
    positionId: 7,
    side,
    status: 2,
    reason: 13,
    fee: "17",
    closeFee: "8",
    pnl: "1000",
    funding: "-5",
  });
  const history: OrderHistory = {
    orders: orderRow ? [row({ linkedPosition: 7, ...orderRow })] : [],
    fills: [
      row({ filled: 4, price: 300000 }),
      row({ filled: 6, price: 310000 }),
    ],
    accounts: [],
    positions: [
      row({ positionId: 7, side, status: 1, reason: 21, order: 1 }),
      close,
    ],
    complete: true,
  };
  return closedTrades(history);
}

describe("closed trade history", () => {
  it.each([
    ["long take profit", 1, 3, "tp"],
    ["long stop", 1, 4, "sl"],
    ["short take profit", 2, 4, "tp"],
  ] as const)("classifies a %s from its trigger", (_, side, tpc, reason) => {
    const [t, ...rest] = trade(side, 50, { triggerCondition: tpc });
    expect(rest).toHaveLength(0);
    expect(t).toMatchObject({
      reason,
      final: true,
      pnl: 1000n,
      funding: -5n,
      fees: 17n,
      net: 978n,
      exitPrice: 306000,
    });
  });
  it("labels liquidation only on Perpl's own codes, and reports what was returned", () => {
    // A close whose order row has not been indexed yet is an ordinary close.
    expect(trade(1, 0)[0]).toMatchObject({ reason: "manual", net: 978n });
    expect(trade(1, 50, {})[0].reason).toBe("manual");
    const liquidated = row({
      order: 0,
      positionId: 7,
      side: 1,
      status: 3,
      reason: 19,
      fee: "17",
      closeFee: "8",
      pnl: "-900",
      funding: "0",
    });
    const history: OrderHistory = {
      orders: [],
      fills: [],
      accounts: [row({ type: 5, order: 0, positionId: 7, amount: "120" })],
      positions: [liquidated],
      complete: true,
    };
    expect(closedTrades(history)[0]).toMatchObject({
      reason: "liq",
      final: true,
      returned: 120n,
    });
  });
});
