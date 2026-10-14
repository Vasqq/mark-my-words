import { OrderNotSent } from "./perpl-request-budget";
import { testnet } from "./testnet-config";
import { getAddress } from "viem";
import { batchOutcomes } from "./order-application";
import {
  readEntrySettlement,
  rejectedRequest,
  type OrderHistory,
  type SettlementProof,
} from "./perpl-order-history";
import {
  assessProtection,
  initialProtectionAction,
  managementBinding,
  managementPayload,
  observedEntryPosition,
  type ManagementAdmission,
} from "./perpl-lifecycle";
import { tradingStateFresh, type TradingState } from "./perpl-trading-state";
import {
  integer,
  uuid,
  closeConsumed,
  entryConsumed,
  managementUnresolved,
  matchingRecordedProtection,
  refreshRecordedProtection,
  validateManagementPayload,
  type Journal,
  type ManagementOperation,
  type ManagementPayload,
} from "./order-journal";

const digest = async (s: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");

/** Shares the entry journal, counter and account lock. Injection is verification-only until live gates pass. */
export function lifecycleCommands(
  owner: string,
  deps: {
    read(): Journal | null;
    save(journal: Journal): Journal;
    locked<T>(work: () => Promise<T>): Promise<T>;
    fundingClear(): void;
    reconcileEntry(
      id: string,
      readers: {
        state(): Promise<TradingState>;
        history(): Promise<OrderHistory>;
      },
    ): Promise<import("./order-journal").OrderOperation>;
    now(): number;
    sender?: (body: string) => Promise<unknown>;
  },
) {
  async function reviewed(input: ManagementAdmission) {
    const now = deps.now();
    if (
      !uuid(input.sessionId) ||
      input.sessionExpiresAt <= now ||
      input.reviewExpiresAt <= now ||
      input.reviewExpiresAt > now + 10000
    )
      throw Error("Review or session expired. Review the position again.");
    const payload = managementPayload(owner, input, now);
    if (
      assessProtection(input, now)?.immediate &&
      input.acknowledgeImmediate !== true
    )
      throw Error(
        "May trigger immediately. Explicit acknowledgment is required for this reviewed command.",
      );
    return {
      payload,
      binding: await digest(managementBinding(input, payload)),
      expiresAt: Math.min(input.sessionExpiresAt, input.reviewExpiresAt),
    };
  }
  const find = (id: string) => {
    const journal = deps.read();
    const op = journal?.management?.find((v) => v.id === id);
    if (!journal || !op) throw Error("Management record is unavailable.");
    return { journal, op };
  };
  const protective = (op: ManagementOperation) =>
    [
      "take-profit",
      "stop-loss",
      "amend-take-profit",
      "amend-stop-loss",
    ].includes(op.kind);
  function admission(
    journal: Journal,
    input: ManagementAdmission,
    self?: string,
  ) {
    if (
      journal.accountId !== input.state.accountId ||
      input.state.lastRequestId < journal.lastProtocolId
    )
      throw Error("Management account or counter changed. Reconcile first.");
    const changed = refreshRecordedProtection(journal, input.state);
    if (changed) deps.save(journal); // Preserve vanished-family ambiguity even when admission throws.
    const head = input.state.sources.find((s) => s.name === "Wallet")?.block;
    if (
      journal.management?.some(
        (o) =>
          o.id !== self &&
          managementUnresolved(o) &&
          !closeConsumed(o, input.state) &&
          (input.action.kind !== "close" ||
            (["close", "partial-close"].includes(o.kind) &&
              // Past its last execution block (or never sent and expired) it can no
              // longer fill, so it must not make the reduce-only close unreachable.
              !(
                (o.phase === "prepared" && deps.now() >= o.expiresAt) ||
                (o.payload.lb !== 0 &&
                  head !== undefined &&
                  head > o.payload.lb)
              ))),
      )
    )
      throw Error(
        "Resolve the previous management request before submitting another.",
      );
    if (
      input.action.kind !== "close" &&
      journal.operations.some(
        (o) =>
          ["prepared", "submitting", "unknown", "forwarded"].includes(
            o.phase,
          ) &&
          !observedEntryPosition(o, input.state) &&
          !entryConsumed(o, input.state),
      )
    )
      throw Error(
        "Reconcile the entry's actual fill before sizing protective exits.",
      );
  }
  function retireFamily(
    journal: Journal,
    op: ManagementOperation,
    orderId: number,
  ) {
    for (const prior of journal.management ?? [])
      if (
        prior.payload.rq < op.payload.rq &&
        protective(prior) &&
        prior.observedOrderId === orderId &&
        prior.payload.mkt === op.payload.mkt &&
        prior.payload.lp === op.payload.lp &&
        prior.payload.tpc === op.payload.tpc
      ) {
        prior.retiredBy = op.payload.rq;
        prior.phase = op.kind === "cancel" ? "cancelled" : "observed";
      }
  }
  async function prepareUnlocked(frozen: ManagementAdmission) {
    deps.fundingClear();
    const journal = deps.read() ?? {
      version: 1 as const,
      owner: getAddress(owner),
      chainId: 10143 as const,
      exchange: testnet.exchange,
      accountId: frozen.state.accountId,
      highWater: frozen.state.lastRequestId,
      lastProtocolId: frozen.state.lastRequestId,
      operations: [],
    };
    admission(journal, frozen);
    if (
      journal.accountId !== frozen.state.accountId ||
      frozen.state.lastRequestId < journal.lastProtocolId
    )
      throw Error("Management account or counter changed. Reconcile first.");
    const a = await reviewed(frozen);
    const rq = integer(
      Math.max(journal.highWater, frozen.state.lastRequestId) + 1,
      1,
    );
    const action = frozen.action;
    const op: ManagementOperation = {
      id: crypto.randomUUID(),
      binding: a.binding,
      sessionId: frozen.sessionId,
      expiresAt: a.expiresAt,
      protocolId: frozen.state.lastRequestId,
      kind: frozen.action.kind,
      side:
        action.kind === "cancel"
          ? frozen.state.orders.find(
              (o) =>
                o.id === action.orderId &&
                o.market.marketId === (frozen.action.marketId ?? 32),
            )!.type === 3
            ? "Long"
            : "Short"
          : frozen.state.positions.find(
              (p) =>
                p.id === action.positionId &&
                p.market.marketId === (frozen.action.marketId ?? 32),
            )!.side,
      positionId:
        frozen.action.kind === "cancel"
          ? integer(a.payload.lp, 1)
          : frozen.action.positionId,
      // The readback compares against this, so it is recorded before anything is sent.
      ...(action.kind === "add-collateral"
        ? {
            collateralBefore: frozen.state.positions
              .find(
                (p) =>
                  p.id === action.positionId &&
                  p.market.marketId === (action.marketId ?? 32),
              )!
              .collateral.toString(),
          }
        : {}),
      payload: validateManagementPayload({ ...a.payload, rq }),
      phase: "prepared",
      filled: 0,
      settlement: null,
    };
    if (deps.now() >= a.expiresAt) throw Error("Management review expired.");
    journal.management = [...(journal.management ?? []), op];
    journal.highWater = rq;
    journal.lastProtocolId = frozen.state.lastRequestId;
    deps.save(journal);
    return structuredClone(op);
  }
  function prepare(input: ManagementAdmission) {
    const frozen = structuredClone(input);
    return deps.locked(() => prepareUnlocked(frozen));
  }
  async function dispatchUnlocked(
    id: string,
    current: () => Promise<ManagementAdmission>,
  ) {
    if (!deps.sender)
      throw Error(
        "Live management is disabled pending current-wallet recovery and protection evidence.",
      );
    deps.fundingClear();
    const { journal, op } = find(id);
    if (op.phase !== "prepared")
      throw Error(
        "Do not resend an ambiguous management command. Reconcile first.",
      );
    const input = structuredClone(await current());
    admission(journal, input, op.id);
    const a = await reviewed(input);
    const head = integer(
      input.state.sources.find((s) => s.name === "Wallet")?.block,
      1,
    );
    const action = input.action;
    const side =
      action.kind === "cancel"
        ? input.state.orders.find(
            (o) =>
              o.id === action.orderId &&
              o.market.marketId === (action.marketId ?? 32),
          )!.type === 3
          ? "Long"
          : "Short"
        : input.state.positions.find(
            (p) =>
              p.id === action.positionId &&
              p.market.marketId === (action.marketId ?? 32),
          )!.side;
    if (
      op.kind !== action.kind ||
      (op.side ?? "Long") !== side ||
      a.binding !== op.binding ||
      Object.entries(a.payload).some(
        ([key, value]) =>
          key !== "lb" && op.payload[key as keyof ManagementPayload] !== value,
      ) ||
      input.sessionId !== op.sessionId ||
      input.state.lastRequestId !== op.protocolId ||
      deps.now() >= op.expiresAt ||
      (op.payload.lb !== 0 &&
        (head >= op.payload.lb || op.payload.lb > head + input.ttlBlocks))
    )
      throw Error(
        "Position, exits, account, price, session or expiry changed. Review again.",
      );
    op.phase = "submitting";
    deps.save(journal);
    try {
      op.phase = batchOutcomes(
        await deps.sender(JSON.stringify({ d: [op.payload] })),
        1,
      )[0];
    } catch (cause) {
      op.phase = cause instanceof OrderNotSent ? "rejected" : "unknown";
    }
    deps.save(journal);
    return structuredClone(op);
  }
  const dispatch = (id: string, current: () => Promise<ManagementAdmission>) =>
    deps.locked(() => dispatchUnlocked(id, current));
  async function discard(id: string) {
    return deps.locked(async () => {
      const { journal, op } = find(id);
      if (op.phase !== "prepared")
        throw Error("Only an unsent management review may be discarded.");
      op.phase = "discarded";
      deps.save(journal);
    });
  }
  async function reconcile(
    id: string,
    readers: {
      state(): Promise<TradingState>;
      history(): Promise<OrderHistory>;
      settlement?: (
        payload: ManagementPayload,
        hash: `0x${string}`,
      ) => Promise<SettlementProof | null>;
    },
  ) {
    return deps.locked(async () => {
      const { journal, op } = find(id);
      if (
        op.retiredBy !== undefined ||
        [
          "prepared",
          "discarded",
          "rejected",
          "cancelled",
          "settled",
          "superseded",
        ].includes(op.phase) ||
        // A read-back collateral increase is final; later closes may lower collateral again.
        (op.kind === "add-collateral" && op.phase === "observed")
      )
        return structuredClone(op);
      const history = await readers.history();
      const state = await readers.state();
      if (
        getAddress(state.owner) !== owner ||
        state.accountId !== journal.accountId ||
        !state.reconciled ||
        !tradingStateFresh(state, deps.now()) ||
        state.lastRequestId < journal.lastProtocolId
      )
        throw Error(
          "Management history and account are stale or inconsistent.",
        );
      journal.lastProtocolId = state.lastRequestId;
      journal.highWater = Math.max(journal.highWater, state.lastRequestId);
      const p = op.payload;
      if (
        op.filled === 0 &&
        (await rejectedRequest(p, history, state, readers.settlement))
      ) {
        op.phase = "rejected";
        deps.save(journal);
        return structuredClone(op);
      }
      if (
        [
          "take-profit",
          "stop-loss",
          "amend-take-profit",
          "amend-stop-loss",
        ].includes(op.kind)
      ) {
        const matching = matchingRecordedProtection(
          op,
          state,
          journal.management,
        );
        const failed = history.orders.filter(
          (r) =>
            r.account === p.acc && r.market === p.mkt && r.request === p.rq,
        );
        if (
          history.complete &&
          matching.length === 0 &&
          op.observedOrderId === undefined &&
          failed.length === 1 &&
          failed[0].status === 7 &&
          failed[0].reason !== 32 &&
          failed[0].filled === 0 &&
          state.lastRequestId >= p.rq &&
          state.sources.every((s) => s.block >= failed[0].block) &&
          !state.orders.some(
            (o) => o.market.marketId === p.mkt && o.request === p.rq,
          )
        ) {
          op.phase = "rejected";
          deps.save(journal);
          return structuredClone(op);
        }
        if (matching.length === 1 && state.lastRequestId >= p.rq) {
          op.phase = "observed";
          op.observedOrderId = matching[0].id;
          if (p.t === 7) retireFamily(journal, op, matching[0].id);
        }
        if (matching.length === 0 && op.observedOrderId && history.complete) {
          const family = history.orders.filter(
            (r) =>
              r.account === p.acc &&
              r.market === p.mkt &&
              r.order === op.observedOrderId,
          );
          const cancelled = family.filter(
            (r) =>
              r.status === 5 &&
              r.reason === 28 &&
              r.request >= p.rq &&
              r.type === (op.side === "Short" ? 4 : 3) &&
              r.size === p.s &&
              r.price === p.p &&
              r.filled === 0 &&
              BigInt(r.fee) === 0n &&
              r.linkedPosition === p.lp &&
              r.triggerPrice === p.tp &&
              r.triggerCondition === p.tpc,
          );
          if (
            cancelled.length === 1 &&
            cancelled[0].block > 0 &&
            state.lastRequestId >= cancelled[0].request &&
            state.sources.every((s) => s.block >= cancelled[0].block) &&
            family.every(
              (r) =>
                r === cancelled[0] ||
                (r.status === 8 &&
                  r.filled === 0 &&
                  BigInt(r.fee) === 0n &&
                  r.block <= cancelled[0].block),
            ) &&
            !history.fills.some(
              (r) =>
                r.account === p.acc &&
                r.market === p.mkt &&
                r.order === op.observedOrderId,
            ) &&
            !state.orders.some(
              (o) => o.market.marketId === p.mkt && o.id === op.observedOrderId,
            )
          )
            op.phase = "cancelled";
        }
        // Observed registration is not protection execution or settlement. Missing later orders stay unresolved.
        if (matching.length !== 1 && op.phase === "observed")
          op.phase = "unknown";
        // Perpl cancels a position-linked trigger when its position closes. With the
        // position and the order both gone, and the request no longer able to arrive,
        // nothing of it can execute, so it must not block entries forever.
        if (
          managementUnresolved(op) &&
          state.lastRequestId >= p.rq &&
          !state.positions.some(
            (v) => v.id === op.positionId && v.market.marketId === p.mkt,
          ) &&
          !state.orders.some(
            (o) =>
              o.market.marketId === p.mkt &&
              (o.id === op.observedOrderId ||
                o.id === p.oid ||
                o.request === p.rq),
          )
        )
          op.phase = "superseded";
      } else if (op.kind === "add-collateral") {
        const position = state.positions.find(
          (v) => v.id === op.positionId && v.market.marketId === p.mkt,
        );
        const rows = history.orders.filter(
          (r) =>
            r.account === p.acc && r.market === p.mkt && r.request === p.rq,
        );
        if (!position) {
          // Nothing is left to add to. Whatever happened, it can no longer block an entry.
          op.phase = "superseded";
        } else if (
          // The same correlated failure row that rejects a protective order. Reason 32
          // (request id too low) can mean a replay of a request that did execute.
          history.complete &&
          rows.length === 1 &&
          rows[0].type === 6 &&
          rows[0].status === 7 &&
          rows[0].reason !== 32 &&
          rows[0].filled === 0 &&
          rows[0].block > 0 &&
          state.lastRequestId >= p.rq &&
          state.sources.every((s) => s.block >= rows[0].block)
        ) {
          op.phase = "rejected";
        } else if (
          // Not equality: funding or a partial close in between also moves collateral.
          state.lastRequestId >= p.rq &&
          position.collateral >= BigInt(op.collateralBefore!) + BigInt(p.a!)
        ) {
          op.phase = "observed";
        }
        // An acknowledgment alone stays forwarded or unknown until one of the above is read.
      } else if (
        ["close", "partial-close"].includes(op.kind) &&
        history.complete
      ) {
        const rows = history.orders.filter(
          (r) =>
            r.account === p.acc &&
            r.market === p.mkt &&
            r.request === p.rq &&
            r.type === p.t &&
            r.size === p.s &&
            r.price === p.p &&
            [4, 5, 6].includes(r.status),
        );
        const latest = [...rows].sort(
          (a, b) => b.block - a.block || (b.log ?? 0) - (a.log ?? 0),
        )[0];
        if (
          new Set(rows.map((r) => r.order)).size === 1 &&
          latest?.hash &&
          state.lastRequestId >= p.rq &&
          state.sources.every((s) => s.block >= latest.block)
        ) {
          const proof = await (readers.settlement ?? readEntrySettlement)(
            p,
            latest.hash,
          );
          const fills = history.fills.filter(
            (r) =>
              r.account === p.acc &&
              r.market === p.mkt &&
              r.order === latest.order,
          );
          if (
            proof &&
            !proof.rejected &&
            proof.hash.toLowerCase() === latest.hash.toLowerCase() &&
            proof.block === latest.block &&
            proof.filled === latest.filled &&
            fills.reduce((n, r) => n + BigInt(r.filled), 0n) ===
              BigInt(proof.filled) &&
            fills.reduce((n, r) => n + BigInt(r.fee), 0n) ===
              BigInt(proof.fee) &&
            BigInt(latest.fee) === BigInt(proof.fee)
          ) {
            op.phase = "settled";
            op.filled = proof.filled;
            op.settlement = {
              hash: proof.hash,
              block: proof.block,
              orderId: latest.order,
            };
          }
        }
        // Order history and fills can trail position history by half a minute. The
        // position's own event names this request and its transaction; the finalized
        // receipt is then the proof, decoded within this request's segment only.
        const ended = (history.positions ?? []).filter(
          (r) =>
            r.account === p.acc &&
            r.market === p.mkt &&
            r.positionId === op.positionId &&
            r.request === p.rq &&
            r.status === (op.kind === "close" ? 2 : 1),
        );
        const event = ended[0];
        if (
          op.phase !== "settled" &&
          ended.length === 1 &&
          event.hash &&
          event.order > 0 &&
          state.lastRequestId >= p.rq &&
          state.sources.every((s) => s.block >= event.block)
        ) {
          const proof = await (readers.settlement ?? readEntrySettlement)(
            p,
            event.hash,
          );
          if (
            proof &&
            !proof.rejected &&
            proof.filled > 0 &&
            proof.hash.toLowerCase() === event.hash.toLowerCase() &&
            proof.block === event.block &&
            (op.kind === "close" ? !!proof.closed : !!proof.decreased) &&
            (event.closeFee === undefined ||
              BigInt(event.closeFee) === BigInt(proof.fee))
          ) {
            op.phase = "settled";
            op.filled = proof.filled;
            op.settlement = {
              hash: proof.hash,
              block: proof.block,
              orderId: event.order,
            };
          }
        }
        // Past its last execution block a close can no longer execute. It provably did not
        // when no position or account event carries its request and either
        // - no order row carries it either, the order stream is indexed past that block,
        //   and the signed read, also past it, still shows the whole position, or
        // - position history ended the position under another request and any order row
        //   of this request is a refusal with nothing filled.
        const pastWindow =
          state.lastRequestId >= p.rq &&
          state.sources.every((s) => s.block > p.lb);
        const position = state.positions.find(
          (v) => v.id === op.positionId && v.market.marketId === p.mkt,
        );
        const endedElsewhere = (history.positions ?? []).some(
          (r) =>
            r.account === p.acc &&
            r.market === p.mkt &&
            r.positionId === op.positionId &&
            [2, 3, 4, 5].includes(r.status) &&
            r.request !== p.rq,
        );
        const mine = (r: { account: number; request: number }) =>
          r.account === p.acc && r.request === p.rq;
        // A refused request leaves a failed row with nothing filled; it never executed.
        const failedRows = history.orders.filter(mine);
        if (
          managementUnresolved(op) &&
          pastWindow &&
          ![...history.accounts, ...(history.positions ?? [])].some(mine) &&
          !state.orders.some((o) => o.request === p.rq) &&
          ((op.kind === "close" &&
            !failedRows.length &&
            position?.size === BigInt(p.s) &&
            history.orders.some(
              (r) => r.account === p.acc && r.block > p.lb,
            )) ||
            (!position &&
              endedElsewhere &&
              failedRows.every((r) => r.status === 7 && r.filled === 0)))
        )
          op.phase = "rejected";
      }
      if (
        op.kind === "cancel" &&
        history.complete &&
        state.lastRequestId >= p.rq
      ) {
        // Offchain linked-trigger cancellation needs an explicit correlated canceled event as well as absence.
        const cancelled = history.orders.filter(
          (r) =>
            r.account === p.acc &&
            r.market === p.mkt &&
            r.order === p.oid &&
            r.request === p.rq &&
            r.type === (op.side === "Short" ? 4 : 3) &&
            r.status === 5 &&
            r.reason === 28 &&
            r.filled === 0 &&
            BigInt(r.fee) === 0n &&
            r.linkedPosition === p.lp &&
            r.triggerPrice === p.tp &&
            r.triggerCondition === p.tpc,
        );
        if (
          cancelled.length === 1 &&
          history.orders.filter(
            (r) =>
              r.account === p.acc && r.market === p.mkt && r.request === p.rq,
          ).length === 1 &&
          !history.fills.some(
            (r) =>
              r.account === p.acc && r.market === p.mkt && r.order === p.oid,
          ) &&
          cancelled.every(
            (r) =>
              r.block > 0 && state.sources.every((s) => s.block >= r.block),
          ) &&
          !state.orders.some(
            (o) => o.id === p.oid && o.market.marketId === p.mkt,
          )
        ) {
          op.phase = "observed";
          retireFamily(journal, op, p.oid!);
        }
      }
      // The same end as a linked trigger's: with its position and its order gone and the
      // request already processed, a cancellation has nothing left to act on.
      if (
        op.kind === "cancel" &&
        managementUnresolved(op) &&
        state.lastRequestId >= p.rq &&
        !state.positions.some(
          (v) => v.id === op.positionId && v.market.marketId === p.mkt,
        ) &&
        !state.orders.some(
          (o) =>
            o.market.marketId === p.mkt &&
            (o.id === p.oid || o.request === p.rq),
        )
      )
        op.phase = "superseded";
      // Cancellation ACKs and absent orders alone are insufficient.
      if (op.phase === "submitting") op.phase = "unknown";
      deps.save(journal);
      return structuredClone(op);
    });
  }
  /** Canonical opening proof and original stop use one uninterrupted owner lock; no ACK authorizes protection. */
  async function initialStop(
    entryId: string,
    history: () => Promise<OrderHistory>,
    current: () => Promise<ManagementAdmission>,
    stillCurrent: () => void,
  ) {
    return deps.locked(async () => {
      deps.fundingClear();
      const historical = await history();
      const input = structuredClone(await current());
      stillCurrent();
      const entry = await deps.reconcileEntry(entryId, {
        state: async () => structuredClone(input.state),
        history: async () => historical,
      });
      const journal = deps.read();
      if (
        !journal ||
        !historical.complete ||
        !entry.positionId ||
        !entry.filled ||
        entry.history !== "settled" ||
        entry.completion
      )
        throw Error(
          "Canonical original entry fill remains unverified; no stop can be sent.",
        );
      if (
        (journal.management ?? []).some(
          (op) =>
            op.positionId === entry.positionId && op.phase !== "discarded",
        )
      )
        throw Error(
          "Original protection already has a recorded attempt. Do not repeat it.",
        );
      const action = initialProtectionAction(
        entry,
        input.state,
        journal.management ?? [],
        "stop-loss",
      );
      if (!action)
        throw Error("Original filled residual cannot authorize its stop.");
      input.action = action;
      if (assessProtection(input, deps.now())?.immediate)
        throw Error(
          "Original stop condition is already satisfied; review bounded recovery explicitly.",
        );
      stillCurrent();
      const op = await prepareUnlocked(input);
      return dispatchUnlocked(op.id, async () => {
        stillCurrent();
        return structuredClone(input);
      });
    });
  }
  /** One uninterrupted owner lock: independent positive stop readback, original target derivation and immediate send. */
  async function initialTarget(
    entryId: string,
    stopId: string,
    current: () => Promise<ManagementAdmission>,
    stillCurrent: () => void,
  ) {
    return deps.locked(async () => {
      deps.fundingClear();
      const input = structuredClone(await current());
      stillCurrent();
      const { journal, op: stop } = find(stopId);
      const entry = journal.operations.find((o) => o.id === entryId);
      if (
        !entry ||
        stop.kind !== "stop-loss" ||
        !entry.positionId ||
        stop.positionId !== entry.positionId ||
        getAddress(input.state.owner) !== owner ||
        input.state.accountId !== journal.accountId ||
        !input.state.reconciled ||
        !tradingStateFresh(input.state, deps.now()) ||
        input.state.lastRequestId < stop.payload.rq
      )
        throw Error(
          "Original stop and fresh owner authority must be positively observed before target admission.",
        );
      const matching = matchingRecordedProtection(
        stop,
        input.state,
        journal.management,
      );
      if (matching.length !== 1)
        throw Error(
          "Original stop registration remains unverified. The target cannot be sent.",
        );
      stop.phase = "observed";
      stop.observedOrderId = matching[0].id;
      journal.lastProtocolId = input.state.lastRequestId;
      journal.highWater = Math.max(
        journal.highWater,
        input.state.lastRequestId,
      );
      deps.save(journal);
      const action = initialProtectionAction(
        entry,
        input.state,
        journal.management ?? [],
        "take-profit",
      );
      if (!action) return null;
      input.action = action;
      if (assessProtection(input, deps.now())?.immediate)
        throw Error(
          "Original target condition is already satisfied; review an immediate exit explicitly.",
        );
      stillCurrent();
      const op = await prepareUnlocked(input);
      return dispatchUnlocked(op.id, async () => {
        stillCurrent();
        return structuredClone(input);
      });
    });
  }
  return { prepare, dispatch, discard, reconcile, initialStop, initialTarget };
}
