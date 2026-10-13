import { ceil, fee, U } from "./financial-model";

/** One open position in native units, from a signed snapshot or a finalized chain read. */
export interface PositionFacts {
  side: "Long" | "Short";
  size: bigint; // lots
  entryPrice: bigint; // ticks
  entryResidueQ16: number;
  collateral: bigint; // micro AUSD
  tick: bigint; // micro AUSD per tick
  lot: bigint; // micro base units per lot
  feesPaid?: bigint; // micro AUSD already charged at entry
  funding?: bigint; // micro AUSD accrued, positive when received
}

/**
 * Average entry in micro AUSD. Perpl stores it as whole ticks plus a 16-bit fraction, and
 * rounds a long's whole-tick part up, so that tick is taken back before adding the fraction.
 */
export function entryPrice(
  p: Pick<PositionFacts, "side" | "entryPrice" | "entryResidueQ16" | "tick">,
) {
  const whole =
    p.entryPrice - (p.side === "Long" && p.entryResidueQ16 ? 1n : 0n);
  return ((whole * 65536n + BigInt(p.entryResidueQ16)) * p.tick) / 65536n;
}

/**
 * What an open position is worth at a given mark, from public inputs: the mark, the market's
 * base taker fee and its maintenance factor. A display estimate that is always available;
 * the signed close review replaces it when one has been read.
 */
export function estimatePosition(
  p: PositionFacts,
  mark: bigint, // micro AUSD
  feePpm: bigint,
  maintenanceFactor: bigint,
) {
  const direction = p.side === "Long" ? 1n : -1n;
  const quantity = p.size * p.lot;
  const entryNotional = (quantity * entryPrice(p)) / U;
  const markNotional = (quantity * mark) / U;
  const gross = direction * (markNotional - entryNotional);
  const net =
    gross + (p.funding ?? 0n) - (p.feesPaid ?? 0n) - fee(markNotional, feePpm);
  const maintenance = ceil(entryNotional * 100n, maintenanceFactor);
  const numerator =
    (entryNotional + direction * (maintenance - p.collateral)) * U;
  return {
    gross,
    net,
    // Rounded toward the mark, the cautious side for either direction.
    liquidation:
      quantity === 0n || numerator <= 0n
        ? 0n
        : p.side === "Long"
          ? ceil(numerator, quantity)
          : numerator / quantity,
    // Hundredths, like every other leverage figure.
    leverage:
      p.collateral > 0n ? ceil(entryNotional * 100n, p.collateral) : undefined,
  };
}
