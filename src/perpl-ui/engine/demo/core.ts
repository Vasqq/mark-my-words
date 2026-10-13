import { fmtP, fmtUsd } from "../../view/format";
import type { DemoMarket as Market } from "./market";
import type { Marks, Draft, Side, Calculation, Position } from "../types";
export /* ================= Fixtures (simulated) ================= */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const MK: Record<string, Market> = {
  ETH: {
    id: "ETH",
    name: "Ethereum",
    tick: 0.01,
    lot: 0.001,
    dp: 2,
    qdp: 3,
    mark0: 2478.4,
    chg: 2.41,
    mmr: 0.025,
    ceiling: 20,
    taker: 0.0004,
    fund: 0.000012,
    depthLot: 820,
    stepBp: 1.6,
    seed: 11,
  },
  BTC: {
    id: "BTC",
    name: "Bitcoin",
    tick: 0.1,
    lot: 0.0001,
    dp: 1,
    qdp: 4,
    mark0: 61842.5,
    chg: -0.63,
    mmr: 0.02,
    ceiling: 25,
    taker: 0.0004,
    fund: -0.000008,
    depthLot: 310,
    stepBp: 1.1,
    seed: 29,
  },
};
export const BOUND = 0.005,
  QUOTE_LIFE = 10;
export const roundTick = (p: number, m: Market) =>
  Math.round(p / m.tick) * m.tick;
export const fixP = (p: number, m: Market) => +p.toFixed(m.dp);
// Order book: 40 levels per side, sizes in lots
export function book(m: Market, mark: number) {
  const asks = [],
    bids = [];
  for (let i = 0; i < 40; i++) {
    const off = mark * (m.stepBp / 1e4) * (i + 0.6);
    const lots = Math.round(m.depthLot * (0.5 + i * 0.22));
    asks.push([fixP(roundTick(mark + off, m), m), lots]);
    bids.push([fixP(roundTick(mark - off, m), m), lots]);
  }
  return {
    asks,
    bids,
  };
}

/* ================= Financial core ================= */
// Smallest lot count n with d*q*(T-E(q)) >= G. Within one level gross is linear in q, so solve per level (non-monotone safe: first level that satisfies wins).
export function solveSize(
  m: Market,
  side: Side,
  mark: number,
  T: number,
  G: number,
) {
  const d = side === "long" ? 1 : -1;
  const lv = side === "long" ? book(m, mark).asks : book(m, mark).bids;
  let n0 = 0,
    C0 = 0;
  for (const [p, lots] of lv) {
    const a = d > 0 ? T - p : p - T;
    const q0 = n0 * m.lot;
    const b = d > 0 ? -C0 + p * q0 : C0 - p * q0;
    if (a > 0) {
      let need = (G - b) / a;
      let n = Math.max(n0 + 1, Math.ceil(need / m.lot - 1e-9));
      if (n <= n0 + lots) {
        const q = n * m.lot;
        const E = (C0 + p * (n - n0) * m.lot) / q;
        return {
          n,
          q,
          E,
          worst: p,
        };
      }
    }
    C0 += p * lots * m.lot;
    n0 += lots;
  }
  return null;
}
export function vwapFor(m: Market, side: Side, mark: number, n: number) {
  const lv = side === "long" ? book(m, mark).asks : book(m, mark).bids;
  let left = n,
    C = 0,
    worst = 0;
  for (const [p, lots] of lv) {
    const t = Math.min(left, lots);
    C += p * t * m.lot;
    left -= t;
    worst = p;
    if (!left) break;
  }
  if (left > 0) return null;
  return {
    E: C / (n * m.lot),
    worst,
  };
}
export function maxLotsForBudget(
  m: Market,
  side: Side,
  mark: number,
  L: number,
  budget: number,
) {
  let lo = 0,
    hi = 0;
  const lv = side === "long" ? book(m, mark).asks : book(m, mark).bids;
  for (const l of lv) hi += l[1];
  const req = (n: number) => {
    const v = vwapFor(m, side, mark, n);
    if (!v) return Infinity;
    const q = n * m.lot;
    return (v.E * q) / L + v.E * q * m.taker + topup(side, mark, v.E, q);
  };
  if (req(1) > budget) return 0;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (req(mid) <= budget) lo = mid;
    else hi = mid;
  }
  return lo;
}
export function topup(side: Side, M: number, E: number, q: number) {
  const d = side === "long" ? 1 : -1;
  return Math.max(0, -d * (M - E) * q);
}
export function liqPrice(
  side: Side,
  E: number,
  q: number,
  C: number,
  mmr: number,
  F = 0,
) {
  const d = side === "long" ? 1 : -1;
  const MMR = E * q * mmr;
  return Math.max(0, E + (d * (MMR - C - F)) / q);
}
export const stopBuffer = (m: Market, mark: number) =>
  Math.max(m.tick, mark * 0.01);
export type DemoDraft = Draft & { budget: number };
export function compute(dr: DemoDraft, marks: Marks, free: number) {
  const m = MK[dr.market];
  const M = marks[dr.market];
  const d = dr.side === "long" ? 1 : -1;
  const L = dr.lev;
  const out: Calculation = {
    m,
    M,
    d,
    errors: {},
    ok: false,
  };
  const ceil = Math.min(5, m.ceiling);
  out.ceil = ceil;
  if (!(L >= 1 && L <= ceil + 1e-9))
    out.errors.lev = `Leverage must be between 1.00x and ${ceil.toFixed(2)}x.`;
  // target side validity vs mark (entry checked after solve)
  if (!(dr.target > 0)) out.errors.target = "Enter a positive price.";
  else if (d * (dr.target - M) <= 0)
    out.errors.target =
      d > 0
        ? `A long target must be above the mark (${fmtP(M, m)}).`
        : `A short target must be below the mark (${fmtP(M, m)}).`;
  if (!(dr.goal >= 0.01)) out.errors.goal = "Enter a goal of at least $0.01.";
  if (out.errors.target || out.errors.goal) return out;
  const s = solveSize(m, dr.side, M, dr.target, dr.goal);
  if (!s) {
    out.errors.goal = "This goal exceeds available depth at this target.";
    return out;
  }
  const { q, E, worst } = s;
  out.q = q;
  out.n = s.n;
  out.E = E;
  const bound = M * (1 + d * BOUND);
  out.bound = fixP(roundTick(bound, m), m);
  if (d * (worst - bound) > 0) {
    out.errors.goal =
      "Filling this size would move price past the 0.5% entry bound. Lower the goal or move the target further.";
  }
  if (d * (dr.target - E) <= 0) {
    out.errors.target = `Target must be beyond the estimated entry (${fmtP(E, m)}).`;
  }
  out.notional = E * q;
  out.margin = out.notional / L;
  out.entryFee = out.notional * m.taker;
  out.top = topup(dr.side, M, E, q);
  out.required = out.margin + out.entryFee + out.top;
  out.C = out.margin + out.top;
  out.gross = d * q * (dr.target - E);
  out.exitFeeT = dr.target * q * m.taker;
  out.netT = out.gross - out.entryFee - out.exitFeeT;
  out.liq = liqPrice(dr.side, E, q, out.C, m.mmr);
  out.buf = stopBuffer(m, M);
  // stop admission interval
  if (d > 0) {
    out.sLo = fixP(roundTick(Math.max(0, out.liq + out.buf) + m.tick, m), m);
    out.sHi = fixP(roundTick(Math.min(E, M) - m.tick, m), m);
  } else {
    out.sLo = fixP(roundTick(Math.max(E, M) + m.tick, m), m);
    out.sHi = fixP(roundTick(out.liq - out.buf - m.tick, m), m);
  }
  if (out.sLo > out.sHi)
    out.errors.stop =
      "No safe stop at this leverage. Add budget or lower leverage.";
  else if (!(dr.stop >= out.sLo && dr.stop <= out.sHi))
    out.errors.stop =
      d > 0
        ? `Stop must be between ${fmtP(out.sLo, m)} and ${fmtP(out.sHi, m)} (below entry, above liquidation + buffer).`
        : `Stop must be between ${fmtP(out.sLo, m)} and ${fmtP(out.sHi, m)} (above entry, below liquidation − buffer).`;
  out.grossS = d * q * (dr.stop - E);
  out.netS = out.grossS - out.entryFee - dr.stop * q * m.taker;
  if (out.required > dr.budget + 1e-9)
    out.errors.budget = `Needs ${fmtUsd(out.required)} but your budget is ${fmtUsd(dr.budget)}. Raise the budget or lower the goal.`;
  out.shortfall = Math.max(0, out.required - free);
  // feasible goal range at this target/budget/leverage
  const nMax = maxLotsForBudget(m, dr.side, M, L, dr.budget);
  if (nMax > 0) {
    const v = vwapFor(m, dr.side, M, nMax);
    if (!v) throw new Error("Demo size exceeds available depth");
    out.gMax = Math.max(0, d * nMax * m.lot * (dr.target - v.E));
  } else out.gMax = 0;
  out.reqGoalSize = dr.goal;
  out.overshoot = out.gross - dr.goal;
  out.ok = !Object.keys(out.errors).length;
  return out;
}

/* ================= Formatting ================= */
export {
  fmtUsd,
  fmtShort,
  fmtP,
  fmtQ,
  fmtPct,
  parseNum,
} from "../../view/format";
/* ================= Small components ================= */
export const pnlNow = (p: Position, M: number) => {
  const m = MK[p.market];
  const d = p.side === "long" ? 1 : -1;
  const gross = d * p.q * (M - p.E);
  return {
    gross,
    net: gross - p.entryFee - M * p.q * m.taker,
  };
};

/* ================= LiveChart: 60fps canvas chart with draggable target/stop handles =================
   Canvas draws history, zones and lines every frame; the price eases toward each new tick and the
   series scrolls continuously between ticks. Handles are DOM (focusable, draggable) positioned per frame. */
export type CompleteCalculation = ReturnType<typeof completeCalculation>;
export function completeCalculation(dr: DemoDraft, marks: Marks, free: number) {
  const c = compute(dr, marks, free);
  return {
    ...c,
    ceil: c.ceil ?? NaN,
    q: c.q ?? NaN,
    n: c.n ?? NaN,
    E: c.E ?? NaN,
    bound: c.bound ?? NaN,
    notional: c.notional ?? NaN,
    margin: c.margin ?? NaN,
    entryFee: c.entryFee ?? NaN,
    top: c.top ?? NaN,
    required: c.required ?? NaN,
    C: c.C ?? NaN,
    gross: c.gross ?? NaN,
    exitFeeT: c.exitFeeT ?? NaN,
    netT: c.netT ?? NaN,
    liq: c.liq ?? NaN,
    buf: c.buf ?? NaN,
    sLo: c.sLo ?? NaN,
    sHi: c.sHi ?? NaN,
    grossS: c.grossS ?? NaN,
    netS: c.netS ?? NaN,
    shortfall: c.shortfall ?? NaN,
    gMax: c.gMax ?? NaN,
    reqGoalSize: c.reqGoalSize ?? NaN,
    overshoot: c.overshoot ?? NaN,
  };
}
