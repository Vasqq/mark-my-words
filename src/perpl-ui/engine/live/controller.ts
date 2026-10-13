import type { Hex } from "viem";
import { executionEnabled } from "../../../../server/order-wire.mjs";
import {
  readTestnetAccount,
  type TestnetAccount,
} from "../../../perpl-account";
import {
  createFundingApplication,
  type FundingAttempt,
  type FundingWallet,
  unresolved,
} from "../../../funding-application";
import {
  reviewFunding,
  reviewTestAusd,
  reviewOrderForwarding,
  type FundingReview,
} from "../../../perpl-funding";
import {
  createPerplSession,
  type SessionTypedData,
  type SessionStatus,
} from "../../../perpl-session";
import {
  readTradingState,
  tradingStateFresh,
  type TradingState,
} from "../../../perpl-trading-state";
import {
  assessPublicTradeReview,
  tradeReviewFresh,
  type TradeReview,
} from "../../../perpl-trade-review";
import { reviewPublicSizing } from "../../../perpl-sizing";
import {
  readOrderHistory,
  type OrderHistory,
} from "../../../perpl-order-history";
import {
  createOrderApplication,
  type OrderAdmission,
} from "../../../order-application";
import {
  managementUnresolved,
  operationUnresolved,
  matchingRecordedProtection,
  type Journal,
} from "../../../order-journal";
import {
  assessProtection,
  bracketAction,
  initialProtectionAction,
  observedEntryPosition,
  lifecycleUnavailable,
  managementPayload,
  positionProtection,
  readPositionRisk,
  readChainPositions,
  type ChainPosition,
  type ManagementAdmission,
  type PositionRisk,
} from "../../../perpl-lifecycle";
import { assessCloseReview } from "../../../perpl-close-review";
import { decimal } from "../../../financial-model";
import { RequestDeferred } from "../../../perpl-request-budget";
import type { PublicDraft } from "../../../public-draft";
import type { PublicMarketObservation } from "../../../perpl-market-data";
import type { CommandOutcome } from "../types";

const encode = (value: unknown) =>
  JSON.stringify(value, (_, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );
export interface LiveControllerState {
  account?: TestnetAccount;
  chainPositions?: ChainPosition[];
  history?: OrderHistory;
  trading?: TradingState;
  session: SessionStatus;
  funding?: { id: string; review: FundingReview; revision: string | null };
  attempt?: FundingAttempt | null;
  journal?: Journal | null;
  review?: {
    id: string;
    draft: PublicDraft;
    value: TradeReview;
    admission: OrderAdmission;
  };
  management?: {
    id: string;
    admission: ManagementAdmission;
    close?: ReturnType<typeof assessCloseReview>;
    immediate?: boolean;
    // Micro AUSD, from the signed read this review was made on.
    collateral?: {
      amount: bigint;
      before: bigint;
      after: bigint;
      left: bigint;
    };
  };
  risks: Record<string, PositionRisk>;
  // An exit being moved right now, shown at its new price until a signed read confirms or refutes it.
  amending?: {
    marketId: number;
    positionId: number;
    which: "tp" | "sl";
    value: bigint;
  };
  busy: boolean;
  error?: string;
  control?: "fund" | "enroll" | "manage" | "owner-recovery";
  authorityRevision: number;
}
/** Single observer and command controller over the existing applications. React renders its subscribed snapshot. */
export function createLiveController(
  owner: string,
  wallet: () => FundingWallet | undefined,
  sign: () => ((data: SessionTypedData) => Promise<Hex>) | undefined,
) {
  let session = createPerplSession(owner);
  const funding = createFundingApplication(owner);
  const orders = createOrderApplication(owner, {
    sender: (body) => session.submit(body),
  });
  let state: LiveControllerState = {
    session: { state: "idle" },
    risks: {},
    busy: false,
    authorityRevision: 0,
  };
  const listeners = new Set<() => void>();
  let disposed = false;
  let generation = 0;
  let pending: Promise<unknown> | undefined;
  let pendingIsBackground = false;
  let taskAbort: AbortController | undefined;
  let deferred: ReturnType<typeof setTimeout> | undefined;
  let completeHistory: OrderHistory | undefined;
  const publish = (patch: Partial<LiveControllerState>) => {
    if (!disposed) {
      state = { ...state, ...patch };
      listeners.forEach((fn) => fn());
    }
  };
  /** Finalized balance and positions. Needs no API session, so it is always showable. */
  const readChain = async (token = generation) => {
    const account = await readTestnetAccount(owner);
    if (token !== generation || disposed) return;
    publish({ account });
    try {
      const chainPositions = account.exchangeAccount
        ? await readChainPositions(account.exchangeAccount.id)
        : [];
      if (token === generation && !disposed) publish({ chainPositions });
    } catch {
      /* Positions stay explicitly unavailable; never shown as none. */
    }
  };
  const invalidate = () => {
    generation++;
    publish({
      review: undefined,
      management: undefined,
      funding: undefined,
      authorityRevision: state.authorityRevision + 1,
    });
  };
  const sync = () =>
    publish({
      session: session.status(),
      attempt: funding.read(),
      journal: orders.read(),
      history: completeHistory,
    });
  const run = async <T>(
    work: () => Promise<T>,
    background = false,
  ): Promise<T | undefined> => {
    // A background refresh must never turn a user command into a silent no-op.
    // A user command waits its turn behind a refresh or a protection pass; dropping it
    // would look like a button that did nothing. Background work never queues.
    while (pending && (!background || pendingIsBackground)) {
      if (background) return undefined;
      await pending.catch(() => {});
    }
    if (disposed || pending) return undefined;
    pendingIsBackground = background;
    if (!background) publish({ busy: true, error: undefined });
    taskAbort = new AbortController();
    const promise = work();
    pending = promise;
    try {
      return await promise;
    } catch (cause) {
      if (!background)
        publish({
          error:
            cause instanceof Error
              ? cause.message
              : "The outcome could not be verified. Preserve the recovery record.",
        });
      return undefined;
    } finally {
      pending = undefined;
      pendingIsBackground = false;
      taskAbort = undefined;
      try {
        sync();
      } catch (cause) {
        publish({
          error:
            cause instanceof Error ? cause.message : "Saved state unavailable.",
        });
      }
      if (!background) publish({ busy: false });
    }
  };
  const active = () => {
    const identity = session.identity();
    if (!identity)
      throw Error(
        "Restore 24-hour account access before reviewing this action.",
      );
    return identity;
  };
  const readState = async (
    priority: "observation" | "recovery" = "observation",
  ) => {
    const token = generation;
    let account: TestnetAccount | undefined;
    const trading = await session.snapshot(
      () =>
        readTradingState(
          owner,
          (route, signal) => session.read(route, signal, priority),
          {
            signal: taskAbort?.signal,
            readChain: async (address, options) => {
              account = await readTestnetAccount(address, options);
              return account;
            },
          },
        ),
      priority,
    );
    if (token !== generation || disposed)
      throw Error("Account changed during signed reads.");
    publish({ account });
    return trading;
  };
  const observed = async (
    priority: "observation" | "recovery" = "observation",
  ) => {
    const token = generation;
    const next = await readState(priority);
    if (disposed || token !== generation)
      throw Error("Account activity changed during the read. Refresh again.");
    publish({ trading: next });
    const risks: Record<string, PositionRisk> = {};
    await Promise.all(
      next.positions.map(async (p) => {
        try {
          risks[`${p.market.marketId}:${p.id}`] = await readPositionRisk(
            next,
            p.id,
            { signal: taskAbort?.signal },
            p.market.marketId as 16 | 32,
          );
        } catch {
          /* Funding/risk remains explicitly unavailable. Reduce-only recovery does not require it. */
        }
      }),
    );
    if (disposed || token !== generation)
      throw Error("Account activity changed during risk reads.");
    publish({ risks });
    return next;
  };
  const freshAdmission = (
    trading: TradingState,
    action: ManagementAdmission["action"],
    risk?: PositionRisk,
  ): ManagementAdmission => {
    const identity = active();
    const metadata = trading.markets.find(
      (m) => m.marketId === (action.marketId ?? 32),
    );
    if (!metadata?.orderTtlBlocks)
      throw Error("Fresh execution expiry unavailable.");
    return {
      state: trading,
      action,
      risk,
      sessionId: identity.id,
      sessionExpiresAt: identity.expiresAt,
      reviewExpiresAt: Date.now() + 10000,
      ttlBlocks: metadata.orderTtlBlocks,
    };
  };
  const scheduleRecovery = (delay: number): void => {
    clearTimeout(deferred);
    deferred = setTimeout(
      () => {
        if (disposed) return;
        if (pending) {
          scheduleRecovery(250);
          return;
        }
        void run(recover);
      },
      Math.max(1, delay),
    );
  };
  // Only original durably confirmed bracket intent is eligible for automatic initial placement.
  const protect = async () => {
    if (!executionEnabled) return;
    const journal = orders.read();
    for (const entry of journal?.operations ?? []) {
      if (!entry.bracket || entry.completion) continue;
      const settled =
        !!entry.filled && !!entry.positionId && entry.history === "settled";
      // Not settled from history yet: go by Perpl's live signed snapshot instead.
      if (!settled && entry.phase !== "forwarded") continue;
      for (const kind of ["stop-loss", "take-profit"] as const) {
        // Recovery just produced this reconciled snapshot and finalized risk. Reuse it
        // for preparation; dispatch still independently re-reads all three sources.
        const trading =
          state.trading &&
          tradingStateFresh(state.trading) &&
          state.trading.reconciled
            ? state.trading
            : await observed("recovery");
        const p = settled
          ? trading.positions.find(
              (p) =>
                p.id === entry.positionId &&
                p.market.marketId === entry.payload.mkt,
            )
          : observedEntryPosition(entry, trading);
        if (!p) continue; // Flat is not settlement; retain the journal barrier.
        if (
          p.side !== (entry.payload.t === 1 ? "Long" : "Short") ||
          p.size > BigInt(settled ? entry.filled : entry.payload.s)
        )
          throw Error(
            "Exposure changed beyond the original confirmed fill. Review protection separately.",
          );
        const leg =
          kind === "stop-loss"
            ? positionProtection(trading, p).stopLoss
            : positionProtection(trading, p).takeProfit;
        if (leg.state !== "missing") continue;
        const previous = orders
          .read()
          ?.management?.filter(
            (op) =>
              op.positionId === p.id &&
              op.payload.mkt === p.market.marketId &&
              op.kind === kind,
          );
        // Never resend after uncertainty or cancellation. A rejected request was provably not
        // placed, so it may be re-issued; an expired never-sent preparation is discarded.
        const live = previous?.filter(
          (op) => !["discarded", "rejected"].includes(op.phase),
        );
        if (live?.length) {
          const unsent = live.find((op) => op.phase === "prepared");
          if (unsent && live.length === 1 && Date.now() >= unsent.expiresAt)
            await orders.management.discard(unsent.id);
          else {
            if (unsent && Date.now() < unsent.expiresAt) {
              scheduleRecovery(unsent.expiresAt - Date.now() + 1);
            }
            continue;
          }
        }
        const action = settled
          ? initialProtectionAction(
              entry,
              trading,
              orders.read()?.management ?? [],
              kind,
            )
          : bracketAction(p, entry.bracket, kind);
        if (!action) continue;
        const risk = state.risks[`${p.market.marketId}:${p.id}`];
        const input = freshAdmission(trading, action, risk);
        // Original intent may now be satisfied. Do not silently turn a delayed review into an immediate close.
        if (assessProtection(input, Date.now())?.immediate)
          throw Error(
            "Original protection condition is already satisfied. Review the immediate trigger or bounded close explicitly.",
          );
        managementPayload(owner, input, Date.now());
        const op = await orders.management.prepare(input);
        // Send the exact input just prepared. A second read here would change the bound
        // mark by a tick and strand the stop as prepared-but-unsent.
        await orders.management.dispatch(op.id, async () => input);
        sync();
        // The target of a not-yet-settled entry is placed by the next pass of this loop,
        // once its stop has been seen in a signed read.
        if (kind === "stop-loss" && settled) {
          const token = generation;
          await orders.management.initialTarget(
            entry.id,
            op.id,
            async () => {
              const current = await observed("recovery");
              return freshAdmission(
                current,
                action,
                state.risks[`${p.market.marketId}:${p.id}`],
              );
            },
            () => {
              if (
                token !== generation ||
                active().id !== input.sessionId ||
                disposed
              )
                throw Error(
                  "Authority changed before original target dispatch.",
                );
            },
          );
        }
        // Target acknowledgment remains pending until a later positive signed readback. Budget may defer that read.
        await reconcile();
      }
    }
  };
  const reconcile = async (forceHistory = false) => {
    const journal = orders.read();
    const entries = journal?.operations.filter(operationUnresolved) ?? [];
    const management = journal?.management?.filter(managementUnresolved) ?? [];
    if (!entries.length && !management.length) return;
    // Coalesce one complete history and one fresh state across ALL operations; never poll each operation independently.
    const historyRequired =
      forceHistory ||
      !completeHistory ||
      entries.some((op) => op.history !== "settled" || !op.positionId) ||
      // Only an unresolved close, amend or cancel needs history; finished ones do not.
      management.some((op) => !["stop-loss", "take-profit"].includes(op.kind));
    let history = historyRequired
      ? await readOrderHistory(session.history, taskAbort?.signal)
      : completeHistory!;
    if (historyRequired && history.complete) completeHistory = history;
    const trading = await observed("recovery");
    if (
      !historyRequired &&
      (entries.some(
        (entry) =>
          !trading.positions.some(
            (p) =>
              p.id === entry.positionId &&
              p.market.marketId === entry.payload.mkt,
          ),
      ) ||
        (journal?.management ?? []).some(
          (op) =>
            op.phase === "observed" &&
            !matchingRecordedProtection(op, trading, journal?.management)
              .length,
        ) ||
        trading.lastRequestId > (journal?.highWater ?? 0))
    ) {
      history = await readOrderHistory(session.history, taskAbort?.signal);
      if (history.complete) completeHistory = history;
    }
    const readers = {
      state: async () => trading,
      history: async () => history,
    };
    for (const op of [...management].sort(
      (a, b) =>
        Number(["close", "partial-close"].includes(b.kind)) -
        Number(["close", "partial-close"].includes(a.kind)),
    ))
      if (op.phase !== "prepared")
        await orders.management.reconcile(op.id, readers);
    for (const op of orders.read()?.management?.filter(managementUnresolved) ??
      [])
      if (
        op.phase !== "prepared" &&
        !management.some((previous) => previous.id === op.id)
      )
        await orders.management.reconcile(op.id, readers);
    for (const op of entries)
      if (op.phase !== "prepared") await orders.reconcile(op.id, readers);
    sync();
  };
  // Fills, positions and protective orders are indexed after the acknowledgment. Keep
  // reconciling while anything is in flight; reads never resend an order.
  const inFlight = () => {
    const journal = orders.read();
    const moving = ["submitting", "forwarded", "unknown"];
    return (
      !!journal &&
      (journal.operations.some(
        (op) =>
          moving.includes(op.phase) ||
          (op.filled > 0 && !op.positionId && !op.completion),
      ) ||
        (journal.management ?? []).some(
          (op) => moving.includes(op.phase) || op.phase === "prepared",
        ) ||
        // A position that ended but is not yet settled from history.
        (!!state.trading &&
          journal.operations.some(
            (entry) =>
              !!entry.positionId &&
              !entry.completion &&
              !state.trading!.positions.some(
                (p) =>
                  p.id === entry.positionId &&
                  p.market.marketId === entry.payload.mkt,
              ),
          )) ||
        // An open bracketed position without its stop is never a resting state.
        journal.operations.some((entry) => {
          if (!entry.bracket || !entry.positionId || entry.completion)
            return false;
          const position = state.trading?.positions.find(
            (p) =>
              p.id === entry.positionId &&
              p.market.marketId === entry.payload.mkt,
          );
          return (
            !!position &&
            !!state.trading &&
            positionProtection(state.trading, position).stopLoss.state ===
              "missing"
          );
        }))
    );
  };
  let followUps = 0;
  const followUp = () => {
    if (!inFlight()) followUps = 0;
    else if (followUps < 24)
      // Each pass can cost a dozen signed reads; back off so retries fit the minute budget.
      scheduleRecovery([2500, 5000, 9000, 14000][followUps++] ?? 20000);
  };
  const recover = async (forceHistory = false) => {
    try {
      await reconcile(forceHistory);
      await protect();
      followUp();
    } catch (cause) {
      if (cause instanceof RequestDeferred)
        scheduleRecovery(cause.retryAt - Date.now());
      else followUp();
      throw cause;
    }
  };
  const controller = {
    getSnapshot: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    invalidate() {
      taskAbort?.abort();
      invalidate();
    },
    tick() {
      try {
        const next = session.status();
        if (next.state !== state.session.state) {
          invalidate();
          publish({ session: next });
        }
        if (
          state.review &&
          (Date.now() >= state.review.admission.reviewExpiresAt ||
            !tradeReviewFresh(state.review.value))
        )
          invalidate();
        if (
          state.management &&
          Date.now() >= state.management.admission.reviewExpiresAt
        )
          invalidate();
      } catch (cause) {
        invalidate();
        publish({
          session: { state: "blocked" },
          error:
            cause instanceof Error ? cause.message : "Session unavailable.",
        });
      }
    },
    refresh: () =>
      run(async () => {
        invalidate();
        const token = generation;
        // A reload keeps the same key instead of spending another of Perpl's 16.
        await session.restore();
        publish({ session: session.status() });
        await readChain(token);
        if (session.status().state === "active") {
          await observed();
          await recover();
          // History and the last Result come from signed history, journal or not.
          if (!completeHistory) {
            const history = await readOrderHistory(
              session.history,
              taskAbort?.signal,
            );
            if (history.complete) completeHistory = history;
          }
        }
      }),
    control(
      control?: "fund" | "enroll" | "manage" | "owner-recovery",
      keepReviewedFunding = false,
    ) {
      // Dismissal/new intent also invalidates a preflight still awaiting its read.
      if (!control || (control === "fund" && !keepReviewedFunding))
        generation++;
      publish({
        control,
        ...(!control || (control === "fund" && !keepReviewedFunding)
          ? { funding: undefined }
          : {}),
      });
    },
    async fundingReview(
      kind: "deposit" | "withdraw" | "faucet" | "forwarding",
      amount: string,
    ) {
      return run(async () => {
        invalidate();
        const token = generation;
        const revision = funding.read()?.revision ?? null;
        const review =
          kind === "faucet"
            ? await reviewTestAusd(owner)
            : kind === "forwarding"
              ? await reviewOrderForwarding(owner)
              : await reviewFunding(owner, amount, {}, kind);
        if (token !== generation || disposed) return false;
        publish({ funding: { id: crypto.randomUUID(), review, revision } });
        return true;
      });
    },
    async confirmFunding(id: string) {
      return run(async () => {
        const reviewed = state.funding;
        const currentWallet = wallet();
        if (!reviewed || reviewed.id !== id || !currentWallet)
          throw Error("Review funding with the connected owner wallet.");
        invalidate();
        publish({ funding: undefined });
        const attempt = await funding.submit(
          reviewed.review,
          reviewed.revision,
          currentWallet,
          taskAbort?.signal,
        );
        publish({ attempt });
      });
    },
    async checkFunding(hash?: string) {
      return run(async () => {
        invalidate();
        const attempt = await funding.reconcile(hash);
        const account = await readTestnetAccount(owner);
        publish({ attempt, account, funding: undefined });
        if (!unresolved(attempt) && session.status().state === "active")
          await observed();
      });
    },
    prepareSession: () =>
      run(async () => {
        invalidate();
        await session.prepare({
          replaceUnavailable: session.status().state === "unavailable",
        });
      }),
    enroll: () =>
      run(async () => {
        invalidate();
        const signer = sign();
        if (!signer)
          throw Error(
            "Wait for the selected wallet provider before enrollment.",
          );
        await session.enroll(signer);
        // Publish the new status first, or the one-second tick sees a change and invalidates this read.
        publish({ session: session.status() });
        await observed();
        await recover();
      }),
    discardSession() {
      void session.forget();
      session.dispose();
      session = createPerplSession(owner);
      invalidate();
      publish({
        session: { state: "unavailable" },
        error:
          "Local key discarded. The native API key may remain active until expiry; revoke it on Perpl.",
      });
    },
    async reviewDraft(
      draft: PublicDraft,
      observation: PublicMarketObservation,
    ) {
      return run(async () => {
        invalidate();
        const identity = active();
        const token = generation;
        const trading = await observed();
        const sizing = await reviewPublicSizing(
          structuredClone(draft),
          observation,
        );
        const value = assessPublicTradeReview(owner, sizing, trading);
        if (token !== generation) throw Error("Account changed. Review again.");
        const admission = {
          review: value,
          sessionId: identity.id,
          sessionExpiresAt: identity.expiresAt,
          reviewExpiresAt: Date.now() + 10000,
          ttlBlocks: observation.metadata.orderTtlBlocks ?? 0,
        };
        const review = {
          id: crypto.randomUUID(),
          draft: structuredClone(draft),
          value,
          admission,
        };
        publish({ review });
        return review;
      });
    },
    async confirmEntry(
      id: string,
      draft: PublicDraft,
      _observation: PublicMarketObservation,
    ): Promise<CommandOutcome> {
      if (!executionEnabled) {
        publish({ error: lifecycleUnavailable });
        return { state: "unavailable", reason: lifecycleUnavailable };
      }
      const result = await run(async () => {
        const reviewed = state.review;
        if (
          !reviewed ||
          reviewed.id !== id ||
          encode(reviewed.draft) !== encode(draft) ||
          Date.now() >= reviewed.admission.reviewExpiresAt
        )
          throw Error("Refresh and acknowledge the current sentence review.");
        followUps = 0;
        const op = await orders.prepare(reviewed.admission);
        sync();
        // Send exactly what was reviewed seconds ago. Re-sizing against a newer book
        // changes the limit by a tick and fails closed on almost every confirm.
        let sent;
        try {
          sent = await orders.dispatch(op.id, async () => reviewed.admission);
        } catch (cause) {
          // Nothing was sent. Do not leave a prepared record blocking the next review.
          if (
            orders.read()?.operations.find((o) => o.id === op.id)?.phase ===
            "prepared"
          )
            await orders.discard(op.id);
          throw cause;
        }
        sync();
        if (sent.phase === "rejected")
          throw Error("Perpl did not accept the order. Nothing was placed.");
        // Give the indexer a moment so the first reconcile usually sees the fill.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        invalidate();
        await recover();
        return op.id;
      });
      return result
        ? { state: "pending", operationId: result }
        : { state: "unknown", reason: state.error };
    },
    async reviewClose(
      positionId: number,
      observation: PublicMarketObservation,
      percent: 25 | 50 | 100,
    ) {
      return run(async () => {
        invalidate();
        const trading = await observed("recovery");
        const close = assessCloseReview(
          owner,
          trading,
          positionId,
          observation,
          percent,
          state.risks[`${observation.metadata.marketId}:${positionId}`],
        );
        const admission = freshAdmission(trading, close.action);
        const review = { id: crypto.randomUUID(), admission, close };
        publish({ management: review });
        return review;
      });
    },
    async reviewProtection(
      positionId: number,
      marketId: 16 | 32,
      which: "tp" | "sl",
      raw: string,
    ) {
      return run(async () => {
        invalidate();
        const trading = await observed("recovery");
        const p = trading.positions.find(
          (p) => p.id === positionId && p.market.marketId === marketId,
        );
        if (!p) throw Error("Position changed.");
        const { decimal } = await import("../../../financial-model");
        const value = decimal(raw);
        if (value % p.market.tick)
          throw Error("Use an exact native price tick.");
        const trigger = Number(value / p.market.tick);
        const leg =
          which === "tp"
            ? positionProtection(trading, p).takeProfit
            : positionProtection(trading, p).stopLoss;
        if (!["missing", "waiting"].includes(leg.state))
          throw Error(
            "Reconcile the uncertain protective order before changing it.",
          );
        const kind = which === "tp" ? "take-profit" : "stop-loss";
        const price =
          p.side === "Long"
            ? Number((BigInt(trigger) * 9950n + 9999n) / 10000n)
            : Number((BigInt(trigger) * 10050n) / 10000n);
        const action: ManagementAdmission["action"] = leg.orderId
          ? {
              kind:
                kind === "take-profit"
                  ? "amend-take-profit"
                  : "amend-stop-loss",
              marketId,
              positionId,
              orderId: leg.orderId,
              trigger,
              price,
            }
          : { kind, marketId, positionId, trigger, price };
        const admission = freshAdmission(
          trading,
          action,
          state.risks[`${marketId}:${positionId}`],
        );
        const assessment = assessProtection(admission, Date.now());
        const review = {
          id: crypto.randomUUID(),
          admission,
          immediate: assessment?.immediate,
        };
        publish({ management: review });
        return review;
      });
    },
    /** raw is a dollar amount as typed. Nothing is sent until confirmManagement. */
    async reviewCollateral(positionId: number, marketId: 16 | 32, raw: string) {
      return run(async () => {
        invalidate();
        const trading = await observed("recovery");
        const p = trading.positions.find(
          (p) => p.id === positionId && p.market.marketId === marketId,
        );
        if (!p) throw Error("Position changed.");
        const amount = decimal(raw);
        if (amount <= 0n) throw Error("Enter an amount above zero.");
        if (amount > trading.free)
          throw Error("That is more than your free balance.");
        const admission = freshAdmission(trading, {
          kind: "add-collateral",
          marketId,
          positionId,
          amount: Number(amount),
        });
        managementPayload(owner, admission, Date.now());
        const review = {
          id: crypto.randomUUID(),
          admission,
          collateral: {
            amount,
            before: p.collateral,
            after: p.collateral + amount,
            left: trading.free - amount,
          },
        };
        publish({ management: review });
        return review;
      });
    },
    /**
     * Review and confirm a moved exit in one step. A trigger the market has already
     * passed is left reviewed, for the explicit acknowledgment.
     */
    async moveProtection(
      positionId: number,
      marketId: 16 | 32,
      which: "tp" | "sl",
      raw: string,
    ): Promise<CommandOutcome | { state: "acknowledge"; id: string }> {
      try {
        try {
          publish({
            amending: { marketId, positionId, which, value: decimal(raw) },
          });
        } catch {
          /* The review below reports the unreadable price. */
        }
        const review = await controller.reviewProtection(
          positionId,
          marketId,
          which,
          raw,
        );
        if (!review) return { state: "unknown", reason: state.error };
        if (review.immediate) return { state: "acknowledge", id: review.id };
        return await controller.confirmManagement(review.id);
      } finally {
        publish({ amending: undefined });
      }
    },
    async reviewCancel(orderId: number, marketId: 16 | 32) {
      return run(async () => {
        invalidate();
        const trading = await observed("recovery");
        const admission = freshAdmission(trading, {
          kind: "cancel",
          marketId,
          orderId,
        });
        managementPayload(owner, admission, Date.now());
        const review = { id: crypto.randomUUID(), admission };
        publish({ management: review, control: "manage" });
        return review;
      });
    },
    async confirmManagement(
      id: string,
      _observation?: PublicMarketObservation,
      acknowledgeImmediate = false,
    ): Promise<CommandOutcome> {
      if (!executionEnabled) {
        publish({ error: lifecycleUnavailable });
        return { state: "unavailable", reason: lifecycleUnavailable };
      }
      const result = await run(async () => {
        const reviewed = state.management;
        if (
          !reviewed ||
          reviewed.id !== id ||
          Date.now() >= reviewed.admission.reviewExpiresAt
        )
          throw Error("Position review expired. Refresh before confirming.");
        let input = { ...reviewed.admission, acknowledgeImmediate };
        if (input.action.kind === "add-collateral") {
          // Collateral binds no price, so it is prepared and sent from a fresh signed
          // read taken now: the position must still be open and the amount still free.
          // The one read is used for both, so the two can never disagree.
          publish({ management: undefined });
          input = {
            ...freshAdmission(await observed("recovery"), input.action),
            acknowledgeImmediate,
          };
          managementPayload(owner, input, Date.now());
        }
        const moved = input.action;
        const tick = input.state.markets.find(
          (m) => m.marketId === moved.marketId,
        )?.tick;
        if (
          tick &&
          moved.marketId &&
          (moved.kind === "amend-take-profit" ||
            moved.kind === "amend-stop-loss" ||
            moved.kind === "take-profit" ||
            moved.kind === "stop-loss")
        )
          publish({
            amending: {
              marketId: moved.marketId,
              positionId: moved.positionId,
              which: moved.kind.endsWith("take-profit") ? "tp" : "sl",
              value: BigInt(moved.trigger) * tick,
            },
          });
        followUps = 0;
        const op = await orders.management.prepare(input);
        let sent;
        try {
          sent = await orders.management.dispatch(op.id, async () => input);
        } catch (cause) {
          // Nothing was sent. A stranded prepared close would block the next close.
          if (
            orders.read()?.management?.find((o) => o.id === op.id)?.phase ===
            "prepared"
          )
            await orders.management.discard(op.id);
          throw cause;
        }
        if (sent.phase === "rejected")
          throw Error("Perpl did not accept the request. Nothing changed.");
        await new Promise((resolve) => setTimeout(resolve, 1500));
        invalidate();
        await recover();
        return op.id;
      });
      publish({ amending: undefined });
      return result
        ? { state: "pending", operationId: result }
        : { state: "unknown", reason: state.error };
    },
    /** Background refresh of positions and orders. Never invalidates an open review. */
    poll() {
      if (
        disposed ||
        pending ||
        state.review ||
        state.management ||
        state.control ||
        inFlight() // The follow-up loop is already reading; do not spend its budget.
      )
        return;
      // Without a session the balance and positions still refresh from the chain.
      if (session.status().state !== "active") {
        void run(() => readChain(), true);
        return;
      }
      void run(async () => {
        const before = state.trading?.positions
          .map((p) => `${p.market.marketId}:${p.id}:${p.size}`)
          .join();
        const next = await observed();
        const after = next.positions
          .map((p) => `${p.market.marketId}:${p.id}:${p.size}`)
          .join();
        // A position that changed without a command here was closed by a trigger,
        // a liquidation or another client. Read history again and settle it.
        if (before !== undefined && before !== after) await recover(true);
      }, true);
    },
    recover: () =>
      run(async () => {
        active();
        return recover(true);
      }),
    discard: (id: string, management: boolean) =>
      run(async () => {
        invalidate();
        await (management ? orders.management.discard : orders.discard)(id);
      }),
    dispose() {
      disposed = true;
      generation++;
      taskAbort?.abort();
      clearTimeout(deferred);
      session.dispose();
      listeners.clear();
    },
  };
  return controller;
}
