import { assertEntryWithinLimits } from "./testnet-limits";
import { OrderNotSent } from "./perpl-request-budget";
import { reconcileLifecycleCompletion } from "./perpl-lifecycle-settlement";
import { lifecycleCommands } from "./lifecycle-application";
import {
  readEntrySettlement,
  rejectedRequest,
  type OrderHistory,
  type SettlementProof,
} from "./perpl-order-history";
import { tradingStateFresh, type TradingState } from "./perpl-trading-state";
import { getAddress } from "viem";
import {
  accountLock,
  accountLockName,
  type AccountLock,
  type AccountStorage,
} from "./account-coordination";
import { createFundingApplication, unresolved } from "./funding-application";
import { assessTradeReview, type TradeReview } from "./perpl-trade-review";
import { testnet } from "./testnet-config";

import {
  assertEntryAvailable,
  refreshRecordedProtection,
  readOrderJournal,
  orderJournalKey,
  object,
  integer,
  uuid,
  validateEntryPayload,
  type Journal,
  type OrderOperation,
} from "./order-journal";

export interface OrderAdmission {
  review: TradeReview;
  sessionId: string; // Non-secret per-enrollment identity, not the API token.
  sessionExpiresAt: number;
  reviewExpiresAt: number;
  ttlBlocks: number; // Fresh selected-market order_ttl_blocks, never a fixed default.
}
/** Strictly classify each item. A malformed or incomplete batch proves nothing. */
export function batchOutcomes(
  value: unknown,
  count: number,
): ("forwarded" | "rejected")[] {
  const r = object(value);
  const status = object(r.status);
  if (r.mt !== 31 || ![0, 400, 403, 503].includes(integer(status.code)))
    throw Error("Unverified order acknowledgment.");
  if (status.code !== 0) {
    if (
      r.statuses !== undefined &&
      (!Array.isArray(r.statuses) || r.statuses.length)
    )
      throw Error("Conflicting order acknowledgment.");
    return Array.from({ length: count }, () => "rejected");
  }
  if (!Array.isArray(r.statuses) || r.statuses.length !== count)
    throw Error("Incomplete order acknowledgment.");
  return r.statuses.map((row) => {
    const code = integer(object(row).code);
    if (![0, 400, 403, 429, 503].includes(code))
      throw Error("Unknown order acknowledgment.");
    return code === 0 ? "forwarded" : "rejected";
  });
}
async function admission(owner: string, input: OrderAdmission, now: number) {
  const { review: supplied } = input;
  const review = assessTradeReview(
    owner,
    supplied.sizing,
    supplied.account,
    now,
  );
  if (review.blockers.length) throw Error(review.blockers.join(" "));
  if (
    !uuid(input.sessionId) ||
    input.sessionExpiresAt <= now ||
    input.reviewExpiresAt <= now ||
    input.reviewExpiresAt > now + 10000
  )
    throw Error("Order review or session is unavailable. Review again.");
  const { size, intent, observation } = review.sizing;
  const metadata = observation.metadata;
  assertEntryWithinLimits({
    marketId: metadata.marketId,
    side: intent.side,
    leverage: intent.leverage,
    stop: intent.stop,
  });
  const head = integer(
    review.account.sources.find((s) => s.name === "Wallet")?.block,
    1,
  );
  const ttl = integer(input.ttlBlocks, 1);
  const wire = (value: bigint, unit: bigint) => {
    if (value % unit)
      throw Error("Order price or size is not exactly representable.");
    return integer(Number(value / unit), 1);
  };
  const payload = {
    acc: review.account.accountId,
    mkt: metadata.marketId,
    t: intent.side === "long" ? 1 : 2,
    p: wire(size.limit, metadata.tick),
    s: wire(size.quantity, metadata.lot),
    lv: Number(intent.leverage),
    fl: 4,
    mnp: 50,
    lb: integer(head + ttl, 1),
  };
  const binding = JSON.stringify(
    {
      chain: 10143,
      exchange: testnet.exchange,
      owner,
      accountId: review.account.accountId,
      intent,
      price: payload.p,
      size: payload.s,
      fee: review.feePpm,
      reserve: review.fundingAllowance,
      debit: review.estimatedDebit,
      market: metadata,
    },
    (_, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
  );
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(binding)),
    ),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
  return {
    binding: digest,
    bracket: {
      target: wire(intent.target, metadata.tick),
      stop: wire(intent.stop, metadata.tick),
    },
    payload,
    head,
    protocolId: integer(review.account.lastRequestId),
    expiresAt: Math.min(input.reviewExpiresAt, input.sessionExpiresAt),
  };
}

/** No live sender is installed by this application. Acknowledgments never settle exposure. */
export function createOrderApplication(
  ownerAddress: string,
  options: {
    storage?: AccountStorage;
    lock?: AccountLock;
    now?: () => number;
    sender?: (body: string) => Promise<unknown>;
  } = {},
) {
  const owner = getAddress(ownerAddress);
  const storage = () => options.storage ?? window.localStorage;
  const now = options.now ?? Date.now;
  const locked = <T>(work: () => Promise<T>) =>
    (options.lock ?? accountLock)(accountLockName(owner), work);
  const read = () => readOrderJournal(storage(), owner);
  // The journal is a working record, not history: Perpl's signed history is the record of
  // finished trades. Drop finished trades so a long-lived wallet never reaches the caps
  // (64 entries, 128 management records) that would make its close unreachable.
  function prune(journal: Journal) {
    const finished = journal.operations.filter(
      (op) =>
        op.completion ||
        ["rejected", "discarded", "no-fill"].includes(op.phase),
    );
    const drop = new Set(finished.slice(0, -4)); // keep the latest few for the UI
    if (!drop.size) return;
    const positions = new Set(
      [...drop].flatMap((op) => (op.positionId ? [op.positionId] : [])),
    );
    journal.operations = journal.operations.filter((op) => !drop.has(op));
    if (journal.management)
      journal.management = journal.management.filter(
        (op) => !(op.positionId && positions.has(op.positionId)),
      );
  }
  function save(journal: Journal) {
    prune(journal);
    const raw = JSON.stringify(journal);
    readOrderJournal({ getItem: () => raw, setItem: () => {} }, owner);
    storage().setItem(orderJournalKey(owner), raw);
    if (storage().getItem(orderJournalKey(owner)) !== raw)
      throw Error("Order journal could not be saved. Do not resend.");
    return read()!;
  }
  function fundingClear() {
    if (
      unresolved(createFundingApplication(owner, { storage: storage() }).read())
    )
      throw Error("Resolve the pending wallet transaction first.");
  }
  async function prepare(input: OrderAdmission) {
    // Clone before any await: edits to a caller-owned review cannot alter the reviewed operation.
    const frozen = structuredClone(input);
    return locked(async () => {
      fundingClear();
      const previous = read();
      const a = await admission(owner, frozen, now());
      if (
        previous &&
        refreshRecordedProtection(previous, frozen.review.account)
      )
        save(previous);
      assertEntryAvailable(previous, frozen.review.account, a.payload.mkt);
      if (
        previous &&
        (previous.accountId !== a.payload.acc ||
          a.protocolId < previous.lastProtocolId)
      )
        throw Error(
          "Account or protocol request counter changed. Reconcile first.",
        );
      const rq = integer(
        Math.max(a.protocolId, previous?.highWater ?? 0) + 1,
        1,
      );
      const op: OrderOperation = {
        id: crypto.randomUUID(),
        binding: a.binding,
        sessionId: frozen.sessionId,
        expiresAt: a.expiresAt,
        protocolId: a.protocolId,
        payload: validateEntryPayload({ ...a.payload, rq }),
        bracket: a.bracket,
        goal: frozen.review.sizing.intent.goal.toString(),
        phase: "prepared",
        filled: 0,
        protection: "not-applicable",
        history: "unresolved",
        settlement: null,
      };
      if (now() >= op.expiresAt)
        throw Error("Order review expired. Review again.");
      save({
        version: 1,
        owner,
        chainId: 10143,
        exchange: testnet.exchange,
        accountId: op.payload.acc,
        highWater: rq,
        lastProtocolId: a.protocolId,
        operations: [...(previous?.operations ?? []), op],
        ...(previous?.management ? { management: previous.management } : {}),
      });
      return structuredClone(op);
    });
  }
  async function dispatch(id: string, current: () => Promise<OrderAdmission>) {
    return locked(async () => {
      if (!options.sender)
        throw Error(
          "Live order submission is unavailable: execution and protection gates remain unverified.",
        );
      fundingClear();
      const journal = read();
      const op = journal?.operations.find((v) => v.id === id);
      if (!journal || !op || op.phase !== "prepared")
        throw Error("This order cannot be sent again. Reconcile its outcome.");
      const input = structuredClone(await current());
      const a = await admission(owner, input, now());
      if (refreshRecordedProtection(journal, input.review.account))
        save(journal);
      assertEntryAvailable(
        {
          ...journal,
          operations: journal.operations.filter((o) => o.id !== op.id),
        },
        input.review.account,
        a.payload.mkt,
      );
      if (
        a.binding !== op.binding ||
        Object.entries(a.payload).some(
          ([field, value]) =>
            field !== "lb" &&
            op.payload[field as keyof typeof op.payload] !== value,
        ) ||
        input.sessionId !== op.sessionId ||
        a.protocolId !== op.protocolId ||
        a.head >= op.payload.lb ||
        op.payload.lb > a.head + input.ttlBlocks ||
        now() >= op.expiresAt
      )
        throw Error(
          "Order identity, economics, counter or expiry changed. Review again.",
        );
      op.phase = "submitting";
      save(journal); // Durable ambiguity barrier: after this point a crash is never treated as unsent.
      try {
        const response = await options.sender(
          JSON.stringify({ d: [op.payload] }),
        );
        op.phase = batchOutcomes(response, 1)[0];
      } catch (cause) {
        op.phase = cause instanceof OrderNotSent ? "rejected" : "unknown";
      }
      save(journal);
      return structuredClone(op);
    });
  }
  async function discard(id: string) {
    return locked(async () => {
      const journal = read();
      const op = journal?.operations.find((v) => v.id === id);
      if (!journal || !op || op.phase !== "prepared")
        throw Error("Only a never-submitted prepared order can be discarded.");
      op.phase = "discarded";
      save(journal);
    });
  }
  async function reconcileUnlocked(
    id: string,
    readers: {
      state(): Promise<TradingState>;
      history(): Promise<OrderHistory>;
      settlement?: (
        payload:
          | import("./order-journal").EntryPayload
          | import("./order-journal").ManagementPayload,
        hash: `0x${string}`,
      ) => Promise<SettlementProof | null>;
    },
  ) {
    const journal = read();
    const op = journal?.operations.find((v) => v.id === id);
    if (!journal || !op) throw Error("Recorded order not found.");
    if (["prepared", "discarded", "rejected"].includes(op.phase))
      return structuredClone(op);
    const history = await readers.history();
    const state = await readers.state();
    if (
      getAddress(state.owner) !== owner ||
      state.accountId !== journal.accountId ||
      !tradingStateFresh(state, now()) ||
      !state.reconciled ||
      state.lastRequestId < journal.lastProtocolId
    )
      throw Error(
        "Recovery account or protocol counter is stale or inconsistent.",
      );
    journal.lastProtocolId = state.lastRequestId;
    journal.highWater = Math.max(journal.highWater, state.lastRequestId);
    if (
      op.filled === 0 &&
      (await rejectedRequest(op.payload, history, state, readers.settlement))
    ) {
      op.phase = "rejected";
      save(journal);
      return structuredClone(op);
    }
    const orders = history.orders.filter(
      (r) =>
        r.account === op.payload.acc &&
        r.market === op.payload.mkt &&
        r.request === op.payload.rq &&
        r.type === op.payload.t &&
        r.size === op.payload.s &&
        r.price === op.payload.p &&
        [4, 5, 6].includes(r.status),
    );
    const ids = new Set(orders.map((r) => r.order));
    const latest = [...orders].sort(
      (a, b) => b.block - a.block || (b.log ?? 0) - (a.log ?? 0),
    )[0];
    // Cursor exhaustion is only indexer coverage. Absence and expiry never settle an operation.
    if (
      history.complete &&
      ids.size === 1 &&
      latest?.hash &&
      latest.block &&
      state.sources.every((source) => source.block >= latest.block) &&
      state.lastRequestId >= op.payload.rq
    ) {
      const proof = await (readers.settlement ?? readEntrySettlement)(
        op.payload,
        latest.hash,
      );
      const fills = history.fills.filter(
        (r) =>
          r.account === op.payload.acc &&
          r.market === op.payload.mkt &&
          r.order === latest.order,
      );
      const fillSize = fills.reduce((sum, r) => sum + BigInt(r.filled), 0n);
      const fillFees = fills.reduce((sum, r) => sum + BigInt(r.fee), 0n);
      if (
        proof &&
        !proof.rejected &&
        proof.hash.toLowerCase() === latest.hash.toLowerCase() &&
        proof.block === latest.block &&
        proof.filled === latest.filled &&
        fillSize === BigInt(proof.filled) &&
        fillFees === BigInt(proof.fee) &&
        BigInt(latest.fee) === BigInt(proof.fee)
      ) {
        // Fills settle this attempt, not the position's protection or final account ledger.
        op.filled = proof.filled;
        op.phase =
          proof.filled === 0
            ? "no-fill"
            : proof.filled === op.payload.s
              ? "filled"
              : "partial-fill";
        op.protection = proof.filled ? "pending" : "not-applicable";
        op.history = "settled";
        op.settlement = {
          hash: proof.hash,
          block: proof.block,
          orderId: latest.order,
        };
      }
    }
    if (op.filled && op.settlement) {
      const opened = history.positions?.filter(
        (r) =>
          r.account === op.payload.acc &&
          r.market === op.payload.mkt &&
          r.request === op.payload.rq &&
          r.order === op.settlement!.orderId &&
          r.hash?.toLowerCase() === op.settlement!.hash.toLowerCase() &&
          r.block === op.settlement!.block &&
          r.reason === 21 &&
          r.side === op.payload.t &&
          r.size === op.filled,
      );
      if (
        history.complete &&
        opened?.length === 1 &&
        opened[0].positionId &&
        (!op.positionId || op.positionId === opened[0].positionId)
      )
        op.positionId = opened[0].positionId;
    }
    if (op.filled && !op.completion) {
      const completion = reconcileLifecycleCompletion(
        journal,
        op,
        state,
        history,
      );
      if (completion) op.completion = completion;
    }
    if (op.phase === "submitting") op.phase = "unknown";
    save(journal);
    return structuredClone(op);
  }
  const reconcile = (
    id: string,
    readers: Parameters<typeof reconcileUnlocked>[1],
  ) => locked(() => reconcileUnlocked(id, readers));

  return {
    management: lifecycleCommands(owner, {
      read,
      save,
      locked,
      fundingClear,
      reconcileEntry: reconcileUnlocked,
      now,
      sender: options.sender,
    }),
    read,
    prepare,
    dispatch,
    discard,
    reconcile,
    readiness: () => (options.sender ? "live" : "no-sender"),
  };
}
