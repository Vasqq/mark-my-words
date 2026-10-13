import { ceil, U } from "./financial-model";
import { sizingAbi } from "./perpl-sizing";
import {
  testnet,
  testnetClient,
  type TestnetReadOptions,
} from "./testnet-config";
import { parseAbi } from "viem";
import { getAddress } from "viem";
import {
  integer,
  protectiveChildBound,
  managementUnresolved,
  type ManagementPayload,
} from "./order-journal";
import {
  tradingStateFresh,
  type TradingState,
  type TradingPosition,
} from "./perpl-trading-state";

export const lifecycleUnavailable = "Live trading is unavailable.";

export type ManagementAction = { marketId?: 16 | 32 } & (
  | { kind: "close"; positionId: number; price: number }
  | { kind: "partial-close"; positionId: number; price: number; size: number }
  | {
      kind: "amend-take-profit" | "amend-stop-loss";
      positionId: number;
      orderId: number;
      trigger: number;
      price: number;
    }
  | {
      kind: "take-profit" | "stop-loss";
      positionId: number;
      trigger: number;
      price: number;
    }
  | { kind: "cancel"; orderId: number }
  // amount is micro-AUSD moved from the free balance onto the position.
  | { kind: "add-collateral"; positionId: number; amount: number }
);
export interface ManagementAdmission {
  state: TradingState;
  action: ManagementAction;
  sessionId: string;
  sessionExpiresAt: number;
  reviewExpiresAt: number;
  ttlBlocks: number;
  risk?: PositionRisk;
  acknowledgeImmediate?: boolean;
}

/** Finalized Exchange observations. Prices are native ticks; premium P&L is micro-AUSD. */
export interface PositionRisk {
  accountId: number;
  positionId: number;
  marketId: number;
  block: bigint;
  blockTime: number;
  side?: "Long" | "Short"; // Legacy in-memory ETH-long reviews omit this; new readers always supply it.
  size: bigint;
  entryPrice: bigint;
  entryResidueQ16: number;
  collateral: bigint;
  premiumPnl: bigint;
  mark: bigint;
  maintenanceFactor: bigint;
  dynamicLeverage: bigint;
}
export const positionRiskAbi = parseAbi([
  "struct PositionInfoV2 { uint256 accountId; uint256 nextNodeId; uint256 prevNodeId; uint8 positionType; uint256 depositCNS; uint256 pricePNS; uint256 lotLNS; uint256 entryBlock; int256 pnlCNS; int256 deltaPnlCNS; int256 premiumPnlCNS; uint256 priceResiduePNSQ16; }",
  "function getPositionV2(uint256 perpId, uint256 accountId) view returns (PositionInfoV2 positionInfo, uint256 markPricePNS, bool markPriceValid)",
]);
export function protectiveAction(
  action: ManagementAction,
): action is Extract<ManagementAction, { trigger: number }> {
  return (
    action.kind !== "close" &&
    action.kind !== "partial-close" &&
    action.kind !== "cancel" &&
    action.kind !== "add-collateral"
  );
}

/** Mirrors SDK liquidation_price, rounding toward a stricter buffer for the actual long/short residual. */
export function assessProtection(input: ManagementAdmission, now: number) {
  if (!protectiveAction(input.action)) return undefined;
  const action = input.action;
  const position = input.state.positions.find(
    (p) =>
      p.id === action.positionId &&
      p.market.marketId === (action.marketId ?? 32),
  );
  const risk = input.risk;
  if (!position || !risk)
    throw Error(
      "Fresh actual-position mark, funding and margin risk are required for protection changes.",
    );
  const times = [...input.state.sources.map((s) => s.time), risk.blockTime];
  if (
    risk.block <= 0n ||
    now - risk.blockTime >= 30000 ||
    risk.blockTime > now + 2000 ||
    Math.max(...times) - Math.min(...times) > 25000
  )
    throw Error(
      "Protection risk is stale or incoherent. Refresh the position and risk together.",
    );
  if (
    risk.accountId !== input.state.accountId ||
    risk.positionId !== position.id ||
    risk.marketId !== position.market.marketId ||
    (risk.side ?? "Long") !== position.side ||
    risk.size !== position.size ||
    risk.entryPrice !== position.entryPrice ||
    risk.entryResidueQ16 !== position.entryResidueQ16 ||
    risk.collateral !== position.collateral ||
    risk.mark <= 0n ||
    risk.maintenanceFactor !==
      BigInt(position.market.maintenanceMarginFactor) ||
    risk.maintenanceFactor <= 0n ||
    risk.dynamicLeverage <= 0n ||
    risk.dynamicLeverage > BigInt(position.market.initialMarginFactor) ||
    !Number.isInteger(risk.entryResidueQ16) ||
    risk.entryResidueQ16 < 0 ||
    risk.entryResidueQ16 > 65535
  )
    throw Error(
      "Actual position and finalized risk changed or are incomplete. Review again.",
    );
  const { tick, lot } = position.market;
  const quantity = position.size * lot;
  const long = position.side === "Long";
  const direction = long ? 1n : -1n;
  // Native long entry rounds up, short entry rounds down; retain Q16 residue.
  const entryQ16 =
    (position.entryPrice - (long && position.entryResidueQ16 ? 1n : 0n)) *
      65536n +
    BigInt(position.entryResidueQ16);
  const notionalNumerator = entryQ16 * tick * quantity;
  const notional = long
    ? ceil(notionalNumerator, 65536n * U)
    : notionalNumerator / (65536n * U);
  const maintenance = ceil(notional * 100n, risk.maintenanceFactor);
  const equityBoundary =
    notional +
    direction * (maintenance - position.collateral - risk.premiumPnl);
  const liquidation =
    equityBoundary > 0n
      ? long
        ? ceil(equityBoundary * U, quantity)
        : (equityBoundary * U) / quantity
      : 0n;
  const mark = risk.mark * tick;
  const buffer = ceil(mark, 100n) > tick ? ceil(mark, 100n) : tick;
  const stopBoundary = liquidation + direction * buffer;
  const trigger = BigInt(integer(action.trigger, 1)) * tick;
  const stop = action.kind === "stop-loss" || action.kind === "amend-stop-loss";
  if (stop && direction * (trigger - stopBoundary) <= 0n)
    throw Error(
      "Stop must remain beyond actual-position liquidation by the required 1% mark-price buffer.",
    );
  return {
    liquidation,
    stopBoundary,
    mark,
    immediate: stop
      ? direction * (mark - trigger) <= 0n
      : direction * (mark - trigger) >= 0n,
  };
}

/** No simulated/funding-rate fallback: unavailable V2 risk blocks protection, never close recovery. */
export async function readPositionRisk(
  state: TradingState,
  positionId: number,
  options: TestnetReadOptions = {},
  marketId: 16 | 32 = 32,
): Promise<PositionRisk> {
  const position = state.positions.find(
    (p) => p.id === positionId && p.market.marketId === marketId,
  );
  if (!position)
    throw Error("Position changed. Refresh before reviewing protection.");
  const client = testnetClient(options);
  if ((await client.getChainId()) !== 10143)
    throw Error("Protection risk RPC is not Monad testnet.");
  const block = await client.getBlock({ blockTag: "finalized" });
  if (block.number === null || !block.hash)
    throw Error("Finalized protection risk unavailable.");
  const [[info, mark, valid], [base, maintenance, dynamic]] = await Promise.all(
    [
      client.readContract({
        address: testnet.exchange,
        abi: positionRiskAbi,
        functionName: "getPositionV2",
        args: [BigInt(marketId), BigInt(state.accountId)],
        blockNumber: block.number,
      }),
      client.readContract({
        address: testnet.exchange,
        abi: sizingAbi,
        functionName: "getMarginFractions",
        args: [BigInt(marketId), position.size],
        blockNumber: block.number,
      }),
    ],
  );
  if (
    !valid ||
    info.positionType !== (position.side === "Long" ? 0 : 1) ||
    info.accountId !== BigInt(state.accountId) ||
    base !== BigInt(position.market.initialMarginFactor)
  )
    throw Error("Finalized mark or position risk is unavailable or changed.");
  return {
    accountId: state.accountId,
    positionId,
    marketId,
    side: position.side,
    block: block.number,
    blockTime: Number(block.timestamp) * 1000,
    size: info.lotLNS,
    entryPrice: info.pricePNS,
    entryResidueQ16: Number(info.priceResiduePNSQ16),
    collateral: info.depositCNS,
    premiumPnl: info.premiumPnlCNS,
    mark,
    maintenanceFactor: maintenance,
    dynamicLeverage: dynamic,
  };
}

/** Finalized open positions for one account, readable without an API session. Native units. */
export interface ChainPosition {
  marketId: 16 | 32;
  side: "Long" | "Short";
  size: bigint; // lots
  entryPrice: bigint; // ticks
  entryResidueQ16: number;
  collateral: bigint; // micro AUSD
  premiumPnl: bigint; // micro AUSD funding owed by the position; negative when received
  blockTime: number;
}
export async function readChainPositions(
  accountId: bigint,
  options: TestnetReadOptions = {},
): Promise<ChainPosition[]> {
  const client = testnetClient(options);
  const block = await client.getBlock({ blockTag: "finalized" });
  if (block.number === null) throw Error("Finalized positions unavailable.");
  const markets = [16, 32] as const;
  const reads = await Promise.all(
    markets.map((marketId) =>
      client.readContract({
        address: testnet.exchange,
        abi: positionRiskAbi,
        functionName: "getPositionV2",
        args: [BigInt(marketId), accountId],
        blockNumber: block.number!,
      }),
    ),
  );
  return reads.flatMap(([info], index) =>
    info.lotLNS > 0n && info.accountId === accountId
      ? [
          {
            marketId: markets[index],
            side:
              info.positionType === 0 ? ("Long" as const) : ("Short" as const),
            size: info.lotLNS,
            entryPrice: info.pricePNS,
            entryResidueQ16: Number(info.priceResiduePNSQ16),
            collateral: info.depositCNS,
            premiumPnl: info.premiumPnlCNS,
            blockTime: Number(block.timestamp) * 1000,
          },
        ]
      : [],
  );
}

export function assertManagementState(
  owner: string,
  state: TradingState,
  now: number,
) {
  if (
    getAddress(state.owner) !== getAddress(owner) ||
    !tradingStateFresh(state, now) ||
    !state.reconciled
  )
    throw Error(
      "Refresh the selected wallet's reconciled position and order state.",
    );
  if (
    !state.sources.length ||
    !state.forwarding ||
    state.frozen ||
    state.restrictions.halted ||
    state.restrictions.addressBlocked ||
    (state.restrictions.whitelistEnabled && !state.restrictions.whitelisted)
  )
    throw Error(
      "Account execution is unavailable; preserve the recovery record.",
    );
}

/** Input prices and quantity are native integer ticks/lots. Never use requested entry size. */
export function managementPayload(
  owner: string,
  input: ManagementAdmission,
  now: number,
): Omit<ManagementPayload, "rq"> {
  const { state, action } = input;
  assertManagementState(owner, state, now);
  const head = integer(
    state.sources.find((s) => s.name === "Wallet")?.block,
    1,
  );
  const lb = integer(head + integer(input.ttlBlocks, 1), 1);
  const marketId = input.action.marketId ?? 32;
  if (![16, 32].includes(marketId))
    throw Error("Unsupported management market.");
  const common = { acc: state.accountId, mkt: marketId, lv: 0 as const };
  if (action.kind === "cancel") {
    const order = state.orders.find(
      (o) => o.id === action.orderId && o.market.marketId === marketId,
    );
    if (!order || ![3, 4].includes(order.type) || !order.linkedPosition)
      throw Error(
        "Only an observed ETH/BTC linked reduce-only exit can be cancelled here.",
      );
    // Native trigger cancellation preserves the observed trigger identity and flags.
    // The minimal generic cancellation was ACKed but failed sr:33 on testnet.
    if (
      order.flags !== 4 ||
      order.leverage !== 0 ||
      ![3, 4].includes(order.triggerCondition ?? 0)
    )
      throw Error(
        "The linked exit's cancellation fields are incomplete or unsupported.",
      );
    return {
      ...common,
      t: 5,
      oid: integer(order.id, 1),
      s: 0,
      fl: order.flags,
      lv: order.leverage,
      lb: 0,
      tp: integer(Number(order.triggerPrice), 1),
      tpc: order.triggerCondition as 3 | 4,
      lp: integer(order.linkedPosition, 1),
    };
  }
  if (action.kind === "add-collateral") {
    const open = state.positions.find(
      (p) => p.id === action.positionId && p.market.marketId === marketId,
    );
    if (!open || open.size <= 0n)
      throw Error(
        "The reviewed position is no longer open. Refresh before acting.",
      );
    const amount = integer(action.amount, 1);
    if (BigInt(amount) > state.free)
      throw Error("That is more than the free balance. Review again.");
    // IncreasePositionCollateral: the same body for a long and a short. See the relay
    // validator for which of these fields Perpl's docs leave unverified.
    return {
      ...common,
      t: 6,
      s: 0,
      fl: 4,
      lb: 0,
      a: String(amount),
      lp: integer(open.id, 1),
    };
  }
  const position = state.positions.find(
    (p) =>
      p.id === action.positionId &&
      p.market.marketId === (action.marketId ?? 32),
  );
  if (!position)
    throw Error(
      "The reviewed position is no longer open. Refresh before acting.",
    );
  const closeType = position.side === "Long" ? (3 as const) : (4 as const);
  const remaining = integer(Number(position.size), 1);
  const s =
    action.kind === "partial-close" ? integer(action.size, 1) : remaining;
  if (action.kind === "partial-close" && s >= remaining)
    throw Error(
      "Partial close must leave at least one native lot. Use full close for the entire remainder.",
    );
  const p = integer(action.price, 1);
  if (action.kind === "close" || action.kind === "partial-close")
    return { ...common, t: closeType, p, s, fl: 4, mnp: 0, lb };
  assessProtection(input, now);
  const tp = integer(action.trigger, 1);
  const tpc =
    action.kind === "take-profit" || action.kind === "amend-take-profit"
      ? position.side === "Long"
        ? 3
        : 4
      : position.side === "Long"
        ? 4
        : 3;
  const amend =
    action.kind === "amend-take-profit" || action.kind === "amend-stop-loss";
  // A closing sell floor / buy ceiling within 50 bps of trigger; reject default pricing.
  // This is the candidate wire bound, not proof the deployed trigger worker preserves it.
  if (!protectiveChildBound(closeType, BigInt(p), BigInt(tp)))
    throw Error(
      "Protective child price must be within 0.5% on its closing side of the trigger.",
    );
  if (amend) {
    const existing = state.orders.filter(
      (o) =>
        o.market.marketId === marketId &&
        o.linkedPosition === position.id &&
        o.triggerCondition === tpc,
    );
    const order = existing[0];
    if (
      existing.length !== 1 ||
      order.id !== action.orderId ||
      order.type !== closeType ||
      order.status !== 8 ||
      order.flags !== 4 ||
      order.leverage !== 0 ||
      order.filled !== 0n ||
      order.size !== position.size
    )
      throw Error(
        "Amend only one verified waiting linked exit at the actual remaining size. Reconcile fills or resizing first.",
      );
    // Native Change retains the order identity. mnp is ignored by Change, so do not claim to change it.
    return {
      ...common,
      t: 7,
      oid: integer(order.id, 1),
      p,
      s,
      fl: 4,
      lb: 0,
      lp: position.id,
      tp,
      tpc,
    };
  }
  if (
    state.orders.some(
      (o) =>
        o.market.marketId === marketId &&
        o.linkedPosition === position.id &&
        o.triggerCondition === tpc,
    )
  )
    throw Error(
      "An exit for this condition already exists. Reconcile it before replacement.",
    );
  return {
    ...common,
    t: closeType,
    p,
    s,
    fl: 4,
    mnp: 0,
    lb: 0,
    lp: position.id,
    tp,
    tpc,
  };
}

export type ProtectionState =
  "missing" | "waiting" | "triggered" | "mismatch" | "unverified";
export function positionProtection(
  state: TradingState,
  position: TradingPosition,
) {
  const leg = (
    condition: 3 | 4,
  ): { state: ProtectionState; orderId?: number; detail: string } => {
    const closeType = position.side === "Long" ? 3 : 4;
    const candidates = state.orders.filter(
      (o) =>
        o.market.marketId === position.market.marketId &&
        o.linkedPosition === position.id &&
        o.triggerCondition === condition,
    );
    if (!candidates.length)
      return {
        state: "missing",
        detail:
          "No matching linked exit in this snapshot; exposure may be uncovered.",
      };
    const o = candidates[0];
    if (
      candidates.length !== 1 ||
      o.type !== closeType ||
      o.size - o.filled !== position.size ||
      !o.triggerPrice ||
      !o.price ||
      o.flags !== 4 ||
      !protectiveChildBound(closeType, o.price, o.triggerPrice)
    )
      return {
        state: "mismatch",
        orderId: o.id,
        detail:
          "Observed exit size, type or child-price bound does not match this exposure.",
      };
    if (o.status === 9)
      return {
        state: "triggered",
        orderId: o.id,
        detail:
          "Trigger observed; child execution and remaining exposure require reconciliation.",
      };
    if (o.status !== 8)
      return {
        state: "unverified",
        orderId: o.id,
        detail:
          "Exit is not waiting for its trigger. Reconcile execution history.",
      };
    return {
      state: "waiting",
      orderId: o.id,
      detail:
        "Linked exit observed waiting at the exact current size. Child execution and session survival remain unverified; fills are not guaranteed.",
    };
  };
  return position.side === "Long"
    ? { takeProfit: leg(3), stopLoss: leg(4) }
    : { takeProfit: leg(4), stopLoss: leg(3) };
}

/** Identity/economics used for immutable confirmation. A trigger/close race changes this binding. */
export function managementBinding(
  input: ManagementAdmission,
  payload: Omit<ManagementPayload, "rq">,
) {
  return JSON.stringify(
    {
      owner: getAddress(input.state.owner),
      account: input.state.accountId,
      feeTier: input.state.feeTier,
      action: input.action,
      risk:
        protectiveAction(input.action) && input.risk
          ? { ...input.risk, block: undefined, blockTime: undefined }
          : undefined,
      acknowledgeImmediate: input.acknowledgeImmediate === true,
      // The action and payload carry a collateral increase's amount and position id.
      free:
        input.action.kind === "add-collateral" ? input.state.free : undefined,
      payload: { ...payload, lb: 0 },
      positions: input.state.positions.filter(
        (p) => p.market.marketId === (input.action.marketId ?? 32),
      ),
      orders: input.state.orders.filter(
        (o) => o.market.marketId === (input.action.marketId ?? 32),
      ),
      market: input.state.markets.find(
        (m) => m.marketId === (input.action.marketId ?? 32),
      ),
    },
    (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
  );
}

/** Resume only the original confirmed bracket against its canonically correlated actual residual. */
export function initialProtectionAction(
  entry: import("./order-journal").OrderOperation,
  state: TradingState,
  management: import("./order-journal").ManagementOperation[],
  kind: "take-profit" | "stop-loss",
): ManagementAction | undefined {
  if (
    !entry.bracket ||
    !entry.filled ||
    !entry.positionId ||
    entry.completion ||
    entry.history !== "settled" ||
    !["filled", "partial-fill"].includes(entry.phase)
  )
    return undefined;
  if (entry.payload.acc !== state.accountId)
    throw Error("Original entry account changed.");
  if (management.some(managementUnresolved)) return undefined;
  const position = state.positions.find(
    (p) => p.id === entry.positionId && p.market.marketId === entry.payload.mkt,
  );
  if (!position) return undefined;
  if (
    position.side !== (entry.payload.t === 1 ? "Long" : "Short") ||
    position.size > BigInt(entry.filled)
  )
    throw Error(
      "Exposure changed beyond the original confirmed fill. Review protection separately.",
    );
  const leg =
    kind === "stop-loss"
      ? positionProtection(state, position).stopLoss
      : positionProtection(state, position).takeProfit;
  if (
    leg.state !== "missing" ||
    management.some(
      (op) =>
        op.positionId === position.id &&
        op.payload.mkt === position.market.marketId &&
        op.kind === kind &&
        !["discarded", "rejected"].includes(op.phase),
    )
  )
    return undefined;
  return bracketAction(position, entry.bracket, kind);
}

/** The confirmed stop or target as a linked exit: its limit sits 0.5% past the trigger. */
export function bracketAction(
  position: TradingPosition,
  bracket: { target: number; stop: number },
  kind: "take-profit" | "stop-loss",
): ManagementAction {
  const trigger = kind === "stop-loss" ? bracket.stop : bracket.target;
  return {
    kind,
    marketId: position.market.marketId as 16 | 32,
    positionId: position.id,
    trigger,
    price:
      position.side === "Long"
        ? Number((BigInt(trigger) * 9950n + 9999n) / 10000n)
        : Number((BigInt(trigger) * 10050n) / 10000n),
  };
}

/**
 * The position an acknowledged entry opened, as soon as Perpl's signed snapshot shows it.
 * Perpl's history can trail its live state by half a minute; a filled position must not
 * wait that long for its stop. This needs all of: Perpl acknowledged the order, Perpl's
 * request counter has passed it, and a position of the right side and no more than the
 * ordered size now exists in that market.
 */
export function observedEntryPosition(
  entry: import("./order-journal").OrderOperation,
  state: TradingState,
): TradingPosition | undefined {
  if (entry.phase !== "forwarded" || state.lastRequestId < entry.payload.rq)
    return undefined;
  return state.positions.find(
    (p) =>
      p.market.marketId === entry.payload.mkt &&
      p.side === (entry.payload.t === 1 ? "Long" : "Short") &&
      p.size > 0n &&
      p.size <= BigInt(entry.payload.s),
  );
}
