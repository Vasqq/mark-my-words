import { describe, expect, it } from "vitest";
import { entryPrice, estimatePosition } from "./perpl-position-estimate";

// ETH-like units: tick $0.01 (10_000 micro AUSD), lot 0.001 (1_000 micro ETH).
const base = {
  size: 8n,
  entryPrice: 250000n, // $2,500.00
  entryResidueQ16: 0,
  collateral: 6_666_667n, // 3x on $20 notional
  tick: 10_000n,
  lot: 1_000n,
  feesPaid: 7_000n,
};

describe("open position estimate", () => {
  it("values a long and a short at the mark, after the fee already paid and the fee to close", () => {
    const long = estimatePosition(
      { ...base, side: "Long" },
      2_600_000_000n, // mark $2,600
      350n,
      2000n,
    );
    // 0.008 ETH x $100 = $0.80 gross; close fee = ceil(20.8 x 350 ppm) = 7280 micro.
    expect(long.gross).toBe(800_000n);
    expect(long.net).toBe(800_000n - 7_000n - 7_280n);
    expect(long.leverage).toBe(300n);
    const short = estimatePosition(
      { ...base, side: "Short" },
      2_600_000_000n,
      350n,
      2000n,
    );
    expect(short.gross).toBe(-800_000n);
  });

  it("puts liquidation below a long and above a short, by collateral less maintenance", () => {
    // Maintenance = ceil(20 x 100 / 2000) = $1. A long loses $5.666667 before that: $708.33 per ETH.
    const long = estimatePosition(
      { ...base, side: "Long" },
      2_500_000_000n,
      350n,
      2000n,
    );
    expect(long.liquidation).toBe(1_791_666_625n);
    const short = estimatePosition(
      { ...base, side: "Short" },
      2_500_000_000n,
      350n,
      2000n,
    );
    expect(short.liquidation).toBe(3_208_333_375n);
    expect(long.liquidation).toBeLessThan(2_500_000_000n);
    expect(short.liquidation).toBeGreaterThan(2_500_000_000n);
  });

  it("restores a long's fractional entry tick and leaves a short's whole tick alone", () => {
    const fractional = {
      entryPrice: 250001n,
      entryResidueQ16: 32768,
      tick: 10_000n,
    };
    expect(entryPrice({ ...fractional, side: "Long" })).toBe(2_500_005_000n);
    expect(entryPrice({ ...fractional, side: "Short" })).toBe(2_500_015_000n);
  });
});
