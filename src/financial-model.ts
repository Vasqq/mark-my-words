import { testnetLimits } from "./testnet-limits";

const { entryBoundBps } = testnetLimits;
// Money and prices: micro-AUSD; quantity: millionths of the base asset.
// All economically meaningful arithmetic is integer arithmetic. Number is display/slider only.
export const U = 1_000_000n;
export type MarketId = "ETH" | "BTC";
export type Side = "long" | "short";
export interface Level {
  price: bigint;
  lots: bigint;
}
export interface Market {
  id: MarketId;
  name: string;
  tick: bigint;
  lot: bigint;
  mark: bigint;
  asks: Level[];
  bids: Level[];
  feePpm: bigint;
  maintenanceBps: bigint;
  maxLeverage: bigint;
  maxLots: bigint;
  fundingPpm: bigint;
  intervalBlocks: number;
  change: string;
  provenance: string;
}
export function decimal(raw: string, digits = 6): bigint {
  const s = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s))
    throw new Error("Enter a positive decimal number.");
  const [whole, tail = ""] = s.split(".");
  if (tail.length > digits)
    throw new Error(`Use at most ${digits} decimal places.`);
  const value =
    BigInt(whole) * 10n ** BigInt(digits) +
    BigInt(tail.padEnd(digits, "0") || "0");
  if (value > 9_000_000_000_000_000n)
    throw new Error("Amount exceeds the supported range.");
  return value;
}
export function exact(v: bigint, digits = 6): string {
  const sign = v < 0n ? "-" : "";
  const a = v < 0n ? -v : v;
  const unit = 10n ** BigInt(digits);
  return `${sign}${a / unit}.${(a % unit).toString().padStart(digits, "0")}`;
}
export function ceil(n: bigint, d: bigint): bigint {
  return (n + d - 1n) / d;
}
export function nearest(v: bigint, tick: bigint): bigint {
  return ((v + tick / 2n) / tick) * tick;
}
export function money(v: bigint, cents = true): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  if (cents && a > 0n && a < 10_000n) return `${neg ? "−" : ""}<$0.01`;
  const quantum = cents ? 10_000n : U;
  const rounded = (a + quantum / 2n) / quantum;
  const value = Number(rounded) / (cents ? 100 : 1);
  return `${neg ? "−" : ""}$${value.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
}
export function compactMoney(v: bigint): string {
  return money(v, v % U !== 0n);
}
export function fee(notional: bigint, ppm: bigint): bigint {
  return ceil(notional * ppm, U);
}
export interface Intent {
  market: MarketId;
  side: Side;
  goal: bigint;
  target: bigint;
  stop: bigint;
  budget: bigint;
  leverage: bigint;
  revision: number;
}
export interface Plan {
  lots: bigint;
  qty: bigint;
  notional: bigint;
  entry: bigint;
  worst: bigint;
  collateral: bigint;
  entryFee: bigint;
  reserve: bigint;
  commitment: bigint;
  liquidation: bigint;
  gross: bigint;
  targetNet: bigint;
  stopNet: bigint;
  maxGoal: bigint;
}
export type QuoteResult =
  | { ok: true; plan: Plan }
  | { ok: false; reason: string; maxGoal: bigint; required?: bigint };
export function gross(
  side: Side,
  qty: bigint,
  entryNotional: bigint,
  exit: bigint,
): bigint {
  return (side === "long" ? 1n : -1n) * ((qty * exit) / U - entryNotional);
}
export function liquidation(
  side: Side,
  qty: bigint,
  notional: bigint,
  collateral: bigint,
  funding = 0n,
  maintenanceBps = 500n,
): bigint {
  if (!qty) return 0n;
  const maintenance = ceil(notional * maintenanceBps, 10_000n);
  const price =
    (notional * U) / qty +
    ((side === "long" ? 1n : -1n) * (maintenance - collateral - funding) * U) /
      qty;
  return price > 0n ? price : 0n;
}
export function planFor(
  i: Intent,
  m: Market,
  lots: bigint,
  notional: bigint,
): Plan {
  const qty = lots * m.lot;
  const entry = (notional * U) / qty;
  const worst =
    i.side === "long"
      ? ((m.mark * (10000n + entryBoundBps)) / 10000n / m.tick) * m.tick
      : ceil((m.mark * (10000n - entryBoundBps)) / 10000n, m.tick) * m.tick;
  const worstN = (qty * (i.side === "long" ? worst : entry)) / U;
  const collateral =
    ceil(notional * 100n, i.leverage) +
    (i.side === "long"
      ? notional - (qty * m.mark) / U
      : (qty * m.mark) / U - notional);
  const entryFee = fee(notional, m.feePpm);
  // Reserve bounds extra price margin + adverse-mark top-up + fees at the IOC bound.
  const worstCollateral =
    ceil(worstN * 100n, i.leverage) + ceil(qty * m.mark * 50n, U * 10000n);
  const reserve =
    (worstCollateral > collateral ? worstCollateral - collateral : 0n) +
    fee((qty * worst) / U, m.feePpm);
  const g = gross(i.side, qty, notional, i.target);
  return {
    lots,
    qty,
    notional,
    entry,
    worst,
    collateral,
    entryFee,
    reserve,
    commitment: collateral + entryFee + reserve,
    liquidation: liquidation(
      i.side,
      qty,
      notional,
      collateral,
      0n,
      m.maintenanceBps,
    ),
    gross: g,
    targetNet: g - entryFee - fee((qty * i.target) / U, m.feePpm),
    stopNet:
      gross(i.side, qty, notional, i.stop) -
      entryFee -
      fee((qty * i.stop) / U, m.feePpm),
    maxGoal: 0n,
  };
}
export function solve(i: Intent, m: Market): QuoteResult {
  const invalid = (reason: string): QuoteResult => ({
    ok: false,
    reason,
    maxGoal: 0n,
  });
  if ([i.goal, i.target, i.stop, i.budget].some((v) => v <= 0n))
    return invalid(
      "Goal, target, collateral budget and required stop must be positive.",
    );
  if (i.target % m.tick || i.stop % m.tick)
    return invalid(
      `Prices must align to the ${compactMoney(m.tick)} market tick. Accept the suggested price.`,
    );
  if (i.leverage < 100n || i.leverage > m.maxLeverage || i.leverage > 500n)
    return invalid(
      "Leverage must be between 1x and the current 5x product/market ceiling.",
    );
  if (
    i.side === "long"
      ? i.target <= m.mark || i.stop >= m.mark
      : i.target >= m.mark || i.stop <= m.mark
  )
    return invalid(
      "Target must be favorable and initial stop adverse to the reference mark.",
    );
  const book = i.side === "long" ? m.asks : m.bids;
  let lots = 0n,
    notional = 0n,
    maxGoal = 0n,
    found: Plan | undefined,
    required: bigint | undefined;
  // Enumerate finite lot candidates, including nonmonotone payoff across depth. No binary-search assumption.
  for (const level of book) {
    const bound =
      i.side === "long"
        ? ((m.mark * (10000n + entryBoundBps)) / 10000n / m.tick) * m.tick
        : ceil((m.mark * (10000n - entryBoundBps)) / 10000n, m.tick) * m.tick;
    if (i.side === "long" ? level.price > bound : level.price < bound) continue;
    for (let k = 0n; k < level.lots && lots < m.maxLots; k++) {
      lots++;
      notional += (level.price * m.lot) / U;
      const p = planFor(i, m, lots, notional);
      if (i.side === "long" ? level.price > p.worst : level.price < p.worst)
        break;
      const favorable =
        i.side === "long" ? i.target > p.entry : i.target < p.entry;
      const buffer = m.mark / 100n > m.tick ? m.mark / 100n : m.tick;
      const safeStop =
        i.side === "long"
          ? i.stop > p.liquidation + buffer && i.stop < p.entry
          : i.stop < p.liquidation - buffer && i.stop > p.entry;
      if (favorable && safeStop && p.commitment <= i.budget) {
        if (p.gross > maxGoal) maxGoal = p.gross;
        if (!found && p.gross >= i.goal) found = p;
      }
      if (!required && favorable && p.gross >= i.goal) required = p.commitment;
    }
  }
  if (found) return { ok: true, plan: { ...found, maxGoal } };
  return {
    ok: false,
    reason:
      required && required > i.budget
        ? `This goal exceeds your collateral limit. Estimated requirement ${money(required)}.`
        : "No feasible size within depth, entry bound and stop/liquidation buffer. Lower goal, move target, add budget or lower leverage.",
    maxGoal,
    required,
  };
}
export function transport(i: Intent, old: Market, next: Market): Intent {
  return {
    ...i,
    market: next.id,
    target: nearest((i.target * next.mark) / old.mark, next.tick),
    stop: nearest((i.stop * next.mark) / old.mark, next.tick),
    revision: i.revision + 1,
  };
}
export function reflect(i: Intent, m: Market): Intent {
  return {
    ...i,
    side: i.side === "long" ? "short" : "long",
    target: nearest(2n * m.mark - i.target, m.tick),
    stop: nearest(2n * m.mark - i.stop, m.tick),
    revision: i.revision + 1,
  };
}
