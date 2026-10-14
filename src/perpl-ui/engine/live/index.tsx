import { closedTrades } from "../../../perpl-trade-history";
import { smooth, type Sample } from "./chart-series";
import { useLiveLine } from "./live-line";
import { entryPrice, estimatePosition } from "../../../perpl-position-estimate";
import { maxLeverage, testnetLimits } from "../../../testnet-limits";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Journal } from "../../../order-journal";
import { ceil, U, type MarketId } from "../../../financial-model";
import {
  PerplMarketDataSource,
  observationFresh,
  type MarketDataSnapshot,
} from "../../../perpl-market-data";
import { entryLimit, sizeLiveIntent } from "../../../perpl-sizing";
import {
  createPublicDraftController,
  publicDraftFromDisplay,
  accountAmountDisplay,
} from "./draft";
export { publicDraftFromDisplay } from "./draft";
import type { PublicDraft } from "../../../public-draft";
import { createLiveController, type LiveControllerState } from "./controller";
import { LiveControls } from "./Controls";
import { Sheet } from "../../view/ReferenceView";
import type { FundingWallet } from "../../../funding-application";
import type { SessionTypedData } from "../../../perpl-session";
import type { Hex } from "viem";
import { executionEnabled } from "../../../../server/order-wire.mjs";
import {
  positionProtection,
  assessProtection,
  observedEntryPosition,
} from "../../../perpl-lifecycle";
import type { TradingState } from "../../../perpl-trading-state";
import { assessCloseReview } from "../../../perpl-close-review";
import {
  accountFee,
  tradeEconomics,
  tradeReviewFresh,
} from "../../../perpl-trade-review";
import { readCandles, type CandleRange } from "../../../perpl-candles";
import type {
  Book,
  PerplEngine,
  Draft,
  Market,
  Observation,
  Identity,
  User,
  Calculation,
} from "../types";

export type LiveIdentity = {
  user: User | null;
  login(): void;
  logout(): Promise<void>;
  reason?: string;
  wallet?: FundingWallet;
  sign?: (data: SessionTypedData) => Promise<Hex>;
  setup?: () => Promise<void>;
  export?: () => Promise<void>;
  selectWallets?: string[];
  selectWallet?: (address: string) => void;
};
const unavailable = async () => ({
  state: "unavailable" as const,
  reason: "Funding, account access and trading are not available yet.",
});
/** Records and positions that existed when an entry was sent. */
type Opening = { ops: ReadonlySet<string>; positions: ReadonlySet<string> };
/**
 * The entry's position as Perpl shows it: settled from history, or, until history catches
 * up (often 30 s or more), seen in the signed positions read. The journal record itself
 * stays unresolved until history settles it.
 */
function entryPosition(
  entry: Journal["operations"][number] | undefined,
  trading: TradingState | undefined,
  before: Opening["positions"],
) {
  if (!entry) return undefined;
  if (entry.positionId && entry.filled)
    return { id: entry.positionId, lots: BigInt(entry.filled) };
  const p = trading && observedEntryPosition(entry, trading);
  // A position that was already open before the send says nothing about this entry.
  return p && !before.has(`${p.market.marketId}:${p.id}`)
    ? { id: p.id, lots: p.size }
    : undefined;
}
/** Both exits of a filled entry are registered on Perpl and seen in a signed read. */
function entryProtected(
  journal: Journal | null | undefined,
  entry: Journal["operations"][number] | undefined,
  trading: TradingState | undefined,
  before: Opening["positions"],
) {
  const position = entryPosition(entry, trading, before);
  const seen = (kind: "stop-loss" | "take-profit") =>
    !!journal?.management?.some(
      (op) =>
        op.positionId === position?.id &&
        op.payload.mkt === entry?.payload.mkt &&
        op.kind === kind &&
        op.phase === "observed",
    );
  return !!position && seen("stop-loss") && seen("take-profit");
}
/** The reference progress list, driven by the real order record instead of a timer. */
function openingSteps(
  journal: Journal | null | undefined,
  trading: TradingState | undefined,
  opening: Opening | null,
): Book["steps"] {
  if (!opening) return null;
  const entry = journal?.operations.find((op) => !opening.ops.has(op.id));
  const sent = !!entry && !["prepared", "submitting"].includes(entry.phase);
  const filled = !!entryPosition(entry, trading, opening.positions);
  const guarded = entryProtected(journal, entry, trading, opening.positions);
  const step = (label: string, done: boolean, running: boolean) => ({
    label,
    st: done ? "done" : running ? "run" : "",
  });
  return [
    step("Placing your order", sent, !sent),
    step("Waiting for it to fill", filled, sent && !filled),
    step("Filled", filled, false),
    step(
      guarded ? "Take profit and stop set" : "Setting take profit and stop",
      guarded,
      filled && !guarded,
    ),
  ];
}
const noWrite = async () => {
  throw Error("This action is unavailable.");
};
// Perpl reports funding as what the position owes; the UI shows what it has received.
const negate = (value: bigint | undefined) =>
  value === undefined ? undefined : -value;
const display = (value: bigint) => {
  if (value > 9_000_000_000_000_000n || value < -9_000_000_000_000_000n)
    return NaN;
  return Number(value) / 1e6;
};
export function displayMarket(
  snapshot: Pick<MarketDataSnapshot, "market" | "observation">,
): Market {
  const metadata = snapshot.observation?.metadata;
  return {
    id: snapshot.market,
    name: snapshot.market === "ETH" ? "Ethereum" : "Bitcoin",
    dp: metadata?.priceDecimals ?? 2,
    qdp: metadata?.sizeDecimals ?? 4,
    tick: metadata ? display(metadata.tick) : NaN,
    lot: metadata ? display(metadata.lot) : NaN,
    // Change against Perpl's price 24 hours ago; a display percentage only.
    chg: snapshot.observation?.previousPrice
      ? (Number(snapshot.observation.mark) /
          Number(snapshot.observation.previousPrice) -
          1) *
        100
      : NaN,
  };
}
/**
 * What the sentence would cost and risk right now, from public data alone: the live book,
 * the market's base taker fee and its maintenance factor. It is an estimate for the bar
 * and chart while editing. It admits nothing; Review still reads the signed account.
 */
export function publicCalculation(
  draft: Draft,
  snapshot: MarketDataSnapshot,
  exactDraft?: PublicDraft,
  free?: bigint,
): Observation<Calculation> {
  const observation = snapshot.observation;
  const m = displayMarket(snapshot);
  const empty: Calculation = {
    m,
    M: observation ? display(observation.mark) : NaN,
    d: draft.side === "long" ? 1 : -1,
    errors: {},
    ok: false,
  };
  if (
    snapshot.status !== "ready" ||
    !observation ||
    !observationFresh(observation, Date.now())
  )
    return {
      state:
        snapshot.status === "loading" || snapshot.status === "idle"
          ? "loading"
          : "unavailable",
      reason: snapshot.error ?? "Fresh public sizing unavailable.",
    };
  // The largest goal this sentence can reach with the account's free collateral (an
  // assumed 100 test AUSD until the balance is read). It only sets the slider's range,
  // so it must not depend on the current goal being fillable.
  const gMax = (() => {
    try {
      const intent = exactDraft ?? publicDraftFromDisplay(draft);
      const { metadata, mark } = observation;
      const budget = free ?? testnetLimits.assumedBalance;
      // Collateral per dollar of notional, in ppm: margin + 0.5% allowance + entry fee.
      const perNotional =
        100_000_000n / intent.leverage + 5000n + accountFee(metadata, 0);
      const notional = (budget * 1_000_000n) / perNotional;
      const distance =
        intent.target > mark ? intent.target - mark : mark - intent.target;
      // A short is committed at its stop price, which is above the mark.
      const basis =
        intent.side === "short" && intent.stop > mark ? intent.stop : mark;
      return display((notional * distance) / basis);
    } catch {
      return undefined;
    }
  })();
  empty.gMax = gMax;
  // The nearest target the entry's price bound allows: one tick past it. Known even when
  // the sentence does not size, so the target controls can stop there.
  const { tick } = observation.metadata;
  empty.tLim = display(
    draft.side === "long"
      ? entryLimit("long", observation.mark, tick) + tick
      : entryLimit("short", observation.mark, tick) - tick,
  );
  try {
    const intent = exactDraft ?? publicDraftFromDisplay(draft);
    const sized = sizeLiveIntent(intent, observation);
    const { metadata } = observation;
    let estimate: Partial<Calculation> = {};
    try {
      const economics = tradeEconomics(
        intent,
        sized,
        observation.mark,
        metadata.tick,
        accountFee(metadata, 0),
        BigInt(metadata.maintenanceMarginFactor),
      );
      const direction = draft.side === "long" ? 1 : -1;
      const margin = ceil(sized.notional * 100n, intent.leverage);
      const stopBoundary = display(economics.stopBoundary);
      const tick = display(metadata.tick);
      const mark = display(observation.mark);
      const required =
        economics.fundingAllowance > economics.estimatedDebit
          ? economics.fundingAllowance
          : economics.estimatedDebit;
      estimate = {
        ceil: Number(maxLeverage(metadata.marketId)) / 100,
        margin: display(margin),
        entryFee: display(economics.entryFee),
        top: display(economics.estimatedCollateral - margin),
        required: display(economics.fundingAllowance),
        C: display(economics.estimatedCollateral),
        netT: display(economics.targetAfterFees),
        netS: display(economics.stopAfterFees),
        liq: display(economics.liquidation),
        buf: Math.abs(stopBoundary - display(economics.liquidation)),
        sLo: direction > 0 ? stopBoundary + tick : mark + tick,
        sHi: direction > 0 ? mark - tick : stopBoundary - tick,
        // Unknown balance is not a shortfall of zero: leave it out until it is read.
        ...(free === undefined
          ? {}
          : { shortfall: display(required > free ? required - free : 0n) }),
      };
    } catch {
      /* Fee or margin data missing: the bar shows the size and leaves the rest unavailable. */
    }
    return {
      state: "observed",
      source: snapshot.source,
      at: observation.receivedAt,
      stale: false,
      value: {
        ...empty,
        ok: true,
        ...estimate,
        q: display(sized.quantity),
        n: Number(sized.lots),
        E: display(sized.entry),
        bound: display(sized.limit),
        notional: display(sized.notional),
        gross: display(sized.targetGross),
        grossS: display(sized.stopGross),
      },
    };
  } catch (error) {
    return {
      state: "observed",
      source: snapshot.source,
      at: observation.receivedAt,
      stale: false,
      value: {
        ...empty,
        errors: {
          goal:
            error instanceof Error
              ? error.message
              : "Public sizing unavailable.",
        },
      },
    };
  }
}
function authenticatedCalculation(
  review: import("../../../perpl-trade-review").TradeReview,
  draft: Draft,
): Calculation {
  const { size, observation } = review.sizing;
  const direction = draft.side === "long" ? 1 : -1;
  const stopBoundary = display(review.stopBoundary);
  const mark = display(observation.mark);
  return {
    m: displayMarket({ market: review.sizing.intent.market, observation }),
    M: mark,
    d: direction,
    ok: !review.blockers.length,
    errors: review.blockers.length ? { budget: review.blockers.join(" ") } : {},
    q: display(size.quantity),
    n: Number(size.lots),
    E: display(size.entry),
    bound: display(size.limit),
    notional: display(size.notional),
    gross: display(size.targetGross),
    grossS: display(size.stopGross),
    ceil: Number(review.sizing.dynamicLeverage) / 100,
    margin: display(review.sizing.baseMargin),
    entryFee: display(review.entryFee),
    top: display(review.estimatedCollateral - review.sizing.baseMargin),
    required: display(review.fundingAllowance),
    C: display(review.estimatedCollateral),
    netT: display(review.targetAfterFees),
    netS: display(review.stopAfterFees),
    liq: display(review.liquidation),
    buf: Math.abs(stopBoundary - display(review.liquidation)),
    sLo:
      direction > 0
        ? stopBoundary + display(observation.metadata.tick)
        : mark + display(observation.metadata.tick),
    sHi:
      direction > 0
        ? mark - display(observation.metadata.tick)
        : stopBoundary - display(observation.metadata.tick),
    shortfall: display(review.fundingShortfall),
  };
}
/**
 * Results kept until one of `inputs` changes. The view repaints several times a second;
 * sizing a sentence or valuing a position only needs redoing when its data does.
 */
function useCache(inputs: readonly unknown[]) {
  const cache = useMemo(() => new Map<string, unknown>(), inputs);
  return <T,>(key: string, compute: () => T): T => {
    if (!cache.has(key)) cache.set(key, compute());
    return cache.get(key) as T;
  };
}
function usePublicMarket(market: MarketId) {
  const source = useMemo(() => {
    const result = new PerplMarketDataSource("/perpl-public", undefined, true);
    result.selectMarket(market);
    return result;
  }, [market]);
  return useSyncExternalStore(source.subscribe, source.getSnapshot);
}
export function useLiveEngine(identity: LiveIdentity): PerplEngine {
  const eth = usePublicMarket("ETH");
  const btc = usePublicMarket("BTC");
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState<string>();
  const resultKey = `perpl-result-seen-v1:${identity.user?.addr.toLowerCase() ?? ""}`;
  const [toasts, setToasts] = useState<Book["toasts"]>([]);
  const toast = (t: ReactNode, kind = "") => {
    const id = Math.random();
    setToasts((x) => [...x.slice(-2), { id, t, kind }]);
    // 8 s, the same as the card's shrinking bar (--notice-life in perpl.css).
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 8000);
  };
  // The entry being opened right now: every record that existed before it is "known".
  const [opening, setOpening] = useState<Opening | null>(null);
  const [dismissedResult, setDismissedResult] = useState<string | null>(() => {
    try {
      return localStorage.getItem(resultKey);
    } catch {
      return null;
    }
  });
  // Raw one-minute closes, kept only to fill the live line's first seconds on a cold server.
  const [minuteCloses, setMinuteCloses] = useState<Record<MarketId, Sample[]>>({
    ETH: [],
    BTC: [],
  });
  const line = useLiveLine(
    {
      ETH: eth.observation?.metadata.tick,
      BTC: btc.observation?.metadata.tick,
    },
    minuteCloses,
  );
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const controller = useMemo(
    () =>
      identity.user
        ? createLiveController(
            identity.user.addr,
            () => identityRef.current.wallet,
            () => identityRef.current.sign,
          )
        : undefined,
    [identity.user?.addr],
  );
  const emptyState = useMemo<LiveControllerState>(
    () => ({
      session: { state: "idle" },
      risks: {},
      busy: false,
      authorityRevision: 0,
    }),
    [],
  );
  const control = useSyncExternalStore(
    controller?.subscribe ?? (() => () => {}),
    controller?.getSnapshot ?? (() => emptyState),
  );
  // A toast when a close, a moved exit or a cancellation is confirmed by Perpl. Records
  // that already existed when the page loaded are not announced again.
  const announced = useRef<Map<string, string> | null>(null);
  // Full closes already announced from the signed read, so settlement does not repeat them.
  const closed = useRef(new Set<string>());
  useEffect(() => {
    const operations = control.journal?.management;
    if (!operations) return;
    const before = announced.current;
    announced.current = new Map(operations.map((op) => [op.id, op.phase]));
    if (!before) {
      for (const op of operations) closed.current.add(op.id);
      return;
    }
    const trading = control.trading;
    for (const op of operations) {
      // Perpl's signed read shows the position gone about 4 s after the close; history
      // settles it 10 to 45 s later. Announce the first.
      if (
        op.kind === "close" &&
        ["forwarded", "unknown"].includes(op.phase) &&
        !closed.current.has(op.id) &&
        trading &&
        trading.lastRequestId >= op.payload.rq &&
        !trading.positions.some(
          (p) => p.id === op.positionId && p.market.marketId === op.payload.mkt,
        )
      ) {
        closed.current.add(op.id);
        const m = metadataFor(op.payload.mkt);
        if (m)
          toast(
            <b>
              {"Closed "}
              {display(BigInt(op.payload.s) * m.lot)} {m.symbol}
            </b>,
          );
        continue;
      }
      if (before.get(op.id) === op.phase) continue;
      const m = metadataFor(op.payload.mkt);
      if (!m) continue;
      const price = (ticks: number) =>
        `$${display(BigInt(ticks) * m.tick).toLocaleString("en-US")}`;
      // A long's stop fires at or below its trigger (condition 4); a short's is the reverse.
      const exit =
        (op.payload.tpc === 4) === (op.side !== "Short")
          ? "Stop"
          : "Take profit";
      if (op.phase === "settled" && op.filled && !closed.current.has(op.id))
        toast(
          <b>
            {"Closed "}
            {display(BigInt(op.filled) * m.lot)} {m.symbol}
          </b>,
        );
      else if (op.phase === "observed" && op.payload.t === 6)
        toast(
          <>
            <b>
              {"$"}
              {display(BigInt(op.payload.a!)).toLocaleString("en-US")}
            </b>{" "}
            collateral added to {m.symbol}
          </>,
        );
      else if (op.phase === "observed" && op.payload.t === 7)
        toast(
          <>
            <b>
              {exit} on {m.symbol}
            </b>{" "}
            moved to {price(op.payload.tp!)}
          </>,
          "g",
        );
      else if (op.phase === "observed" && op.payload.t === 5)
        toast(
          <>
            <b>
              {exit} on {m.symbol}
            </b>{" "}
            cancelled
          </>,
        );
    }
  }, [control.journal, control.trading]);
  // An open position's exits are readable only with account access. Without it, offer the
  // authorization once per login instead of leaving the position half shown.
  const offeredAccess = useRef<typeof controller>(undefined);
  useEffect(() => {
    if (
      !controller ||
      offeredAccess.current === controller ||
      control.busy ||
      control.control ||
      !control.chainPositions?.length ||
      (control.session.state !== "idle" &&
        control.session.state !== "unavailable")
    )
      return;
    offeredAccess.current = controller;
    controller.control("enroll");
    void controller.prepareSession();
  }, [controller, control]);
  useEffect(() => {
    if (!controller) return;
    void controller.refresh();
    const timer = setInterval(() => controller.tick(), 1000);
    const poller = setInterval(() => {
      if (document.visibilityState === "visible") controller.poll();
    }, 10000);
    const changed = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== null) {
        const owner = identityRef.current.user?.addr.toLowerCase();
        if (
          !owner ||
          ![
            `perpl-session-v1:10143:${owner}`,
            `perpl-funding-v1:10143:${owner}`,
            `perpl-orders-v1:10143:${owner}`,
          ].includes(event.key)
        )
          return;
      }
      controller.invalidate();
      void controller.refresh();
    };
    window.addEventListener("storage", changed);
    window.addEventListener("perpl-order-change", changed);
    return () => {
      clearInterval(timer);
      clearInterval(poller);
      window.removeEventListener("storage", changed);
      window.removeEventListener("perpl-order-change", changed);
      controller.dispose();
    };
  }, [controller]);
  const [chartRanges, setChartRanges] = useState<
    Record<string, Observation<{ price: number; time: number }[]>>
  >({});
  const rangesPending = useRef(new Set<string>());
  const rangeFetched = useRef<Record<string, number>>({});
  const loadChartRange = (market: string, tf: string) => {
    if (!(tf === "1H" || tf === "1D" || tf === "1W")) return;
    const key = market + tf;
    const metadata = (market === "BTC" ? btc : eth).observation?.metadata;
    if (
      !metadata ||
      rangesPending.current.has(key) ||
      Date.now() - (rangeFetched.current[key] ?? 0) < 60000
    )
      return;
    rangesPending.current.add(key);
    // Keep showing the range already drawn while its refresh is in flight.
    setChartRanges((previous) =>
      previous[key]?.state === "observed"
        ? previous
        : {
            ...previous,
            [key]: { state: "loading", reason: `Reading real ${tf} candles…` },
          },
    );
    void readCandles(metadata, tf as CandleRange)
      .then((result) => {
        rangeFetched.current[key] = Date.now();
        const closes = result.candles.map((c) => ({
          price: display(c.close),
          time: c.time,
        }));
        if (tf === "1H")
          setMinuteCloses((previous) => ({ ...previous, [market]: closes }));
        return setChartRanges((previous) => ({
          ...previous,
          [key]: result.candles.length
            ? {
                state: "observed",
                // A curve through every real close, so a range reads as a line.
                value: smooth(closes),
                range: { from: result.window.from, to: result.window.to },
                source: "Perpl public candles",
                at: result.at,
                stale: false,
              }
            : {
                state: "unavailable",
                reason: `No real ${tf} candles returned for ${market}.`,
              },
        }));
      })
      .catch((cause) =>
        // A failed refresh keeps the range already drawn; only a range never read fails.
        setChartRanges((previous) =>
          previous[key]?.state === "observed"
            ? previous
            : {
                ...previous,
                [key]: {
                  state: "failed",
                  reason:
                    cause instanceof Error
                      ? cause.message
                      : "Historical range unavailable.",
                },
              },
        ),
      )
      .finally(() => rangesPending.current.delete(key));
  };
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [restored] = useState(() => {
    try {
      const controller = createPublicDraftController();
      return {
        controller,
        draft: controller.initial,
        error: undefined,
      };
    } catch (error) {
      return {
        // An explicit edit may replace invalid storage; rendering never does.
        controller: createPublicDraftController({
          getItem: () => null,
          setItem: (key, value) => localStorage.setItem(key, value),
        }),
        draft: undefined,
        error:
          error instanceof Error
            ? error.message
            : "Saved sentence unavailable.",
      };
    }
  });
  // A first-time sentence should be one a fresh 100 test AUSD account can place: $10 at
  // 5% and 3x commits about two thirds of it. The prices here only hold the place until
  // the first live mark, when `landing` puts the target and stop at their distances.
  const initialDraft: Draft = restored.draft ?? {
    market: "ETH",
    side: "long",
    goal: 10,
    target: 3100,
    stop: 2404.05,
    lev: 3,
    rev: 1,
  };
  // Saved data that could not be read is never replaced on load, only by an explicit edit.
  const landing = {
    fresh: !restored.draft && !restored.error,
    repair: !!restored.draft,
    target: 0.05,
    stop: 0.02,
  };
  const [storageError, setStorageError] = useState(restored.error);
  const px: Identity = {
    user: identity.user,
    modal: null,
    oneTap: null,
    ask: async () => false,
    login: async () => {
      if (identity.setup || identity.selectWallets?.length) setSetupOpen(true);
      else identity.login();
      return false;
    },
    fund: async () => {
      controller?.control("fund");
      return false;
    },
    tapOn: () => control.session.state === "active",
    // The access key stays stored for this wallet, so logging back in restores it.
    logout: () => identity.logout(),
  };
  const account: PerplEngine["account"] = !identity.user
    ? {
        state: "unavailable",
        reason: identity.reason ?? "Log in for account details",
      }
    : control.busy && !control.account
      ? { state: "loading", reason: "Reading finalized account state…" }
      : control.account
        ? {
            state: "observed",
            value: control.account,
            source: "Monad testnet finalized RPC",
            at: control.account.blockTime,
            stale: now - control.account.blockTime > 60000,
          }
        : {
            state: "failed",
            reason: control.error ?? "Account details unavailable.",
          };
  const trading = control.trading;
  // The goal a position was opened for, remembered with its entry record.
  const goalFor = (
    marketId: number,
    entry: bigint, // micro AUSD
    quantity: bigint, // micro base units
    tick: bigint,
    positionId?: number,
  ) => {
    const recorded = control.journal?.operations.find(
      (op) =>
        op.payload.mkt === marketId &&
        !op.completion &&
        op.filled > 0 &&
        (positionId === undefined || op.positionId === positionId),
    );
    if (recorded?.goal) return display(BigInt(recorded.goal));
    // Entries recorded before goals were saved: the goal is what the confirmed target pays.
    if (!recorded?.bracket) return undefined;
    const target = BigInt(recorded.bracket.target) * tick;
    const distance = target > entry ? target - entry : entry - target;
    return display((quantity * distance) / U);
  };
  const signedFresh =
    !!trading &&
    control.session.state === "active" &&
    now - trading.receivedAt <= 30000 &&
    trading.sources.every((source) => now - source.time <= 30000);
  const positions: Observation<import("../types").ObservedPosition[]> = trading
    ? {
        state: "observed",
        source: "Perpl signed positions/orders",
        at: trading.receivedAt,
        stale: !signedFresh,
        value: trading.positions.map((p) => {
          const protection = positionProtection(trading, p);
          const trigger = (which: "tp" | "sl") => {
            const leg =
              which === "tp" ? protection.takeProfit : protection.stopLoss;
            const order = trading.orders.find(
              (o) =>
                o.id === leg.orderId && o.market.marketId === p.market.marketId,
            );
            // A move in flight: this command's own, or one Perpl accepted that
            // the signed read has not shown yet.
            const moving =
              control.amending?.marketId === p.market.marketId &&
              control.amending.positionId === p.id &&
              control.amending.which === which
                ? control.amending.value
                : undefined;
            const latest = [...(control.journal?.management ?? [])]
              .reverse()
              .find(
                (op) =>
                  op.kind ===
                    (which === "tp"
                      ? "amend-take-profit"
                      : "amend-stop-loss") &&
                  op.positionId === p.id &&
                  op.payload.mkt === p.market.marketId,
              );
            // Only over a healthy waiting exit, and only for a minute: after that
            // the signed read is the truth, whatever it shows.
            const accepted =
              leg.state === "waiting" &&
              latest?.payload.tp !== undefined &&
              ["submitting", "forwarded"].includes(latest.phase) &&
              order?.triggerPrice !== BigInt(latest.payload.tp) &&
              Date.now() < latest.expiresAt + 60000
                ? latest
                : undefined;
            const next =
              moving ??
              (accepted
                ? BigInt(accepted.payload.tp!) * p.market.tick
                : undefined);
            return {
              price: order?.triggerPrice
                ? display(order.triggerPrice * p.market.tick)
                : undefined,
              status: next === undefined ? leg.state : "changing",
              next: next === undefined ? undefined : display(next),
            };
          };
          return {
            key: `${trading.accountId}:${p.market.marketId}:${p.id}`,
            account: String(trading.accountId),
            nativeId: BigInt(p.id),
            market: p.market.symbol,
            side: p.side === "Long" ? "long" : "short",
            q: display(p.size * p.market.lot),
            E: display(entryPrice({ ...p, tick: p.market.tick })),
            C: display(p.collateral),
            entryFee: display(p.fees),
            F: control.risks[`${p.market.marketId}:${p.id}`]
              ? -display(
                  control.risks[`${p.market.marketId}:${p.id}`].premiumPnl,
                )
              : undefined,
            tp: trigger("tp"),
            sl: trigger("sl"),
            // "active" is the view's word for a position that can be managed now.
            status: signedFresh
              ? "active"
              : "stale · restore access and refresh",
            at: trading.receivedAt,
            goal: goalFor(
              p.market.marketId,
              entryPrice({ ...p, tick: p.market.tick }),
              p.size * p.market.lot,
              p.market.tick,
              p.id,
            ),
          };
        }),
      }
    : control.chainPositions
      ? {
          // Finalized chain read: visible without an API session, managed only with one.
          state: "observed",
          source: "Monad testnet finalized RPC",
          at: control.chainPositions[0]?.blockTime ?? now,
          stale: false,
          value: control.chainPositions.flatMap((p) => {
            const metadata = (p.marketId === 16 ? btc : eth).observation
              ?.metadata;
            if (!metadata) return [];
            return [
              {
                key: `chain:${p.marketId}`,
                account: control.account?.exchangeAccount
                  ? String(control.account.exchangeAccount.id)
                  : undefined,
                market: metadata.symbol,
                side:
                  p.side === "Long" ? ("long" as const) : ("short" as const),
                q: display(p.size * metadata.lot),
                E: display(entryPrice({ ...p, tick: metadata.tick })),
                C: display(p.collateral),
                tp: { status: "restore access to see exits" },
                sl: { status: "restore access to see exits" },
                status: "restore access to manage",
                at: p.blockTime,
                F: -display(p.premiumPnl),
                goal: goalFor(
                  p.marketId,
                  entryPrice({ ...p, tick: metadata.tick }),
                  p.size * metadata.lot,
                  metadata.tick,
                ),
              },
            ];
          }),
        }
      : {
          state: "unavailable",
          reason: !identity.user
            ? "Log in for account details"
            : "Turn on one-tap trading to see position details.",
        };
  const positionCollateral = trading
    ? trading.positions.reduce((sum, p) => sum + p.collateral, 0n)
    : control.chainPositions?.reduce((sum, p) => sum + p.collateral, 0n);
  const detailsReason =
    control.error ??
    identity.reason ??
    (control.session.state === "active"
      ? undefined
      : identity.user
        ? account.state === "observed" && !account.value.exchangeAccount
          ? "New here? Add funds from the balance button to get started."
          : "Turn on one-tap trading to see your account details."
        : "Log in for account details");
  // The last finalized read stays on screen while the next one is in flight. It refreshes
  // every few seconds with or without a session, so it never needs to blank out.
  const data = account.state === "observed" ? account.value : undefined;
  const ledger = {
    wallet: data ? display(data.walletAusd) : NaN,
    free: data?.exchangeAccount ? display(data.exchangeAccount.free) : NaN,
    locked: data?.exchangeAccount ? display(data.exchangeAccount.locked) : NaN,
  };
  const snapshots = { ETH: eth, BTC: btc };
  // The seed is handed to the chart once per market; after that the chart appends ticks.
  const chartHistory = useMemo(
    () =>
      Object.fromEntries(
        (["ETH", "BTC"] as const).map((id) => [
          id,
          line.seed[id]
            ? {
                state: "observed" as const,
                value: line.seed[id]!.map((price) => ({ price, time: 0 })),
                source: "Perpl public marks",
                at: 0,
                stale: false,
              }
            : {
                state: "loading" as const,
                reason: "Reading recent prices…",
              },
        ]),
      ),
    [line.seed.ETH, line.seed.BTC],
  );
  // Every range is read up front and refreshed each minute, so switching never waits.
  // The loader skips a range read within the last minute, so this shorter beat only
  // retries the ones that failed.
  const ethTick = eth.observation?.metadata.tick;
  const btcTick = btc.observation?.metadata.tick;
  useEffect(() => {
    const load = () => {
      for (const market of ["ETH", "BTC"])
        for (const tf of ["1H", "1D", "1W"]) loadChartRange(market, tf);
    };
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [ethTick, btcTick]);
  /** Profit, liquidation and leverage for one open position from public inputs alone. */
  const positionCache = useCache([
    trading,
    control.risks,
    control.chainPositions,
    eth.observation,
    btc.observation,
    signedFresh,
  ]);
  const estimateFor = (symbol: string) =>
    positionCache(`estimate:${symbol}`, () => computeEstimate(symbol));
  const computeEstimate = (symbol: string) => {
    const observation = snapshots[symbol === "BTC" ? "BTC" : "ETH"].observation;
    if (!observation) return undefined;
    const { metadata } = observation;
    const signed = trading?.positions.find((p) => p.market.symbol === symbol);
    const chain = control.chainPositions?.find(
      (p) => p.marketId === metadata.marketId,
    );
    const facts = signed
      ? {
          ...signed,
          tick: signed.market.tick,
          lot: signed.market.lot,
          feesPaid: signed.fees,
          funding: negate(
            control.risks[`${signed.market.marketId}:${signed.id}`]?.premiumPnl,
          ),
        }
      : chain && {
          ...chain,
          tick: metadata.tick,
          lot: metadata.lot,
          funding: -chain.premiumPnl,
        };
    if (!facts) return undefined;
    try {
      const estimate = estimatePosition(
        facts,
        observation.mark,
        accountFee(metadata, 0),
        BigInt(metadata.maintenanceMarginFactor),
      );
      return {
        gross: display(estimate.gross),
        net: display(estimate.net),
        netAfterFunding: display(estimate.net),
        liquidation: display(estimate.liquidation),
        effectiveLeverage:
          estimate.leverage === undefined
            ? undefined
            : Number(estimate.leverage) / 100,
      };
    } catch {
      return undefined;
    }
  };
  const metadataFor = (marketId: number) =>
    trading?.markets.find((m) => m.marketId === marketId) ??
    (marketId === 16 ? btc : marketId === 32 ? eth : undefined)?.observation
      ?.metadata;
  // History and the Result card come only from signed position history.
  const trades = useMemo(
    () => (control.history ? closedTrades(control.history) : undefined),
    [control.history],
  );
  const lastClose = trades?.find((t) => t.final);
  const lastMarket = lastClose && metadataFor(lastClose.marketId);
  const result: PerplEngine["bk"]["result"] =
    lastClose && lastMarket && lastClose.id !== dismissedResult
      ? {
          market: lastMarket.symbol,
          side: lastClose.side,
          reason: lastClose.reason,
          net: display(lastClose.net),
          at: lastClose.block,
          E: display(BigInt(lastClose.entryPrice) * lastMarket.tick),
          ...(lastClose.returned === undefined
            ? {}
            : { ret: display(lastClose.returned) }),
          ...(lastClose.exitPrice === undefined
            ? {}
            : {
                exit: display(BigInt(lastClose.exitPrice) * lastMarket.tick),
              }),
        }
      : null;
  const calculationCache = useCache([
    eth.observation,
    btc.observation,
    control.review,
    data?.exchangeAccount?.free,
    detailsReason,
  ]);
  const computeCalculation = (
    draft: Draft,
  ): ReturnType<PerplEngine["calculate"]> => ({
    public: publicCalculation(
      draft,
      snapshots[draft.market === "BTC" ? "BTC" : "ETH"],
      restored.controller?.get(draft),
      data?.exchangeAccount?.free,
    ),
    details:
      control.review &&
      control.review.draft.revision === draft.rev &&
      tradeReviewFresh(control.review.value)
        ? {
            state: "observed",
            value: authenticatedCalculation(control.review.value, draft),
            source: "Perpl signed account and finalized margin",
            at: control.review.value.account.receivedAt,
            stale: false,
          }
        : {
            state: "unavailable",
            reason: detailsReason ?? "Review to read account details.",
          },
  });
  type Native = NonNullable<typeof trading>["positions"][number];
  /** Liquidation price if `extra` micro AUSD were added to the position's collateral. */
  const liquidationWith = (native: Native, extra: bigint) => {
    const risk = control.risks[`${native.market.marketId}:${native.id}`];
    if (!trading || !risk) return undefined;
    try {
      return display(
        assessProtection(
          {
            state: {
              ...trading,
              positions: trading.positions.map((v) =>
                v === native ? { ...v, collateral: v.collateral + extra } : v,
              ),
            },
            action: {
              kind: "take-profit",
              positionId: native.id,
              marketId: native.market.marketId as 16 | 32,
              trigger: Number(native.entryPrice),
              price: Number(native.entryPrice),
            },
            risk: { ...risk, collateral: risk.collateral + extra },
            sessionId: "",
            sessionExpiresAt: 0,
            reviewExpiresAt: 0,
            ttlBlocks: 0,
          },
          Date.now(),
        )!.liquidation,
      );
    } catch {
      return undefined; // unavailable risk is not zero
    }
  };
  const leverageWith = (native: Native, extra: bigint) =>
    native.collateral + extra > 0n
      ? Number(
          ceil(
            native.entryPrice *
              native.market.tick *
              native.size *
              native.market.lot *
              100n,
            U * (native.collateral + extra),
          ),
        ) / 100
      : undefined;
  const computeMetrics = (
    p: Parameters<PerplEngine["positionMetrics"]>[0],
  ): ReturnType<PerplEngine["positionMetrics"]> => {
    // The public estimate is always available; a fresh signed review refines it.
    const estimate: ReturnType<PerplEngine["positionMetrics"]> =
      estimateFor(p.market) ?? {};
    if (!trading || !signedFresh) return estimate;
    const native = trading.positions.find(
      (value) => value.market.symbol === p.market,
    );
    const observation =
      snapshots[p.market === "BTC" ? "BTC" : "ETH"].observation;
    if (!native || !observation) return estimate;
    const risk = control.risks[`${native.market.marketId}:${native.id}`];
    const liquidation = liquidationWith(native, 0n);
    try {
      const preview = assessCloseReview(
        trading.owner,
        trading,
        native.id,
        observation,
        100,
        risk,
      );
      return {
        effectiveLeverage: leverageWith(native, 0n),
        gross: display(preview.gross),
        net: preview.net === undefined ? undefined : display(preview.net),
        netAfterFunding:
          preview.net === undefined ? undefined : display(preview.net),
        liquidation: liquidation ?? estimate.liquidation,
      };
    } catch {
      return {
        ...estimate,
        liquidation: liquidation ?? estimate.liquidation,
      };
    }
  };
  return {
    kind: "live",
    canEditMarket: (market) => {
      const snapshot = market === "BTC" ? btc : eth;
      return (
        snapshot.status === "ready" &&
        !!snapshot.observation &&
        observationFresh(snapshot.observation, Date.now())
      );
    },
    chartHistory,
    markTick: line.count,
    markets: { ETH: displayMarket(eth), BTC: displayMarket(btc) },
    // The chart's mark follows the gliding line; it falls back to the latest read.
    marks: {
      ETH: Number.isFinite(line.mark.ETH)
        ? line.mark.ETH
        : eth.observation
          ? display(eth.observation.mark)
          : NaN,
      BTC: Number.isFinite(line.mark.BTC)
        ? line.mark.BTC
        : btc.observation
          ? display(btc.observation.mark)
          : NaN,
    },
    refreshAccount: () => {
      void controller?.refresh();
    },
    chartRanges: Object.fromEntries(
      Object.entries(chartRanges).map(([key, value]) => [
        key,
        value.state === "observed"
          ? { ...value, stale: now - (rangeFetched.current[key] ?? 0) > 60000 }
          : value,
      ]),
    ),
    loadChartRange,
    invalidateReviews: () => controller?.invalidate(),
    linkedExits: trading?.orders
      .filter((o) => o.linkedPosition && [3, 4].includes(o.type))
      .map((o) => ({
        id: o.id,
        market: o.market.symbol,
        marketId: o.market.marketId as 16 | 32,
        label: `${o.market.symbol} linked exit ${o.id} · position ${o.linkedPosition}`,
      })),
    reviewCancel: async (id, marketId) => {
      await controller?.reviewCancel(id, marketId);
    },
    recovery: [
      ...(control.journal?.operations ?? [])
        .filter(
          (op) =>
            !op.completion &&
            !["discarded", "rejected", "no-fill"].includes(op.phase),
        )
        .map((op) => ({
          id: op.id,
          management: false,
          phase: op.phase,
          label: `${op.payload.mkt === 32 ? "ETH" : "BTC"} entry · protection ${op.protection} · ledger ${op.history}`,
        })),
      ...(control.journal?.management ?? [])
        .filter(
          (op) =>
            !["discarded", "cancelled", "settled", "rejected"].includes(
              op.phase,
            ),
        )
        .map((op) => ({
          id: op.id,
          management: true,
          phase: op.phase,
          label: `${op.payload.mkt === 32 ? "ETH" : "BTC"} ${op.kind}`,
        })),
    ],
    discardRecovery: async (id, management) => {
      await controller?.discard(id, management);
    },
    authorityRevision: control.authorityRevision,
    sessionStatus: control.session,
    liveStatus: control.error,
    executionAvailable: executionEnabled,
    liveControls: controller ? (
      <LiveControls controller={controller} state={control} />
    ) : null,
    account,
    positions,
    px,
    initialDraft,
    landing,
    balances: data?.exchangeAccount
      ? {
          state: "observed",
          value: ledger,
          source: account.state === "observed" ? account.source : "",
          at: data.blockTime,
          stale: false,
        }
      : {
          state: "unavailable",
          reason:
            account.state !== "observed"
              ? account.reason
              : account.stale
                ? "Account snapshot is stale."
                : "No Perpl account at this block.",
        },
    history: trades
      ? {
          state: "observed",
          source: "Perpl signed position history",
          at: now,
          stale: false,
          value: trades.flatMap((t) => {
            const m = metadataFor(t.marketId);
            return m
              ? [
                  {
                    market: m.symbol,
                    side: t.side,
                    q: display(BigInt(t.lots) * m.lot),
                    E: display(BigInt(t.entryPrice) * m.tick),
                    exit:
                      t.exitPrice === undefined
                        ? NaN
                        : display(BigInt(t.exitPrice) * m.tick),
                    gross: display(t.pnl),
                    net: display(t.net),
                    reason: t.reason,
                    at: t.time ?? now,
                  },
                ]
              : [];
          }),
        }
      : {
          state: "unavailable",
          reason:
            control.session.state === "active"
              ? "Reading trade history…"
              : "Turn on one-tap trading to see your trade history.",
        },
    detailsReason,
    publicReason: storageError,
    draftValue: (current, field) =>
      restored.controller?.raw(current, field) ?? String(current[field]),
    editRawDraft: (current, field, raw, commit) => {
      try {
        if (!restored.controller)
          throw Error(restored.error ?? "Saved sentence unavailable.");
        const tick =
          snapshots[current.market === "BTC" ? "BTC" : "ETH"].observation
            ?.metadata.tick;
        if (commit && field !== "goal" && !tick)
          throw Error("Wait for market precision before saving this price.");
        const next = restored.controller.editRaw(
          current,
          field,
          raw,
          commit,
          tick,
        );
        setStorageError(undefined);
        controller?.invalidate();
        return next;
      } catch (error) {
        setStorageError(
          error instanceof Error
            ? error.message
            : "Sentence could not be saved.",
        );
        return current;
      }
    },
    editDraft: (current, patch) => {
      try {
        // Do not overwrite malformed saved data as a side effect of restoration.
        if (!restored.controller)
          throw Error(restored.error ?? "Saved sentence unavailable.");
        const next = restored.controller.edit(current, patch);
        setStorageError(undefined);
        controller?.invalidate();
        return next;
      } catch (error) {
        setStorageError(
          error instanceof Error
            ? error.message
            : "Sentence could not be saved.",
        );
        return current;
      }
    },
    prepareReview: async (draft) => {
      const observation =
        snapshots[draft.market === "BTC" ? "BTC" : "ETH"].observation;
      if (!controller || !observation) return undefined;
      const review = await controller.reviewDraft(
        restored.controller.get(draft),
        observation,
      );
      return review
        ? {
            id: review.id,
            calculation: authenticatedCalculation(review.value, draft),
            expiresAt: review.admission.reviewExpiresAt,
          }
        : undefined;
    },
    confirmReview: async (id, draft) => {
      const observation =
        snapshots[draft.market === "BTC" ? "BTC" : "ETH"].observation;
      if (!controller || !observation) return unavailable();
      const journal = () => controller.getSnapshot().journal;
      const sentWith: Opening = {
        ops: new Set(journal()?.operations.map((op) => op.id)),
        positions: new Set(
          controller
            .getSnapshot()
            .trading?.positions.map((p) => `${p.market.marketId}:${p.id}`),
        ),
      };
      setOpening(sentWith);
      try {
        const outcome = await controller.confirmEntry(
          id,
          restored.controller.get(draft),
          observation,
        );
        if (outcome.state !== "pending") return outcome;
        // Keep the steps on screen until the stop and target are really registered.
        const entry = () =>
          journal()?.operations.find((op) => op.id === outcome.operationId);
        const trading = () => controller.getSnapshot().trading;
        const deadline = Date.now() + 40000;
        while (
          Date.now() < deadline &&
          entry() &&
          !["rejected", "no-fill"].includes(entry()!.phase) &&
          !entryProtected(journal(), entry(), trading(), sentWith.positions)
        )
          await new Promise((resolve) => setTimeout(resolve, 400));
        const done = entry();
        const position = entryPosition(done, trading(), sentWith.positions);
        if (done && position) {
          const m = metadataFor(done.payload.mkt);
          toast(
            <>
              <b>
                {"You\u2019re in: "}
                {draft.side} {m ? display(position.lots * m.lot) : ""}{" "}
                {draft.market}
              </b>{" "}
              {entryProtected(journal(), done, trading(), sentWith.positions)
                ? "Take profit and stop are set."
                : "Your stop is still being placed."}
            </>,
            "g",
          );
        }
        return outcome;
      } finally {
        setOpening(null);
      }
    },
    reviewClose: async (market, percent) => {
      const observation =
        snapshots[market === "BTC" ? "BTC" : "ETH"].observation;
      const position = trading?.positions.find(
        (p) => p.market.symbol === market,
      );
      if (controller && observation && position)
        await controller.reviewClose(position.id, observation, percent);
    },
    confirmClose: async (id) => {
      const market = control.management?.admission.action.marketId;
      const observation = snapshots[market === 16 ? "BTC" : "ETH"].observation;
      return controller
        ? controller.confirmManagement(id, observation)
        : unavailable();
    },
    closeReview: control.management?.close
      ? {
          id: control.management.id,
          expiresAt: control.management.admission.reviewExpiresAt,
          market:
            control.management.admission.action.marketId === 16 ? "BTC" : "ETH",
          q: display(control.management.close.quantity),
          n: Number(control.management.close.lots),
          entry: display(control.management.close.entry),
          net:
            control.management.close.net === undefined
              ? undefined
              : display(control.management.close.net),
          back:
            control.management.close.back === undefined
              ? undefined
              : display(control.management.close.back),
          fees: display(control.management.close.fees),
          bound: display(control.management.close.bound),
          reason: control.management.close.reason,
        }
      : undefined,
    reviewProtection: async (market, which, raw) => {
      const position = trading?.positions.find(
        (p) => p.market.symbol === market,
      );
      if (controller && position)
        await controller.reviewProtection(
          position.id,
          position.market.marketId as 16 | 32,
          which,
          raw,
        );
    },
    moveProtection: async (market, which, raw) => {
      const position = trading?.positions.find(
        (p) => p.market.symbol === market,
      );
      if (!controller || !position) return unavailable();
      const outcome = await controller.moveProtection(
        position.id,
        position.market.marketId as 16 | 32,
        which,
        raw,
      );
      if (outcome.state === "unknown" || outcome.state === "unavailable")
        toast(
          <>
            <b>
              {which === "tp" ? "Take profit" : "Stop"} change not confirmed
            </b>{" "}
            {outcome.reason ?? "Check your exits before trying again."}
          </>,
          "r",
        );
      return outcome;
    },
    confirmProtection: async (id, immediate) =>
      controller
        ? controller.confirmManagement(id, undefined, immediate)
        : unavailable(),
    reviewCollateral: async (market, amount) => {
      const position = trading?.positions.find(
        (p) => p.market.symbol === market,
      );
      if (!controller || !position) return undefined;
      return (
        await controller.reviewCollateral(
          position.id,
          position.market.marketId as 16 | 32,
          amount,
        )
      )?.id;
    },
    confirmCollateral: async (id) =>
      controller ? controller.confirmManagement(id) : unavailable(),
    collateralReview: control.management?.collateral
      ? {
          id: control.management.id,
          expiresAt: control.management.admission.reviewExpiresAt,
          market:
            control.management.admission.action.marketId === 16 ? "BTC" : "ETH",
          amount: display(control.management.collateral.amount),
          before: display(control.management.collateral.before),
          after: display(control.management.collateral.after),
          left: display(control.management.collateral.left),
        }
      : undefined,
    protectionReview:
      control.management &&
      !control.management.close &&
      !control.management.collateral
        ? {
            id: control.management.id,
            expiresAt: control.management.admission.reviewExpiresAt,
            immediate: control.management.immediate ?? false,
          }
        : undefined,
    calculate: (draft) => {
      const observation =
        snapshots[draft.market === "BTC" ? "BTC" : "ETH"].observation;
      return calculationCache(
        [
          draft.market,
          draft.side,
          draft.goal,
          draft.target,
          draft.stop,
          draft.lev,
          draft.rev,
          // The two answers that change with the clock alone.
          !!control.review && tradeReviewFresh(control.review.value),
          !!observation && observationFresh(observation, Date.now()),
        ].join("|"),
        () => computeCalculation(draft),
      );
    },
    gate: async () => {
      if (!identity.user) identity.login();
      return false;
    },
    command: async (name) => {
      if (!controller) {
        identity.login();
        return { state: "unavailable", reason: "Log in for account details" };
      }
      if (name === "enroll" || name === "fund") {
        controller.control(name);
        return { state: "accepted" };
      }
      await controller.recover();
      return { state: "pending", reason: controller.getSnapshot().error };
    },
    roundTick: (p, m) => Math.round(p / m.tick) * m.tick,
    fixP: (p, m) => +p.toFixed(m.dp),
    seedLive: () => [],
    genRange: () => [],
    tfChange: (market, tf) => {
      const series = chartRanges[market + tf];
      return series?.state === "observed" && series.value.length > 1
        ? (series.value.at(-1)!.price / series.value[0].price - 1) * 100
        : NaN;
    },
    reviewDebit: () => undefined,
    amendPreview: (p, which, price, mark) => {
      const direction = p.side === "long" ? 1 : -1;
      const liquidation = estimateFor(p.market)?.liquidation;
      const tick = snapshots[p.market === "BTC" ? "BTC" : "ETH"].observation
        ? display(
            snapshots[p.market === "BTC" ? "BTC" : "ETH"].observation!.metadata
              .tick,
          )
        : 0;
      return {
        gross: direction * p.q * (price - p.E),
        immediate:
          which === "tp"
            ? direction * (price - mark) <= 0
            : direction * (price - mark) >= 0,
        badStop:
          which === "sl" &&
          liquidation !== undefined &&
          direction *
            (price - (liquidation + direction * Math.max(tick, mark * 0.01))) <
            0,
      };
    },
    positionMetrics: (p) =>
      positionCache(`metrics:${p.market}`, () => computeMetrics(p)),
    totalPositionNet: (() => {
      if (positions.state !== "observed" || !positions.value.length)
        return undefined;
      let total = 0;
      for (const p of positions.value) {
        const net = estimateFor(p.market)?.net;
        if (net === undefined) return undefined; // one unknown makes the total unknown
        total += net;
      }
      return total;
    })(),
    // The review's rule: a stop keeps at least 1% of the mark between itself and liquidation.
    stopBuffer: (m, mark) =>
      Number.isFinite(mark) ? Math.max(m.tick, mark * 0.01) : undefined,
    // Shown while typing. The send still goes through a fresh signed read.
    collateralPreview: (p, amount) => {
      const native =
        trading && signedFresh
          ? trading.positions.find((v) => v.market.symbol === p.market)
          : undefined;
      if (!trading || !native) return {};
      const before = {
        before: liquidationWith(native, 0n),
        leverageBefore: leverageWith(native, 0n),
      };
      if (!Number.isFinite(amount) || amount <= 0 || amount > 9e9)
        return before;
      const extra = BigInt(Math.round(amount * 1e6));
      return {
        ...before,
        after: liquidationWith(native, extra),
        collateral: display(native.collateral + extra),
        leverageAfter: leverageWith(native, extra),
        remaining:
          extra <= trading.free ? display(trading.free - extra) : undefined,
      };
    },
    closePreview: () => ({}),
    fundingLabel: () => "—",
    accountTotals: {
      // Collateral is known exactly; unrealized P&L is not part of this total.
      value:
        data?.exchangeAccount &&
        (!data.exchangeAccount.hasPosition || positionCollateral !== undefined)
          ? display(data.exchangeAccount.balance + (positionCollateral ?? 0n))
          : undefined,
      free: data?.exchangeAccount
        ? display(data.exchangeAccount.free)
        : undefined,
      locked: data?.exchangeAccount
        ? data.exchangeAccount.hasPosition && positionCollateral === undefined
          ? undefined
          : display(data.exchangeAccount.locked + (positionCollateral ?? 0n))
        : undefined,
      wallet: data ? display(data.walletAusd) : undefined,
    },
    accountAmount: accountAmountDisplay,
    transferRawAccount: async (kind, amount) => {
      if (!controller)
        return { state: "unavailable", reason: "Log in for account details" };
      const prepared = await controller.fundingReview(
        kind === "withdraw" ? "withdraw" : "deposit",
        amount,
      );
      if (prepared) controller.control("fund", true);
      return { state: "pending" };
    },
    transferAccount: async (kind, amount) => {
      if (!controller)
        return { state: "unavailable", reason: "Log in for account details" };
      const prepared = await controller.fundingReview(
        kind === "withdraw" ? "withdraw" : "deposit",
        String(amount),
      );
      if (prepared) controller.control("fund", true);
      return { state: "pending" };
    },
    exportWallet: async () => {
      if (!identity.export)
        return {
          state: "unavailable",
          reason: "Wait for wallet provider readiness.",
        };
      await identity.export();
      return { state: "accepted" };
    },
    // The access key stays stored for this wallet, so logging back in restores it.
    logout: () => identity.logout(),
    authLayer:
      setupOpen && (identity.setup || identity.selectWallets?.length) ? (
        <Sheet
          title={
            identity.selectWallets?.length
              ? "Choose your Monad wallet"
              : "Set up your Monad wallet"
          }
          onClose={() => setSetupOpen(false)}
        >
          <p className="ep-note">
            Create an embedded Ethereum wallet for this login. Account funding
            and Perpl access require separate reviews.
          </p>
          {identity.selectWallets?.map((address) => (
            <button
              key={address}
              className="ghost solid"
              onClick={() => {
                identity.selectWallet?.(address);
                setSetupOpen(false);
              }}
            >
              {address.slice(0, 6)}…{address.slice(-4)}
            </button>
          ))}
          {identity.setup && (
            <button
              className="big"
              disabled={setupBusy}
              onClick={async () => {
                setSetupBusy(true);
                try {
                  await identity.setup?.();
                  setSetupOpen(false);
                } catch {
                  setSetupError(
                    "Wallet creation did not complete. Restore provider access before retrying.",
                  );
                } finally {
                  setSetupBusy(false);
                }
              }}
            >
              Create embedded wallet
            </button>
          )}
          {setupError && (
            <p role="alert" className="ep-note">
              {setupError}
            </p>
          )}
        </Sheet>
      ) : null,
    oneTapSheet: () => null,
    bk: {
      result,
      toasts,
      steps: openingSteps(control.journal, control.trading, opening),
      clearResult: () => {
        if (!lastClose) return;
        setDismissedResult(lastClose.id);
        try {
          localStorage.setItem(resultKey, lastClose.id);
        } catch {
          /* The card simply reappears after a reload. */
        }
      },
      open: noWrite,
      close: noWrite,
      margin: noWrite,
      amend: noWrite,
      toast,
    },
  };
}
