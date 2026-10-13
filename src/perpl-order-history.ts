import { decodeEventLog, parseAbi, type Hex } from "viem";
import {
  integer,
  object,
  type ManagementPayload,
  type EntryPayload,
} from "./order-journal";
import {
  testnet,
  testnetClient,
  type TestnetReadOptions,
} from "./testnet-config";

export type HistoryRoute =
  "order-history" | "fills" | "account-history" | "position-history";
export interface HistoryRow {
  time?: number; // Source block time in ms, when the indexer supplies it.
  block: number;
  hash?: Hex;
  log?: number;
  transaction?: number;
  account: number;
  market: number;
  order: number;
  request: number;
  type: number;
  status: number;
  reason: number;
  size: number;
  filled: number;
  price: number;
  fee: string;
  positionId?: number;
  amount?: string;
  balance?: string;
  locked?: string;
  pnl?: string;
  funding?: string;
  closeFee?: string;
  collateral?: string; // Position events: collateral moved by the event, micro AUSD.
  side?: number;
  linkedPosition?: number;
  triggerPrice?: number;
  triggerCondition?: number;
}
export interface OrderHistory {
  orders: HistoryRow[];
  fills: HistoryRow[];
  accounts: HistoryRow[];
  positions?: HistoryRow[];
  complete: boolean; // Reached each cursor's end; not proof the indexer has caught up.
}
const amount = (v: unknown) => {
  if (typeof v !== "string" || !/^-?\d{1,78}$/.test(v))
    throw Error("Invalid history amount.");
  return v;
};
function row(value: unknown, route: HistoryRoute): HistoryRow {
  const r = object(value);
  const at = object(r.at);
  if (
    at.txid !== undefined &&
    (typeof at.txid !== "string" || !/^(?:0x)?[\da-f]{64}$/i.test(at.txid))
  )
    throw Error("Invalid history transaction.");
  const common = {
    block: at.b === undefined ? 0 : integer(at.b, 1),
    ...(at.txid === undefined
      ? {}
      : {
          hash: `0x${String(at.txid).replace(/^0x/i, "").toLowerCase()}` as Hex,
        }),
    ...(at.t === undefined ? {} : { time: integer(at.t, 1) }),
    ...(at.tx === undefined ? {} : { transaction: integer(at.tx) }),
    ...(at.l === undefined ? {} : { log: integer(at.l) }),
    account: integer(route === "account-history" ? r.id : r.acc, 1),
    market: integer(
      route === "account-history" ? (r.m ?? 0) : r.mkt,
      route === "account-history" ? 0 : 1,
    ),
  };
  if (route === "account-history") {
    return {
      ...common,
      order: integer(r.o ?? 0),
      request: integer(r.r ?? 0),
      type: integer(r.et),
      status: 0,
      reason: 0,
      size: 0,
      filled: 0,
      price: 0,
      fee: amount(r.f),
      positionId: integer(r.p ?? 0),
      amount: amount(r.a),
      balance: amount(r.b),
      locked: amount(r.lb),
    };
  }
  if (route === "position-history") {
    const side = integer(r.sd, 1);
    const status = integer(r.st, 1);
    if (![1, 2].includes(side) || status > 6)
      throw Error("Invalid position history.");
    return {
      ...common,
      positionId: integer(r.pid, 1),
      request: integer(r.rq),
      order: integer(r.oid),
      type: side,
      side,
      status,
      reason: integer(r.sr),
      size: integer(r.s),
      filled: 0,
      price: integer(r.ep),
      fee: amount(r.fee),
      ...(r.dpnl === undefined ? {} : { pnl: amount(r.dpnl) }),
      ...(r.fnd === undefined ? {} : { funding: amount(r.fnd) }),
      ...(r.cfee === undefined ? {} : { closeFee: amount(r.cfee) }),
      ...(r.c === undefined ? {} : { collateral: amount(r.c) }),
    };
  }
  const type = integer(r.t, 1);
  if (type > 7) throw Error("Unsupported historical order type.");
  if (route === "fills")
    return {
      ...common,
      order: integer(r.oid, 1),
      request: 0,
      type,
      status: 0,
      reason: 0,
      size: integer(r.s, 1),
      filled: integer(r.s, 1),
      price: integer(r.p, 1),
      fee: amount(r.f),
    };
  const size = integer(r.os);
  const filled = integer(r.fs);
  const status = integer(r.st, 1);
  if (filled > size || status > 10)
    throw Error("Invalid historical order outcome.");
  return {
    ...common,
    order: integer(r.oid),
    request: integer(r.rq),
    type,
    status,
    reason: integer(r.sr ?? 0),
    size,
    filled,
    price: integer(r.p ?? 0),
    fee: amount(r.f),
    ...(r.lp === undefined ? {} : { linkedPosition: integer(r.lp) }),
    ...(r.tp === undefined ? {} : { triggerPrice: integer(r.tp) }),
    ...(r.tpc === undefined ? {} : { triggerCondition: integer(r.tpc) }),
  };
}

/** At most sixteen sequential reads; interruptions/limits never imply absence of execution. */
export async function readOrderHistory(
  read: (
    route: HistoryRoute,
    page?: string,
    signal?: AbortSignal,
  ) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<OrderHistory> {
  const result: OrderHistory = {
    orders: [],
    fills: [],
    accounts: [],
    positions: [],
    complete: true,
  };
  for (const [route, key] of [
    ["order-history", "orders"],
    ["fills", "fills"],
    ["account-history", "accounts"],
    ["position-history", "positions"],
  ] as const) {
    let page: string | undefined;
    const cursors = new Set<string>();
    const events = new Map<string, string>();
    for (let n = 0; n < 4; n++) {
      signal?.throwIfAborted();
      const response = object(await read(route, page, signal));
      signal?.throwIfAborted();
      if (
        !Array.isArray(response.d) ||
        response.d.length > 100 ||
        typeof response.np !== "string" ||
        (response.np !== "" && !/^[\x21-\x7e]{1,512}$/.test(response.np))
      )
        throw Error("Incomplete history page.");
      const values =
        route === "position-history"
          ? response.d.flatMap((value) => {
              const parent = object(value);
              if (parent.e === undefined) return [value];
              if (!Array.isArray(parent.e) || parent.e.length > 100)
                throw Error("Invalid position event history.");
              for (const event of parent.e) {
                const child = object(event);
                if (
                  child.acc !== parent.acc ||
                  child.mkt !== parent.mkt ||
                  child.pid !== parent.pid
                )
                  throw Error("Position history identity changed.");
              }
              return parent.e.length ? parent.e : [value];
            })
          : response.d;
      for (const value of values) {
        const parsed = row(value, route);
        const encoded = JSON.stringify(parsed);
        const id =
          parsed.hash && parsed.log !== undefined
            ? `${parsed.hash.toLowerCase()}:${parsed.log}:${parsed.order}:${parsed.positionId ?? 0}:${route === "position-history" ? parsed.reason : 0}`
            : encoded;
        if (events.has(id)) {
          if (events.get(id) !== encoded)
            throw Error("Conflicting historical event.");
          continue;
        }
        events.set(id, encoded);
        result[key]!.push(parsed);
      }
      // A short page is the last page. Asking for the next one only spends a request
      // from the per-minute budget to receive an empty list.
      if (response.np === "" || response.d.length < 100) break;
      if (cursors.has(response.np))
        throw Error("History cursor repeated. Retry reconciliation later.");
      cursors.add(response.np);
      page = response.np;
      if (n === 3) result.complete = false;
    }
  }
  return result;
}

/** A terminal history row alone cannot resolve a failed/duplicate request. */
export async function rejectedRequest<
  P extends EntryPayload | ManagementPayload,
>(
  payload: P,
  history: OrderHistory,
  state: import("./perpl-trading-state").TradingState,
  settlement: (
    payload: P,
    hash: Hex,
  ) => Promise<SettlementProof | null> = readEntrySettlement,
) {
  if (!history.complete || ![1, 2, 3, 4].includes(payload.t) || "tp" in payload)
    return false;
  const rows = history.orders.filter(
    (r) =>
      r.account === payload.acc &&
      r.market === payload.mkt &&
      r.request === payload.rq,
  );
  const r = rows[0];
  if (
    rows.length !== 1 ||
    !r?.hash ||
    !r.block ||
    r.status !== 7 ||
    r.reason === 32 ||
    r.type !== payload.t ||
    r.size !== payload.s ||
    r.price !== payload.p ||
    r.filled !== 0 ||
    BigInt(r.fee) !== 0n ||
    state.lastRequestId < payload.rq ||
    state.sources.some((s) => s.block < r.block) ||
    state.orders.some(
      (o) => o.market.marketId === payload.mkt && o.request === payload.rq,
    ) ||
    [...history.fills, ...history.accounts, ...(history.positions ?? [])].some(
      (v) =>
        v.account === payload.acc &&
        (v.request === payload.rq ||
          (v.market === payload.mkt && r.order > 0 && v.order === r.order)),
    )
  )
    return false;
  const proof = await settlement(payload, r.hash);
  return (
    !!proof?.rejected &&
    r.reason ===
      { expired: 14, "exceeds-position": 10, "position-mismatch": 11 }[
        proof.rejected
      ] &&
    (proof.rejected === "expired"
      ? proof.block > payload.lb
      : [3, 4].includes(payload.t)) &&
    proof.filled === 0 &&
    BigInt(proof.fee) === 0n &&
    !proof.closed &&
    !proof.decreased &&
    proof.block === r.block &&
    proof.hash.toLowerCase() === r.hash.toLowerCase()
  );
}

export const orderReceiptAbi = parseAbi([
  "event OrderRequestV2(uint256 perpId,uint256 accountId,uint256 orderDescId,uint256 orderId,uint8 orderType,uint256 pricePNS,uint256 lotLNS,uint256 expiryBlock,bool postOnly,bool fillOrKill,bool immediateOrCancel,uint256 maxMatches,uint256 leverageHdths,uint256 lastExecutionBlock,uint256 amountCNS,uint256 maxNegPnlCollatBPS,uint256 gasLeft,bytes extension)",
  "event TakerOrderFilledV2(uint256 entryPricePNS,uint256 collatPricePNS,uint256 pnlPricePNS,uint256 lotLNS,uint256 feeCNS,int256 amountCNS,uint256 balanceCNS,uint256 builderId,uint256 builderFeeCNS)",
  "event PositionClosed(uint256 perpId,uint256 accountId,uint8 positionType,uint256 pricePNS,int256 deltaPnlCNS,int256 fundingCNS)",
  "event PositionDecreased(uint256 perpId,uint256 accountId,uint8 positionType,uint256 startDepositCNS,uint256 endDepositCNS,uint256 startLotLNS,uint256 endLotLNS,int256 deltaPnlCNS,int256 fundingCNS)",
  "event ExceedsLastExecutionBlock(uint256 lastExecutionBlock)",
  "event CloseOrderExceedsPosition(uint256 posLotLNS,uint256 orderLotLNS)",
  "event CloseOrderPositionMismatch(uint8 positionType,uint8 orderType)",
  "event OrderBatchCompleted(uint256 gasLeft)",
]);
export interface SettlementProof {
  rejected?: "expired" | "exceeds-position" | "position-mismatch";
  filled: number;
  fee: string;
  block: number;
  hash: Hex;
  amount?: string;
  balance?: string;
  closed?: { pnl: string; funding: string };
  decreased?: { start: number; end: number; pnl: string; funding: string };
}

/** The accountless taker event is attributable only inside its matching request segment. */
export async function readEntrySettlement(
  payload: EntryPayload | ManagementPayload,
  hash: Hex,
  options: TestnetReadOptions = {},
): Promise<SettlementProof | null> {
  if (
    ![1, 2, 3, 4].includes(payload.t) ||
    ("tp" in payload && payload.tp !== undefined)
  )
    throw Error("Only immediate entry/close settlement is supported.");
  const client = testnetClient(options);
  if ((await client.getChainId()) !== 10143)
    throw Error("Settlement RPC is not Monad testnet.");
  const receipt = await client.getTransactionReceipt({ hash });
  const finalized = await client.getBlock({ blockTag: "finalized" });
  if (
    finalized.number === null ||
    receipt.blockNumber > finalized.number ||
    Date.now() - Number(finalized.timestamp) * 1000 > 60000
  )
    return null;
  const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (
    canonical.hash !== receipt.blockHash ||
    receipt.status !== "success" ||
    receipt.transactionHash.toLowerCase() !== hash.toLowerCase()
  )
    return null;
  let matching = false;
  let exactFailureRequest = false;
  let matchingRequests = 0;
  let failure: SettlementProof["rejected"];
  let failureBlocked = false;
  let failureCompleted = false;
  let closed: SettlementProof["closed"];
  let decreased: SettlementProof["decreased"];
  let proof: SettlementProof | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== testnet.exchange.toLowerCase()) continue;
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: orderReceiptAbi,
        data: log.data,
        topics: log.topics,
      });
    } catch {
      if (exactFailureRequest) failureBlocked = true;
      continue;
    }
    if (decoded.eventName === "OrderRequestV2") {
      if (exactFailureRequest && failure) failureCompleted = true;
      const a = decoded.args;
      exactFailureRequest =
        a.accountId === BigInt(payload.acc) &&
        a.perpId === BigInt(payload.mkt) &&
        a.orderDescId === BigInt(payload.rq) &&
        a.orderType === payload.t - 1 &&
        a.orderId === 0n &&
        a.pricePNS === BigInt(payload.p!) &&
        a.lotLNS === BigInt(payload.s) &&
        a.leverageHdths === BigInt(payload.lv) &&
        a.immediateOrCancel &&
        !a.postOnly &&
        !a.fillOrKill &&
        a.expiryBlock === 0n &&
        a.maxNegPnlCollatBPS === BigInt(payload.mnp ?? 0) &&
        a.lastExecutionBlock === BigInt(payload.lb) &&
        a.extension === "0x";
      if (
        a.accountId === BigInt(payload.acc) &&
        a.perpId === BigInt(payload.mkt) &&
        a.orderDescId === BigInt(payload.rq)
      )
        matchingRequests++;
      closed = undefined;
      decreased = undefined;
      matching =
        a.accountId === BigInt(payload.acc) &&
        a.perpId === BigInt(payload.mkt) &&
        a.orderDescId === BigInt(payload.rq) &&
        a.orderType === payload.t - 1 &&
        a.pricePNS === BigInt(payload.p!) &&
        a.lotLNS === BigInt(payload.s) &&
        a.leverageHdths === BigInt(payload.lv) &&
        a.immediateOrCancel &&
        !a.postOnly &&
        !a.fillOrKill &&
        a.maxNegPnlCollatBPS === BigInt(payload.mnp ?? 0) &&
        a.lastExecutionBlock >= receipt.blockNumber &&
        a.lastExecutionBlock <= BigInt(payload.lb) &&
        a.extension === "0x";
    } else if (
      exactFailureRequest &&
      decoded.eventName === "ExceedsLastExecutionBlock" &&
      decoded.args.lastExecutionBlock === BigInt(payload.lb) &&
      receipt.blockNumber > BigInt(payload.lb)
    ) {
      if (failure) failureBlocked = true;
      failure = "expired";
    } else if (
      exactFailureRequest &&
      decoded.eventName === "CloseOrderExceedsPosition" &&
      [3, 4].includes(payload.t) &&
      decoded.args.orderLotLNS === BigInt(payload.s) &&
      decoded.args.posLotLNS < BigInt(payload.s)
    ) {
      if (failure) failureBlocked = true;
      failure = "exceeds-position";
    } else if (
      exactFailureRequest &&
      decoded.eventName === "CloseOrderPositionMismatch" &&
      [3, 4].includes(payload.t) &&
      decoded.args.orderType === payload.t - 1 &&
      decoded.args.positionType !== (payload.t === 3 ? 0 : 1)
    ) {
      if (failure) failureBlocked = true;
      failure = "position-mismatch";
    } else if (
      (decoded.eventName === "PositionClosed" ||
        decoded.eventName === "PositionDecreased") &&
      matching &&
      [3, 4].includes(payload.t)
    ) {
      if (exactFailureRequest) failureBlocked = true;
      const a = decoded.args;
      if (
        a.accountId !== BigInt(payload.acc) ||
        a.perpId !== BigInt(payload.mkt)
      )
        continue;
      if (a.positionType !== (payload.t === 3 ? 0 : 1) || closed || decreased)
        throw Error("Ambiguous position closure segment.");
      const amounts = {
        pnl: a.deltaPnlCNS.toString(),
        funding: a.fundingCNS.toString(),
      };
      if (decoded.eventName === "PositionClosed") closed = amounts;
      else {
        const a = decoded.args;
        if (a.endLotLNS <= 0n || a.endLotLNS >= a.startLotLNS)
          throw Error("Invalid decrease remainder.");
        decreased = {
          ...amounts,
          start: integer(Number(a.startLotLNS), 1),
          end: integer(Number(a.endLotLNS), 1),
        };
      }
    } else if (decoded.eventName === "TakerOrderFilledV2" && matching) {
      if (exactFailureRequest) failureBlocked = true;
      const a = decoded.args;
      if (
        proof ||
        a.lotLNS > BigInt(payload.s) ||
        (decreased && BigInt(decreased.start - decreased.end) !== a.lotLNS) ||
        a.builderFeeCNS !== 0n ||
        (a.lotLNS > 0n &&
          ([1, 4].includes(payload.t)
            ? a.entryPricePNS > BigInt(payload.p!)
            : a.entryPricePNS < BigInt(payload.p!)))
      )
        throw Error("Conflicting entry settlement.");
      proof = {
        filled: integer(Number(a.lotLNS)),
        fee: a.feeCNS.toString(),
        block: integer(Number(receipt.blockNumber), 1),
        hash,
        ...([3, 4].includes(payload.t)
          ? {
              amount: a.amountCNS.toString(),
              balance: a.balanceCNS.toString(),
              ...(closed ? { closed } : {}),
              ...(decreased ? { decreased } : {}),
            }
          : {}),
      };
    } else if (
      exactFailureRequest &&
      decoded.eventName === "OrderBatchCompleted"
    ) {
      if (failure) failureCompleted = true;
    } else if (
      exactFailureRequest &&
      decoded.eventName !== "OrderBatchCompleted"
    ) {
      failureBlocked = true;
    }
  }
  if (
    failure &&
    failureCompleted &&
    !failureBlocked &&
    matchingRequests === 1 &&
    !proof
  )
    return {
      rejected: failure,
      filled: 0,
      fee: "0",
      hash,
      block: integer(Number(receipt.blockNumber), 1),
    };
  return proof;
}
