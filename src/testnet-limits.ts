/** The one always-on testnet trading policy. Source-controlled: no environment, URL or storage override. */
export const testnetLimits = Object.freeze({
  chainId: 10143,
  markets: Object.freeze([16, 32] as const), // BTC, ETH
  sides: Object.freeze(["long", "short"] as const),
  // Micro AUSD. Used only to size the goal slider before the real balance is known:
  // each test account deposits 100 test AUSD.
  assumedBalance: 100_000_000n,
  defaultLeverage: 300n, // hundredths: 3x
  // Hundredths. Perpl's own base maximum per market: BTC 15x, ETH 12x. Perpl can lower the
  // effective maximum for a given size; the trade review checks that live figure too.
  maxLeverage: Object.freeze({ 16: 1500n, 32: 1200n } as Record<
    number,
    bigint
  >),
  stopRequired: true,
  // Basis points. An entry may fill no worse than this far past the mark, and the target
  // must sit beyond that bound. Ours, not Perpl's: its default market slippage is wider.
  entryBoundBps: 10n,
  maxGasPerTransaction: 50_000_000_000_000_000n, // wei: 0.05 MON
});

/** Perpl's base maximum leverage for a market, in hundredths. 0 for an unsupported market. */
export const maxLeverage = (marketId: number) =>
  testnetLimits.maxLeverage[marketId] ?? 0n;

/**
 * Throws when a reviewed entry falls outside the policy. Size is not capped here: an entry
 * is limited by the account's own free collateral, which the trade review checks.
 */
export function assertEntryWithinLimits(entry: {
  marketId: number;
  side: string;
  leverage: bigint;
  stop: bigint;
}) {
  const l = testnetLimits;
  if (
    !(l.markets as readonly number[]).includes(entry.marketId) ||
    !(l.sides as readonly string[]).includes(entry.side)
  )
    throw Error("Only ETH and BTC long or short entries are supported.");
  if (entry.leverage < 100n || entry.leverage > maxLeverage(entry.marketId))
    throw Error("Leverage is above Perpl's maximum for this market.");
  if (entry.stop <= 0n) throw Error("A stop loss is required on entry.");
}
