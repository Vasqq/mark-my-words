import type {
  Calculation,
  CompleteCalculation,
  PerplEngine,
  Draft,
} from "../engine/types";
/**
 * The signed review's numbers win when present; otherwise the public estimate shows, so the
 * bar and chart stay live while editing. Missing values format as a dash. No admission authority.
 */
export function presentCalculation(
  engine: PerplEngine,
  draft: Draft,
): CompleteCalculation {
  const snapshot = engine.calculate(draft);
  const publicPlan =
    snapshot.public.state === "observed" ? snapshot.public.value : undefined;
  const details =
    snapshot.details.state === "observed" ? snapshot.details.value : undefined;
  const c: Calculation = publicPlan ?? {
    m: engine.markets[draft.market],
    M: engine.marks[draft.market],
    d: draft.side === "long" ? 1 : -1,
    errors: {},
    ok: false,
  };
  return {
    ...c,
    ...details,
    ceil: c.ceil ?? NaN,
    q: c.q ?? NaN,
    n: c.n ?? NaN,
    E: c.E ?? NaN,
    bound: c.bound ?? NaN,
    notional: c.notional ?? NaN,
    margin: details?.margin ?? c.margin ?? NaN,
    entryFee: details?.entryFee ?? c.entryFee ?? NaN,
    top: details?.top ?? c.top ?? NaN,
    required: details?.required ?? c.required ?? NaN,
    C: details?.C ?? c.C ?? NaN,
    gross: c.gross ?? NaN,
    exitFeeT: details?.exitFeeT ?? c.exitFeeT ?? NaN,
    netT: details?.netT ?? c.netT ?? NaN,
    liq: details?.liq ?? c.liq ?? NaN,
    buf: details?.buf ?? c.buf ?? NaN,
    sLo: details?.sLo ?? c.sLo ?? NaN,
    sHi: details?.sHi ?? c.sHi ?? NaN,
    grossS: c.grossS ?? NaN,
    netS: details?.netS ?? c.netS ?? NaN,
    shortfall: details?.shortfall ?? c.shortfall ?? NaN,
    gMax: details?.gMax ?? c.gMax ?? NaN,
    tLim: details?.tLim ?? c.tLim ?? NaN,
    reqGoalSize: details?.reqGoalSize ?? c.reqGoalSize ?? NaN,
    overshoot: c.overshoot ?? NaN,
  };
}
