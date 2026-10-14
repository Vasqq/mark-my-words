import { getAddress } from "viem";
import type { AccountStorage } from "./account-coordination";
import { testnet } from "./testnet-config";

export interface EntryPayload {
  rq: number;
  acc: number;
  mkt: 16 | 32;
  t: 1 | 2;
  p: number;
  s: number;
  lv: number;
  fl: 4;
  mnp: 50;
  lb: number;
}
export interface ManagementPayload {
  rq: number;
  acc: number;
  mkt: 16 | 32;
  t: 3 | 4 | 5 | 6 | 7;
  s: number;
  lv: 0;
  fl: 0 | 4;
  lb: number;
  p?: number;
  mnp?: 0;
  oid?: number;
  tp?: number;
  tpc?: 3 | 4;
  lp?: number;
  a?: string; // Collateral increase only: micro-AUSD as a canonical decimal string.
}
export interface ManagementOperation {
  id: string;
  binding: string;
  sessionId: string;
  expiresAt: number;
  protocolId: number;
  kind:
    | "close"
    | "partial-close"
    | "take-profit"
    | "stop-loss"
    | "amend-take-profit"
    | "amend-stop-loss"
    | "cancel"
    | "add-collateral";
  positionId?: number;
  collateralBefore?: string; // Micro-AUSD on the position when an add-collateral was reviewed.
  observedOrderId?: number;
  retiredBy?: number; // Positively observed same-family amendment or terminal cancellation request.
  side?: "Long" | "Short"; // Omitted legacy management records retain Long semantics.
  payload: ManagementPayload;
  phase:
    | "prepared"
    | "submitting"
    | "unknown"
    | "forwarded"
    | "rejected"
    | "discarded"
    | "observed"
    | "cancelled"
    | "settled"
    | "superseded"; // Its position ended before a collateral increase or linked trigger was read back.
  filled: number;
  settlement: { hash: string; block: number; orderId: number } | null;
}
export const managementUnresolved = (op: ManagementOperation) =>
  ![
    "rejected",
    "discarded",
    "observed",
    "cancelled",
    "settled",
    "superseded",
  ].includes(op.phase);

export const matchingRecordedProtection = (
  op: ManagementOperation,
  state: import("./perpl-trading-state").TradingState,
  commands: ManagementOperation[] = [],
) => {
  const p = op.payload;
  const residual = state.positions.find(
    (position) =>
      position.id === p.lp &&
      position.market.marketId === p.mkt &&
      position.side === (op.side ?? "Long"),
  );
  const reductions = commands.filter(
    (c) =>
      c.positionId === p.lp &&
      c.payload.mkt === p.mkt &&
      c.payload.rq > p.rq &&
      c.phase === "settled" &&
      c.filled > 0 &&
      c.settlement &&
      ["partial-close", "close"].includes(c.kind),
  );
  const resize =
    residual &&
    residual.size < BigInt(p.s) &&
    op.observedOrderId !== undefined &&
    reductions.length > 0 &&
    reductions.reduce((sum, c) => sum + BigInt(c.filled), 0n) ===
      BigInt(p.s) - residual.size;
  return state.orders.filter(
    (o) =>
      o.market.marketId === p.mkt &&
      (o.request === p.rq ||
        (resize && reductions.some((c) => c.payload.rq === o.request))) &&
      (p.oid === undefined || o.id === p.oid) &&
      (op.observedOrderId === undefined || o.id === op.observedOrderId) &&
      o.type === (op.side === "Short" ? 4 : 3) &&
      o.linkedPosition === p.lp &&
      residual !== undefined &&
      o.size === residual.size &&
      (o.size === BigInt(p.s) || resize) &&
      o.filled === 0n &&
      o.price === BigInt(p.p!) &&
      o.triggerPrice === BigInt(p.tp!) &&
      o.triggerCondition === p.tpc &&
      o.flags === 4 &&
      o.status === 8,
  );
};

export function refreshRecordedProtection(
  journal: Journal,
  state: import("./perpl-trading-state").TradingState,
) {
  let changed = false;
  for (const op of journal.management ?? []) {
    if (
      op.phase !== "observed" ||
      op.payload.tp === undefined ||
      op.payload.t === 5 ||
      op.retiredBy !== undefined ||
      // A finished position's exits are gone by design, not uncertain.
      journal.operations.some(
        (entry) =>
          entry.completion?.positionId === op.positionId &&
          entry.payload.mkt === op.payload.mkt,
      ) ||
      // Gone with its position, as current reads show; history will mark it cancelled.
      closeConsumed(op, state)
    )
      continue;
    const matching = matchingRecordedProtection(op, state, journal.management);
    if (matching.length !== 1 || state.lastRequestId < op.payload.rq) {
      op.phase = "unknown";
      changed = true;
    } else if (op.observedOrderId === undefined) {
      op.observedOrderId = matching[0].id;
      changed = true;
    }
  }
  return changed;
}

export function protectiveChildBound(
  closeType: number,
  price: bigint,
  trigger: bigint,
) {
  return closeType === 3
    ? price <= trigger && price * 10000n >= trigger * 9950n
    : closeType === 4 && price >= trigger && price * 10000n <= trigger * 10050n;
}

export function validateManagementPayload(value: unknown): ManagementPayload {
  const p = object(value);
  const base = ["rq", "acc", "mkt", "t", "s", "lv", "fl", "lb"];
  for (const field of ["rq", "acc"]) integer(p[field], 1);
  if (![16, 32].includes(integer(p.mkt)) || p.lv !== 0)
    throw Error("Unsupported management market or leverage.");
  if (p.t === 5) {
    keys(p, [...base, "oid", "tp", "tpc", "lp"]);
    integer(p.oid, 1);
    integer(p.tp, 1);
    integer(p.lp, 1);
    if (
      p.s !== 0 ||
      p.fl !== 4 ||
      p.lb !== 0 ||
      ![3, 4].includes(integer(p.tpc))
    )
      throw Error("Invalid linked-trigger cancellation.");
  } else if (p.t === 6) {
    keys(p, [...base, "a", "lp"]);
    integer(p.lp, 1);
    if (
      p.s !== 0 ||
      p.fl !== 4 ||
      p.lb !== 0 ||
      typeof p.a !== "string" ||
      !/^[1-9]\d{0,14}$/.test(p.a)
    )
      throw Error("Invalid collateral increase.");
  } else if (p.t === 3 || p.t === 4 || p.t === 7) {
    const trigger = p.tp !== undefined;
    keys(p, [
      ...base,
      "p",
      ...(p.t === 7 ? ["oid"] : ["mnp"]),
      ...(trigger ? ["tp", "tpc", "lp"] : []),
    ]);
    if (p.t === 7) {
      integer(p.oid, 1);
      if (!trigger) throw Error("Change requires a linked trigger.");
    }
    integer(p.p, 1);
    integer(p.s, 1);
    if (p.fl !== 4 || (p.t !== 7 && p.mnp !== 0))
      throw Error("Close must be an explicit reduce-only IOC.");
    if (trigger) {
      integer(p.tp, 1);
      integer(p.lp, 1);
      if (
        p.lb !== 0 ||
        ![3, 4].includes(integer(p.tpc)) ||
        !(p.t === 7
          ? protectiveChildBound(
              3,
              BigInt(Number(p.p)),
              BigInt(Number(p.tp)),
            ) ||
            protectiveChildBound(4, BigInt(Number(p.p)), BigInt(Number(p.tp)))
          : protectiveChildBound(
              Number(p.t),
              BigInt(Number(p.p)),
              BigInt(Number(p.tp)),
            ))
      )
        throw Error("Invalid protective child bound.");
    } else integer(p.lb, 1);
  } else throw Error("Unsupported management order type.");
  return p as unknown as ManagementPayload;
}

export type OrderPhase =
  | "prepared"
  | "submitting"
  | "unknown"
  | "forwarded"
  | "rejected"
  | "discarded"
  | "no-fill"
  | "partial-fill"
  | "filled";
export interface LifecycleCompletion {
  positionId: number;
  hash: string;
  block: number;
  orderId: number;
  balance: string;
  locked: string;
  pnl: string;
  funding: string;
  fees: string;
}
export interface OrderOperation {
  id: string;
  binding: string;
  sessionId: string;
  expiresAt: number;
  protocolId: number;
  payload: EntryPayload;
  bracket?: { target: number; stop: number };
  goal?: string; // The sentence's profit goal in micro AUSD, kept for display only.
  positionId?: number; // Assigned only by correlated canonical opening history, never snapshot guessing.
  completion?: LifecycleCompletion;
  phase: OrderPhase;
  filled: number;
  protection: "not-applicable" | "pending";
  history: "unresolved" | "settled";
  settlement: { hash: string; block: number; orderId: number } | null;
}
export interface Journal {
  experiment?: { policy: string; baseline: number; ceiling: number };
  version: 1;
  owner: string;
  chainId: 10143;
  exchange: string;
  accountId: number;
  highWater: number;
  lastProtocolId: number;
  operations: OrderOperation[];
  management?: ManagementOperation[];
}
export const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid order data.");
  return value as Record<string, unknown>;
};
export const integer = (value: unknown, min = 0): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    throw Error("Invalid order integer.");
  return value;
};
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).sort().join() !== expected.sort().join())
    throw Error("Unexpected order fields.");
}
export const uuid = (v: unknown): v is string =>
  typeof v === "string" && /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(v);
export const orderJournalKey = (owner: string) =>
  `perpl-orders-v1:10143:${getAddress(owner).toLowerCase()}`;
export const operationUnresolved = (operation: OrderOperation) =>
  !operation.completion &&
  !["rejected", "discarded", "no-fill"].includes(operation.phase);

export function validateEntryPayload(value: unknown): EntryPayload {
  const p = object(value);
  keys(p, ["rq", "acc", "mkt", "t", "p", "s", "lv", "fl", "mnp", "lb"]);
  for (const field of ["rq", "acc", "p", "s", "lb"]) integer(p[field], 1);
  if (
    ![16, 32].includes(integer(p.mkt)) ||
    ![1, 2].includes(integer(p.t)) ||
    p.fl !== 4 ||
    p.mnp !== 50 ||
    // Perpl's base maximum: BTC (16) 15x, ETH (32) 12x.
    integer(p.lv, 100) > (p.mkt === 16 ? 1500 : 1200)
  )
    throw Error("Unsupported entry payload.");
  return p as unknown as EntryPayload;
}

export function readOrderJournal(
  storage: AccountStorage,
  owner: string,
): Journal | null {
  const raw = storage.getItem(orderJournalKey(owner));
  if (raw === null) return null;
  if (raw.length > 262144)
    throw Error("Order journal is too large. Preserve it for recovery.");
  const j = object(JSON.parse(raw));
  keys(j, [
    "version",
    "owner",
    "chainId",
    "exchange",
    "accountId",
    "highWater",
    "lastProtocolId",
    "operations",
    ...(j.management === undefined ? [] : ["management"]),
    ...(j.experiment === undefined ? [] : ["experiment"]),
  ]);
  if (
    j.version !== 1 ||
    j.owner !== getAddress(owner) ||
    j.chainId !== 10143 ||
    j.exchange !== testnet.exchange ||
    !Array.isArray(j.operations) ||
    j.operations.length > 64
  )
    throw Error("Order journal identity is invalid. Preserve it for recovery.");
  const accountId = integer(j.accountId, 1);
  const highWater = integer(j.highWater);
  integer(j.lastProtocolId);
  if (j.experiment !== undefined) {
    const e = object(j.experiment);
    keys(e, ["policy", "baseline", "ceiling"]);
    if (
      typeof e.policy !== "string" ||
      !/^[\da-f]{64}$/.test(e.policy) ||
      integer(e.ceiling, 1) <= integer(e.baseline)
    )
      throw Error("Invalid immutable experiment packet.");
  }
  const ids = new Set<string>();
  let last = 0;
  for (const value of j.operations) {
    const op = object(value);
    keys(op, [
      "id",
      "binding",
      "sessionId",
      "expiresAt",
      "protocolId",
      "payload",
      "phase",
      "filled",
      "protection",
      "history",
      "settlement",
      ...(op.bracket === undefined ? [] : ["bracket"]),
      ...(op.goal === undefined ? [] : ["goal"]),
      ...(op.positionId === undefined ? [] : ["positionId"]),
      ...(op.completion === undefined ? [] : ["completion"]),
    ]);
    if (
      op.goal !== undefined &&
      (typeof op.goal !== "string" || !/^[1-9]\d{0,29}$/.test(op.goal))
    )
      throw Error("Invalid saved goal.");
    if (
      !uuid(op.id) ||
      ids.has(op.id) ||
      !uuid(op.sessionId) ||
      typeof op.binding !== "string" ||
      !/^[\da-f]{64}$/.test(op.binding)
    )
      throw Error("Invalid saved order identity.");
    if (op.settlement !== null) {
      const proof = object(op.settlement);
      keys(proof, ["hash", "block", "orderId"]);
      if (
        typeof proof.hash !== "string" ||
        !/^0x[\da-f]{64}$/i.test(proof.hash)
      )
        throw Error("Invalid settlement reference.");
      integer(proof.block, 1);
      integer(proof.orderId, 1);
    }
    if ((op.settlement !== null) !== (op.history === "settled"))
      throw Error("Missing settlement reference.");
    if (op.completion !== undefined) {
      const c = object(op.completion);
      if (op.positionId !== undefined && c.positionId !== op.positionId)
        throw Error("Completed position identity changed.");
      keys(c, [
        "positionId",
        "hash",
        "block",
        "orderId",
        "balance",
        "locked",
        "pnl",
        "funding",
        "fees",
      ]);
      for (const field of ["positionId", "block"]) integer(c[field], 1);
      integer(c.orderId); // 0 when the exchange, not an order, ended the position.
      if (
        typeof c.hash !== "string" ||
        !/^0x[\da-f]{64}$/i.test(c.hash) ||
        !["filled", "partial-fill"].includes(String(op.phase))
      )
        throw Error("Invalid lifecycle completion.");
      for (const field of ["balance", "locked", "pnl", "funding", "fees"])
        if (
          typeof c[field] !== "string" ||
          !/^-?\d{1,78}$/.test(String(c[field]))
        )
          throw Error("Invalid completed accounting.");
      if (BigInt(String(c.balance)) < 0n || BigInt(String(c.locked)) < 0n)
        throw Error("Invalid completed balances.");
    }
    if (op.positionId !== undefined) {
      integer(op.positionId, 1);
      if (
        !["filled", "partial-fill"].includes(String(op.phase)) ||
        op.history !== "settled"
      )
        throw Error("Unproved active position identity.");
    }
    ids.add(op.id);
    integer(op.expiresAt, 1);
    integer(op.protocolId);
    const p = validateEntryPayload(op.payload);
    if (op.bracket !== undefined) {
      const bracket = object(op.bracket);
      keys(bracket, ["target", "stop"]);
      if (
        p.t === 1
          ? integer(bracket.target, 1) <= p.p || integer(bracket.stop, 1) >= p.p
          : integer(bracket.target, 1) >= p.p || integer(bracket.stop, 1) <= p.p
      )
        throw Error("Invalid reviewed bracket.");
    }
    if (
      p.acc !== accountId ||
      p.rq <= last ||
      p.rq > highWater ||
      p.rq <= Number(op.protocolId)
    )
      throw Error("Invalid saved request counter.");
    last = p.rq;
    if (
      ![
        "prepared",
        "submitting",
        "unknown",
        "forwarded",
        "rejected",
        "discarded",
        "no-fill",
        "partial-fill",
        "filled",
      ].includes(String(op.phase)) ||
      integer(op.filled) > p.s ||
      !["pending", "not-applicable"].includes(String(op.protection)) ||
      !["unresolved", "settled"].includes(String(op.history))
    )
      throw Error("Invalid saved order outcome.");
    if (
      integer(op.filled) > 0 !== (op.protection === "pending") ||
      ([
        "prepared",
        "submitting",
        "unknown",
        "forwarded",
        "rejected",
        "discarded",
        "no-fill",
      ].includes(String(op.phase)) &&
        op.filled !== 0) ||
      (op.phase === "filled" && op.filled !== p.s) ||
      (op.phase === "partial-fill" && (op.filled === 0 || op.filled === p.s)) ||
      ["no-fill", "partial-fill", "filled"].includes(String(op.phase)) !==
        (op.history === "settled")
    )
      throw Error("Inconsistent saved order outcome.");
  }
  if (j.management !== undefined) {
    if (!Array.isArray(j.management) || j.management.length > 128)
      throw Error("Invalid management journal.");
    const requests = new Set(
      j.operations.map((v) => validateEntryPayload(object(v).payload).rq),
    );
    let previous = 0;
    for (const value of j.management) {
      const op = object(value);
      keys(op, [
        "id",
        "binding",
        "sessionId",
        "expiresAt",
        "protocolId",
        "kind",
        ...(op.positionId === undefined ? [] : ["positionId"]),
        ...(op.collateralBefore === undefined ? [] : ["collateralBefore"]),
        ...(op.observedOrderId === undefined ? [] : ["observedOrderId"]),
        ...(op.retiredBy === undefined ? [] : ["retiredBy"]),
        ...(op.side === undefined ? [] : ["side"]),
        "payload",
        "phase",
        "filled",
        "settlement",
      ]);
      if (
        !uuid(op.id) ||
        ids.has(op.id) ||
        !uuid(op.sessionId) ||
        typeof op.binding !== "string" ||
        !/^[\da-f]{64}$/.test(op.binding)
      )
        throw Error("Invalid management identity.");
      ids.add(op.id);
      integer(op.expiresAt, 1);
      integer(op.protocolId);
      const p = validateManagementPayload(op.payload);
      if (op.observedOrderId !== undefined) integer(op.observedOrderId, 1);
      if (op.retiredBy !== undefined && integer(op.retiredBy, 1) <= p.rq)
        throw Error("Invalid protection retirement counter.");
      if (op.side !== undefined && op.side !== "Long" && op.side !== "Short")
        throw Error("Invalid management side.");
      const side = op.side === "Short" ? "Short" : "Long";
      if (
        (p.t === 3 && side !== "Long") ||
        (p.t === 4 && side !== "Short") ||
        (p.tp !== undefined &&
          p.p !== undefined &&
          !protectiveChildBound(
            side === "Long" ? 3 : 4,
            BigInt(p.p),
            BigInt(p.tp),
          ))
      )
        throw Error("Management direction or child bound changed.");
      if (op.kind !== "cancel") integer(op.positionId, 1);
      if (p.lp !== undefined && p.lp !== op.positionId)
        throw Error("Management position identity changed.");
      if (
        p.acc !== accountId ||
        requests.has(p.rq) ||
        p.rq <= previous ||
        p.rq > highWater ||
        p.rq <= Number(op.protocolId)
      )
        throw Error("Invalid management counter.");
      requests.add(p.rq);
      previous = p.rq;
      if (
        ![
          "prepared",
          "submitting",
          "unknown",
          "forwarded",
          "rejected",
          "discarded",
          "observed",
          "cancelled",
          "settled",
          "superseded",
        ].includes(String(op.phase)) ||
        ![
          "close",
          "partial-close",
          "take-profit",
          "stop-loss",
          "amend-take-profit",
          "amend-stop-loss",
          "cancel",
          "add-collateral",
        ].includes(String(op.kind)) ||
        integer(op.filled) > p.s
      )
        throw Error("Invalid management outcome.");
      if (
        (op.kind === "add-collateral") !== (p.t === 6) ||
        (op.kind === "add-collateral") !==
          (typeof op.collateralBefore === "string" &&
            /^\d{1,30}$/.test(op.collateralBefore)) ||
        (op.phase === "superseded" &&
          ["close", "partial-close"].includes(String(op.kind)))
      )
        throw Error("Invalid collateral increase record.");
      if (
        (op.kind === "cancel") !== (p.t === 5) ||
        ["amend-take-profit", "amend-stop-loss"].includes(String(op.kind)) !==
          (p.t === 7) ||
        (p.t !== 5 &&
          (["take-profit", "amend-take-profit"].includes(String(op.kind)) !==
            (p.tpc === (side === "Long" ? 3 : 4)) ||
            ["stop-loss", "amend-stop-loss"].includes(String(op.kind)) !==
              (p.tpc === (side === "Long" ? 4 : 3))))
      )
        throw Error("Invalid management purpose.");
      if (op.phase === "cancelled" && (p.tp === undefined || p.t === 5))
        throw Error("Only positively terminated protection can be cancelled.");
      if (op.phase === "settled") {
        const proof = object(op.settlement);
        keys(proof, ["hash", "block", "orderId"]);
        if (
          typeof proof.hash !== "string" ||
          !/^0x[\da-f]{64}$/i.test(proof.hash) ||
          !["close", "partial-close"].includes(String(op.kind))
        )
          throw Error("Invalid close settlement.");
        integer(proof.block, 1);
        integer(proof.orderId, 1);
      } else if (op.settlement !== null || op.filled !== 0)
        throw Error("Unproved management fill.");
      if (
        op.phase === "observed" &&
        ["close", "partial-close"].includes(String(op.kind))
      )
        throw Error("A snapshot cannot settle a close.");
    }
  }
  for (const op of (j.management ?? []) as ManagementOperation[]) {
    if (op.retiredBy === undefined) continue;
    const replacement = (j.management as ManagementOperation[]).find(
      (r) => r.payload.rq === op.retiredBy,
    );
    if (
      !op.observedOrderId ||
      !replacement ||
      !["cancel", "amend-take-profit", "amend-stop-loss"].includes(
        replacement.kind,
      ) ||
      !["observed", "unknown", "cancelled"].includes(replacement.phase) ||
      replacement.payload.oid !== op.observedOrderId ||
      replacement.payload.mkt !== op.payload.mkt ||
      replacement.payload.lp !== op.payload.lp ||
      replacement.payload.tpc !== op.payload.tpc
    )
      throw Error("Protection retirement has no correlated observed command.");
  }
  for (const operation of j.operations as OrderOperation[]) {
    const completion = operation.completion;
    if (!completion) continue;
    if (
      !operation.settlement ||
      completion.block < operation.settlement.block ||
      BigInt(completion.fees) < 0n
    )
      throw Error("Lifecycle completion precedes its entry.");
  }
  if (Number(j.lastProtocolId) > highWater)
    throw Error("Invalid protocol counter.");
  return j as unknown as Journal;
}

export function assertNoUnresolvedOrders(
  storage: AccountStorage,
  owner: string,
) {
  const journal = readOrderJournal(storage, owner);
  if (
    journal?.operations.some(operationUnresolved) ||
    journal?.management?.some(managementUnresolved)
  )
    throw Error(
      "Resolve the recorded order and its exposure before changing collateral or entering again.",
    );
}

/*
 * Perpl processes an account's requests in id order and refuses any id at or below the
 * last one it processed. So once the signed read's lastRequestId reaches an
 * acknowledged request, that request can no longer arrive or act. When the same read,
 * checked against the finalized chain, also shows its position gone, nothing of it is
 * left; only its accounting waits for history, which trails by 15 to 45 s. Neither
 * applies to "unknown" (no acknowledgment) or to a resting trigger, which can still act.
 */
// Absence counts only from position and order reads at or past the wallet read that
// showed the request processed; a lagging replica may not show it yet.
const readsCurrent = (state: import("./perpl-trading-state").TradingState) => {
  const wallet = state.sources.find((s) => s.name === "Wallet")?.block;
  return (
    wallet !== undefined &&
    ["Positions", "Orders"].every((name) => {
      const block = state.sources.find((s) => s.name === name)?.block;
      return block !== undefined && block >= wallet;
    })
  );
};
export const closeConsumed = (
  op: ManagementOperation,
  state: import("./perpl-trading-state").TradingState,
) =>
  state.reconciled &&
  readsCurrent(state) &&
  state.lastRequestId >= op.payload.rq &&
  !state.positions.some(
    (p) => p.id === op.positionId && p.market.marketId === op.payload.mkt,
  ) &&
  ((op.kind === "close" && op.phase === "forwarded") ||
    // A position's linked stop or target goes with it: the reconcile's "superseded".
    (op.payload.tp !== undefined &&
      op.payload.t !== 5 &&
      !state.orders.some(
        (o) =>
          o.market.marketId === op.payload.mkt &&
          (o.id === op.observedOrderId ||
            o.id === op.payload.oid ||
            o.request === op.payload.rq),
      )));
export const entryConsumed = (
  op: OrderOperation,
  state: import("./perpl-trading-state").TradingState,
) =>
  ["forwarded", "filled", "partial-fill"].includes(op.phase) &&
  readsCurrent(state) &&
  state.reconciled &&
  state.lastRequestId >= op.payload.rq &&
  (!op.settlement ||
    state.sources.every((s) => s.block >= op.settlement!.block)) &&
  !state.positions.some(
    (p) =>
      p.market.marketId === op.payload.mkt &&
      (op.positionId === undefined || p.id === op.positionId),
  );

/** Entries serialize mutations account-wide, but proven active exposure blocks only its own market. */
export function assertEntryAvailable(
  journal: Journal | null,
  state: import("./perpl-trading-state").TradingState,
  marketId: number,
) {
  if (
    journal?.management?.some(
      (op) => managementUnresolved(op) && !closeConsumed(op, state),
    )
  )
    throw Error(
      "Resolve the recorded management mutation before another entry.",
    );
  for (const op of journal?.operations ?? []) {
    if (!operationUnresolved(op) || entryConsumed(op, state)) continue;
    const position = state.positions.find(
      (p) =>
        p.market.marketId === op.payload.mkt &&
        p.id === op.positionId &&
        p.side === (op.payload.t === 1 ? "Long" : "Short"),
    );
    if (
      op.payload.mkt === marketId ||
      !["filled", "partial-fill"].includes(op.phase) ||
      op.history !== "settled" ||
      !op.settlement ||
      state.lastRequestId < op.payload.rq ||
      state.sources.some((s) => s.block < op.settlement!.block) ||
      !position ||
      position.size > BigInt(op.filled)
    )
      throw Error(
        "Resolve the recorded order and its exposure before entering again.",
      );
  }
  if (
    state.orders.some(
      (o) => ![3, 4].includes(o.type) || !o.linkedPosition || o.status !== 8,
    )
  )
    throw Error(
      "Reconcile pending account orders before spending shared collateral.",
    );
}
