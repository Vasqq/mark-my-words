import { reconcileLifecycleCompletion } from "./perpl-lifecycle-settlement";
import {
  managementPayload,
  readPositionRisk,
  positionRiskAbi,
  positionProtection,
  type ManagementAdmission,
} from "./perpl-lifecycle";
import {
  createOrderApplication,
  batchOutcomes,
  type OrderAdmission,
} from "./order-application";
import { readOrderHistory, type OrderHistory } from "./perpl-order-history";
import { accountLockName, type AccountLock } from "./account-coordination";
import {
  orderJournalKey,
  assertNoUnresolvedOrders,
  assertEntryAvailable,
  refreshRecordedProtection,
  validateManagementPayload,
} from "./order-journal";
import { describe, expect, it, vi } from "vitest";
import {
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  multicall3Abi,
  type Hex,
} from "viem";
import { OrderNotSent } from "./perpl-request-budget";
import { testnet } from "./testnet-config";
import { U, type Intent } from "./financial-model";
import { parseIntent, readSavedIntent } from "./intent-storage";
import {
  sizingAbi,
  sizeLiveIntent,
  type LiveSizingReview,
} from "./perpl-sizing";
import type { PublicMarketObservation } from "./perpl-market-data";
import type { TradingState } from "./perpl-trading-state";
import {
  assessTradeReview,
  readTradeReview,
  tradeReviewFresh,
} from "./perpl-trade-review";

const owner = `0x${"1".repeat(40)}`;
function fixture(
  side: Intent["side"] = "long",
  market: Intent["market"] = "ETH",
) {
  const now = Date.now();
  const intent: Intent = {
    market,
    side,
    goal: 3n * U,
    target: (side === "long" ? 3000n : 2000n) * U,
    stop: (side === "long" ? 2400n : 2600n) * U,
    budget: 100n * U,
    leverage: 300n,
    revision: 1,
  };
  const observation: PublicMarketObservation = {
    metadata: {
      symbol: "ETH",
      marketId: 32,
      instanceId: 12,
      configBlock: 10,
      configTime: now,
      contextVersion: 1,
      tick: 10000n,
      lot: 1000n,
      priceDecimals: 2,
      sizeDecimals: 3,
      open: true,
      baseTakerFeePpm: 345n,
      takerFeeTiersPpm: [345n, 200n],
      initialMarginFactor: 1200,
      maintenanceMarginFactor: 2000,
      fundingIntervalBlocks: 8571,
      fundingIntervalSeconds: 2580,
    },
    mark: 2500n * U,
    bestAsk: 2500n * U,
    bestBid: 2500n * U,
    asks: [{ price: 2500n * U, lots: 1000000n }],
    bids: [{ price: 2500n * U, lots: 1000000n }],
    bookBlock: 100,
    stateBlock: 100,
    bookTime: now,
    stateTime: now,
    receivedAt: now,
  };
  if (market === "BTC") {
    Object.assign(intent, {
      goal: 1n * U,
      target: (side === "long" ? 68000n : 62000n) * U,
      stop: (side === "long" ? 64000n : 66000n) * U,
    });
    Object.assign(observation.metadata, {
      symbol: "BTC",
      marketId: 16,
      tick: 100000n,
      lot: 10n,
      priceDecimals: 1,
      sizeDecimals: 5,
      initialMarginFactor: 1500,
      maintenanceMarginFactor: 2500,
      baseTakerFeePpm: 550n,
      takerFeeTiersPpm: [550n, 420n],
    });
    Object.assign(observation, {
      mark: 65000n * U,
      bestBid: 65000n * U,
      bestAsk: 65000n * U,
      bids: [{ price: 65000n * U, lots: 1000000n }],
      asks: [{ price: 65000n * U, lots: 1000000n }],
    });
  }
  const sizing: LiveSizingReview = {
    intent,
    observation,
    size: sizeLiveIntent(intent, observation),
    block: 100n,
    blockTime: now,
    dynamicLeverage: BigInt(observation.metadata.initialMarginFactor),
    maintenanceFactor: BigInt(observation.metadata.maintenanceMarginFactor),
    baseMargin: 16666667n,
  };
  const account: TradingState = {
    owner,
    accountId: 1057,
    balance: 100n * U,
    free: 98n * U,
    locked: 2n * U,
    forwarding: true,
    frozen: false,
    feeTier: 0,
    lastRequestId: 17,
    markets: [observation.metadata],
    restrictions: {
      minimumInitialDeposit: 100n * U,
      halted: false,
      addressBlocked: false,
      whitelistEnabled: false,
      whitelisted: false,
    },
    positions: [],
    orders: [],
    sources: [{ name: "Wallet", block: 100, time: now }],
    receivedAt: now,
    reconciled: true,
  };
  return { now, intent, observation, sizing, account };
}

describe("account-aware trade review", () => {
  it("stops a cancelled review after account reads without starting market or margin reads", async () => {
    const { account, intent } = fixture();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>();
    const readSizing =
      vi.fn<typeof import("./perpl-sizing").reviewLiveSizing>();
    await expect(
      readTradeReview(owner, intent, async () => ({}), {
        signal: controller.signal,
        fetcher,
        readSizing,
        readAccount: async () => {
          controller.abort();
          return account;
        },
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(readSizing).not.toHaveBeenCalled();
  });
  it("uses account-tier fees, exact margin and spendable collateral while allowing another market's position", () => {
    const { sizing, account } = fixture();
    account.positions.push({
      id: 2,
      market: { ...account.markets[0], symbol: "BTC", marketId: 16 },
      side: "Short",
      size: 10n,
      entryPrice: 800000n,
      entryResidueQ16: 0,
      collateral: U,
      fees: 0n,
    });
    const review = assessTradeReview(owner, sizing, account);
    expect(review.blockers).toEqual([]);
    expect(review.entryFee).toBe(5175n);
    expect(review.estimatedCollateral).toBe(5000000n);
    expect(review.estimatedDebit).toBe(5005175n);
    expect(review.fundingAllowance).toBe(5085277n);
    expect(review.targetAfterFees).toBe(2988615n);
    expect(review.stopAfterFees).toBe(-610143n);
    expect(review.liquidation).toBe(1791666667n);
    account.feeTier = 1;
    expect(assessTradeReview(owner, sizing, account).entryFee).toBe(3000n);
    account.free = 3n * U;
    account.locked = 97n * U;
    expect(
      assessTradeReview(owner, sizing, account).fundingShortfall,
    ).toBeGreaterThan(0n);
    account.positions[0].market = account.markets[0];
    expect(assessTradeReview(owner, sizing, account).blockers).toContain(
      "This market already has a net position. Increasing or reversing it needs a separate review.",
    );
  });

  it("keeps short price improvement out of hard-cap claims and rejects inadequate stop buffers in both directions", () => {
    for (const side of ["long", "short"] as const) {
      const { sizing, account } = fixture(side);
      const good = assessTradeReview(owner, sizing, account);
      expect(good.blockers).toEqual([]);
      expect(typeof good.entryNotionalCeiling).toBe("bigint");
      sizing.intent.stop = good.stopBoundary;
      expect(
        assessTradeReview(owner, sizing, account).blockers.join(" "),
      ).toContain("1% mark-price buffer");
      sizing.dynamicLeverage = 200n;
      expect(
        assessTradeReview(owner, sizing, account).blockers.join(" "),
      ).toContain("size-specific margin limit");
    }
  });

  it("fails closed on stale or mismatched sources, unknown fees, account restrictions and changed saved inputs", () => {
    const { sizing, account, now, intent } = fixture();
    expect(() =>
      assessTradeReview(owner, sizing, account, now + 31000),
    ).toThrow("stale");
    expect(() =>
      assessTradeReview(`0x${"2".repeat(40)}`, sizing, account),
    ).toThrow("another wallet");
    account.sources[0].time -= 26000;
    expect(() => assessTradeReview(owner, sizing, account)).toThrow(
      "too far apart",
    );
    account.sources[0].time = now;
    account.feeTier = 99;
    expect(() => assessTradeReview(owner, sizing, account)).toThrow(
      "taker fee",
    );
    account.feeTier = 0;
    const result = assessTradeReview(owner, sizing, {
      ...account,
      forwarding: false,
      reconciled: false,
      frozen: true,
      restrictions: {
        ...account.restrictions,
        halted: true,
        whitelistEnabled: true,
      },
    });
    expect(result.blockers).toHaveLength(5);
    expect(tradeReviewFresh(result, now + 31000)).toBe(false);
    const raw = JSON.stringify(intent, (_, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(parseIntent(raw)).toEqual(intent);
    expect(() => readSavedIntent({ getItem: () => null })).toThrow(
      "Create a sentence",
    );
    for (const change of [
      { market: "SOL" },
      { side: "both" },
      { goal: "-1" },
      { goal: "1e6" },
      { revision: "1" },
      { budget: "99999999999999999" },
    ]) {
      expect(() =>
        parseIntent(JSON.stringify({ ...JSON.parse(raw), ...change })),
      ).toThrow();
    }
  });
});

describe("durable testnet order boundary", () => {
  function environment() {
    const { sizing, account, now } = fixture();
    const values = new Map<string, string>();
    let rejectSave = false;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (rejectSave) throw Error("disk unavailable");
        values.set(key, value);
      },
    };
    const held = new Set<string>();
    const lock: AccountLock = async (key, work) => {
      if (held.has(key)) throw Error("Account busy");
      held.add(key);
      try {
        return await work();
      } finally {
        held.delete(key);
      }
    };
    const input: OrderAdmission = {
      review: assessTradeReview(owner, sizing, account, now),
      sessionId: crypto.randomUUID(),
      sessionExpiresAt: now + 3600000,
      reviewExpiresAt: now + 10000,
      ttlBlocks: 20,
    };
    let time = now;
    const options = { storage, lock, now: () => time };
    return {
      input,
      options,
      values,
      held,
      storage,
      time: (v: number) => {
        time = v;
      },
      rejectSave: () => {
        rejectSave = true;
      },
    };
  }
  it("persists immutable economics, reserves IDs above protocol activity and refuses to dispatch without a sender", async () => {
    const h = environment();
    const app = createOrderApplication(owner, h.options);
    const pending = app.prepare(h.input);
    h.input.review.sizing.intent.goal = 500n * U;
    const op = await pending;
    expect(op.payload.rq).toBe(18);
    expect(op.payload).toMatchObject({
      acc: 1057,
      mkt: 32,
      t: 1,
      s: 6,
      fl: 4,
      mnp: 50,
      lb: 120,
    });
    expect(app.read()?.operations[0].binding).toMatch(/^[a-f\d]{64}$/);
    op.payload.s = 99;
    expect(app.read()?.operations[0].payload.s).toBe(6);
    expect(app.readiness()).toBe("no-sender");
    await expect(app.dispatch(op.id, async () => h.input)).rejects.toThrow(
      "unavailable",
    );
    await app.discard(op.id);
    h.input.review.sizing.intent.goal = 10n * U;
    h.input.review.account.lastRequestId = 70;
    expect((await app.prepare(h.input)).payload.rq).toBe(71);
    expect([...h.values.values()].join()).not.toMatch(
      /token|signature|privateKey/,
    );
  });
  it("distinguishes crash-before-send from possible broadcast and never resends after response loss or reload", async () => {
    const h = environment();
    const sender = vi.fn(async () => {
      throw Error("response lost after acceptance");
    });
    const app = createOrderApplication(owner, { ...h.options, sender });
    const op = await app.prepare(h.input);
    const restored = createOrderApplication(owner, { ...h.options, sender });
    expect(restored.read()?.operations[0].phase).toBe("prepared");
    expect((await restored.dispatch(op.id, async () => h.input)).phase).toBe(
      "unknown",
    );
    await expect(app.dispatch(op.id, async () => h.input)).rejects.toThrow(
      "cannot be sent again",
    );
    await expect(app.discard(op.id)).rejects.toThrow("never-submitted");
    await expect(app.prepare(h.input)).rejects.toThrow("Resolve");
    expect(sender).toHaveBeenCalledTimes(1);
    expect(() => assertNoUnresolvedOrders(h.storage, owner)).toThrow("Resolve");
  });
  it("marks a provably unsent order rejected and lets a later entry proceed, but a plain sender error stays unknown and blocks it", async () => {
    const h = environment();
    const notSent = createOrderApplication(owner, {
      ...h.options,
      sender: vi.fn(async () => {
        throw new OrderNotSent("x");
      }),
    });
    const first = await notSent.prepare(h.input);
    expect((await notSent.dispatch(first.id, async () => h.input)).phase).toBe(
      "rejected",
    );
    expect(() => assertNoUnresolvedOrders(h.storage, owner)).not.toThrow();
    const second = await notSent.prepare(h.input);
    expect(second.id).not.toBe(first.id);
    const plain = vi.fn(async () => {
      throw Error("response lost");
    });
    const lossy = createOrderApplication(owner, {
      ...h.options,
      sender: plain,
    });
    expect((await lossy.dispatch(second.id, async () => h.input)).phase).toBe(
      "unknown",
    );
    await expect(lossy.prepare(h.input)).rejects.toThrow("Resolve");
    expect(() => assertNoUnresolvedOrders(h.storage, owner)).toThrow("Resolve");
  });
  it("blocks storage failures, competing tabs, changed identity/economics/counter and stale admission before sending", async () => {
    for (const change of [
      (h: ReturnType<typeof environment>) => {
        h.rejectSave();
      },
      (h: ReturnType<typeof environment>) => {
        const raw = JSON.parse(h.values.get(orderJournalKey(owner))!);
        raw.operations[0].payload.s++;
        h.values.set(orderJournalKey(owner), JSON.stringify(raw));
      },
      (h: ReturnType<typeof environment>) => {
        h.input.sessionId = crypto.randomUUID();
      },
      (h: ReturnType<typeof environment>) => {
        h.input.review.sizing.intent.stop -= U;
      },
      (h: ReturnType<typeof environment>) => {
        h.input.review.account.lastRequestId++;
      },
      (h: ReturnType<typeof environment>) => {
        h.time(h.input.reviewExpiresAt);
      },
      (h: ReturnType<typeof environment>) => {
        h.input.review.account.owner = `0x${"2".repeat(40)}`;
      },
    ]) {
      const h = environment();
      const sender = vi.fn(async () => ({}));
      const app = createOrderApplication(owner, { ...h.options, sender });
      const op = await app.prepare(h.input);
      change(h);
      await expect(app.dispatch(op.id, async () => h.input)).rejects.toThrow();
      expect(sender).not.toHaveBeenCalled();
    }
    const h = environment();
    const app = createOrderApplication(owner, h.options);
    h.held.add(accountLockName(owner));
    await expect(app.prepare(h.input)).rejects.toThrow("busy");
    expect(app.read()).toBeNull();
    h.held.clear();
    const fundingKey = `perpl-funding-v1:10143:${owner.toLowerCase()}`;
    h.values.set(
      fundingKey,
      JSON.stringify({
        version: 1,
        revision: "pending-funding",
        owner,
        amount: "1",
        nonce: 0,
        kind: "withdraw",
        status: "unknown",
      }),
    );
    await expect(app.prepare(h.input)).rejects.toThrow(
      "pending wallet transaction",
    );
    expect(app.read()).toBeNull();
    h.values.delete(fundingKey);
    h.rejectSave();
    await expect(app.prepare(h.input)).rejects.toThrow("disk");
    expect(app.read()).toBeNull();
  });
  it("retains a submitting barrier if saving an acknowledgment fails; validates every batch outcome", async () => {
    const h = environment();
    const sender = vi.fn(async () => {
      h.rejectSave();
      return { mt: 31, status: { code: 0 }, statuses: [{ code: 0 }] };
    });
    const app = createOrderApplication(owner, { ...h.options, sender });
    const op = await app.prepare(h.input);
    await expect(app.dispatch(op.id, async () => h.input)).rejects.toThrow(
      "disk",
    );
    expect(app.read()?.operations[0].phase).toBe("submitting");
    await expect(app.dispatch(op.id, async () => h.input)).rejects.toThrow(
      "cannot be sent again",
    );
    expect(sender).toHaveBeenCalledTimes(1);
    expect(
      batchOutcomes(
        {
          mt: 31,
          status: { code: 0 },
          statuses: [{ code: 0 }, { code: 429 }, { code: 400 }],
        },
        3,
      ),
    ).toEqual(["forwarded", "rejected", "rejected"]);
    for (const response of [
      {},
      { mt: 31, status: { code: 0 }, statuses: [{ code: 0 }] },
      { mt: 31, status: { code: 400 }, statuses: [{ code: 0 }] },
    ])
      expect(() => batchOutcomes(response, 2)).toThrow();
    const h2 = environment();
    const malformed = createOrderApplication(owner, {
      ...h2.options,
      sender: async () => ({ mt: 31, status: { code: 0 }, statuses: [] }),
    });
    const p = await malformed.prepare(h2.input);
    expect((await malformed.dispatch(p.id, async () => h2.input)).phase).toBe(
      "unknown",
    );
    const raw = JSON.parse(h2.values.get(orderJournalKey(owner))!);
    raw.operations[0].phase = "filled";
    h2.values.set(orderJournalKey(owner), JSON.stringify(raw));
    expect(() => malformed.read()).toThrow("Inconsistent");
  });
  it("requires complete correlated history and finalized settlement, keeps partial exposure and protection pending", async () => {
    const h = environment();
    const app = createOrderApplication(owner, {
      ...h.options,
      sender: async () => ({
        mt: 31,
        status: { code: 0 },
        statuses: [{ code: 0 }],
      }),
    });
    const op = await app.prepare(h.input);
    expect((await app.dispatch(op.id, async () => h.input)).phase).toBe(
      "forwarded",
    );
    const hash = `0x${"ab".repeat(32)}` as const;
    const state = h.input.review.account;
    state.lastRequestId = 18;
    const history: OrderHistory = {
      orders: [],
      fills: [],
      accounts: [],
      complete: true,
    };
    const settlement = vi.fn(async () => ({
      filled: 3,
      fee: "9",
      block: 100,
      hash,
    }));
    const readers = {
      state: async () => state,
      history: async () => history,
      settlement,
    };
    expect((await app.reconcile(op.id, readers)).phase).toBe("forwarded");
    expect(settlement).not.toHaveBeenCalled();
    const row = {
      block: 100,
      hash,
      log: 1,
      account: 1057,
      market: 32,
      order: 900,
      request: 18,
      type: 1,
      status: 5,
      reason: 16,
      size: 6,
      filled: 3,
      price: op.payload.p,
      fee: "9",
    };
    history.orders.push(row);
    expect((await app.reconcile(op.id, readers)).phase).toBe("forwarded"); // Missing indexed fills.
    history.fills.push({ ...row, size: 3 });
    history.complete = false;
    expect((await app.reconcile(op.id, readers)).phase).toBe("forwarded");
    history.complete = true;
    expect(await app.reconcile(op.id, readers)).toMatchObject({
      phase: "partial-fill",
      filled: 3,
      protection: "pending",
      history: "settled",
    });
    history.positions = [
      { ...row, positionId: 99, side: 1, status: 1, reason: 21, size: 3 },
    ];
    expect((await app.reconcile(op.id, readers)).positionId).toBe(99);
    // The partial fill's exposure is open on Perpl.
    state.positions = [
      {
        id: 99,
        market: state.markets[0],
        side: "Long",
        size: 3n,
        entryPrice: BigInt(op.payload.p),
        entryResidueQ16: 0,
        collateral: 3n * U,
        fees: 9n,
      },
    ];
    expect(() => assertEntryAvailable(app.read(), state, 32)).toThrow(
      "Resolve",
    );
    expect(() => assertNoUnresolvedOrders(h.storage, owner)).toThrow(
      "exposure",
    );
  });
  async function managementEnvironment(
    sender = vi.fn(async (): Promise<unknown> => ({
      mt: 31,
      status: { code: 0 },
      statuses: [{ code: 0 }],
    })),
  ) {
    const h = environment();
    const app = createOrderApplication(owner, { ...h.options, sender });
    await app.prepare(h.input);
    const journal = app.read()!;
    // Injected journal state: a prior 20-lot entry already partially filled (not an admission).
    journal.operations[0] = {
      ...journal.operations[0],
      payload: { ...journal.operations[0].payload, s: 20 },
      phase: "partial-fill",
      filled: 10,
      protection: "pending",
      history: "settled",
      settlement: { hash: `0x${"ab".repeat(32)}`, block: 100, orderId: 900 },
    };
    h.storage.setItem(orderJournalKey(owner), JSON.stringify(journal));
    const state = structuredClone(h.input.review.account);
    state.lastRequestId = 18;
    state.positions = [
      {
        id: 99,
        market: state.markets[0],
        side: "Long",
        size: 10n,
        entryPrice: 250000n,
        entryResidueQ16: 0,
        collateral: 10n * U,
        fees: 9n,
      },
    ];
    const input: ManagementAdmission = {
      state,
      action: {
        kind: "take-profit",
        positionId: 99,
        trigger: 300000,
        price: 298500,
      },
      sessionId: h.input.sessionId,
      sessionExpiresAt: h.input.sessionExpiresAt,
      reviewExpiresAt: h.input.reviewExpiresAt,
      ttlBlocks: 20,
      risk: {
        accountId: state.accountId,
        positionId: 99,
        marketId: 32,
        block: 100n,
        blockTime: Date.now(),
        size: 10n,
        entryPrice: 250000n,
        entryResidueQ16: 0,
        collateral: 10n * U,
        premiumPnl: 0n,
        mark: 250000n,
        maintenanceFactor: BigInt(state.markets[0].maintenanceMarginFactor),
        dynamicLeverage: 1200n,
      },
    };
    return { h, app, state, input, sender };
  }
  it("sizes each linked protective exit from the actual partial fill and never infers both legs from an ACK", async () => {
    const { app, state, input } = await managementEnvironment();
    const op = await app.management.prepare(input);
    expect(op.payload).toMatchObject({
      t: 3,
      s: 10,
      p: 298500,
      tp: 300000,
      tpc: 3,
      lp: 99,
      lb: 0,
      lv: 0,
    });
    expect(
      (await app.management.dispatch(op.id, async () => input)).phase,
    ).toBe("forwarded");
    expect(positionProtection(state, state.positions[0])).toMatchObject({
      takeProfit: { state: "missing" },
      stopLoss: { state: "missing" },
    });
    const history = { orders: [], fills: [], accounts: [], complete: true };
    state.lastRequestId = op.payload.rq;
    state.orders.push({
      id: 901,
      request: op.payload.rq,
      market: state.markets[0],
      type: 3,
      status: 8,
      size: 10n,
      filled: 0n,
      price: 298500n,
      flags: 4,
      triggerCondition: 3,
      triggerPrice: 300000n,
      linkedPosition: 99,
    });
    expect(
      (
        await app.management.reconcile(op.id, {
          state: async () => state,
          history: async () => history,
        })
      ).phase,
    ).toBe("observed");
    expect(positionProtection(state, state.positions[0])).toMatchObject({
      takeProfit: { state: "waiting" },
      stopLoss: { state: "missing" },
    });
    state.orders[0].size = 20n;
    expect(positionProtection(state, state.positions[0]).takeProfit.state).toBe(
      "mismatch",
    );
    state.orders[0].size = 10n;
    state.orders[0].price = 270000n;
    expect(positionProtection(state, state.positions[0]).takeProfit.state).toBe(
      "mismatch",
    );
    expect(() =>
      managementPayload(
        owner,
        {
          ...input,
          action: {
            kind: "stop-loss",
            positionId: 99,
            trigger: 240000,
            price: 200000,
          },
        },
        Date.now(),
      ),
    ).toThrow("0.5%");
  });
  it("preserves the verified native linked-trigger cancellation through journal and exact-body dispatch", async () => {
    const { app, input, state, sender } = await managementEnvironment();
    state.orders = [
      {
        id: 286025587687424,
        market: state.markets[0],
        type: 3,
        status: 8,
        size: 10n,
        filled: 0n,
        flags: 4,
        leverage: 0,
        triggerCondition: 3,
        triggerPrice: 254080n,
        linkedPosition: 99,
      },
    ];
    input.action = { kind: "cancel", orderId: state.orders[0].id };
    const op = await app.management.prepare(input);
    expect(op.payload).toEqual({
      rq: 19,
      acc: 1057,
      mkt: 32,
      t: 5,
      oid: 286025587687424,
      s: 0,
      fl: 4,
      lv: 0,
      tp: 254080,
      tpc: 3,
      lp: 99,
      lb: 0,
    });
    expect(app.read()!.management![0].payload).toEqual(op.payload);
    await app.management.dispatch(op.id, async () => input);
    expect(sender).toHaveBeenCalledWith(JSON.stringify({ d: [op.payload] }));
    delete state.orders[0].leverage;
    expect(() => managementPayload(owner, input, Date.now())).toThrow(
      "incomplete",
    );
  });
  it("keeps a lost protective request durable while allowing a separately reviewed reduce-only recovery close", async () => {
    const sender = vi.fn(async (): Promise<unknown> => {
      throw Error("lost response");
    });
    const { app, input, h, state } = await managementEnvironment(sender);
    const protection = await app.management.prepare(input);
    expect(
      (await app.management.dispatch(protection.id, async () => input)).phase,
    ).toBe("unknown");
    const restored = createOrderApplication(owner, { ...h.options, sender });
    await expect(
      restored.management.dispatch(protection.id, async () => input),
    ).rejects.toThrow("Do not resend");
    await expect(restored.management.discard(protection.id)).rejects.toThrow(
      "unsent",
    );
    const closeInput: ManagementAdmission = {
      ...input,
      action: { kind: "close", positionId: 99, price: 240000 },
    };
    const close = await restored.management.prepare(closeInput);
    expect(close.payload).toMatchObject({
      t: 3,
      s: 10,
      p: 240000,
      fl: 4,
      lv: 0,
      lb: 120,
    });
    expect(close.payload.rq).toBe(protection.payload.rq + 1);
    state.positions[0].size = 5n; // Protective fill before manual dispatch requires renewed review.
    await expect(
      restored.management.dispatch(close.id, async () => closeInput),
    ).rejects.toThrow("changed");
    expect(sender).toHaveBeenCalledTimes(1);
    await restored.management.discard(close.id);
    const remainder = await restored.management.prepare(closeInput);
    expect(remainder.payload.s).toBe(5);
    await restored.management.dispatch(remainder.id, async () => closeInput);
    await expect(restored.management.prepare(closeInput)).rejects.toThrow(
      "previous management",
    );
    expect(() => assertNoUnresolvedOrders(h.storage, owner)).toThrow("Resolve");
  });
  it("reconciles a close only with matching history and settlement, retaining exposure and ledger recovery barriers", async () => {
    const { app, input, state, h } = await managementEnvironment();
    input.action = { kind: "close", positionId: 99, price: 240000 };
    const close = await app.management.prepare(input);
    await app.management.dispatch(close.id, async () => input);
    state.lastRequestId = close.payload.rq;
    state.positions = [];
    const hash = `0x${"cd".repeat(32)}` as const;
    const row = {
      block: 100,
      hash,
      log: 1,
      account: 1057,
      market: 32,
      order: 902,
      request: close.payload.rq,
      type: 3,
      status: 4,
      reason: 0,
      size: 10,
      filled: 10,
      price: 240000,
      fee: "8",
    };
    const history: OrderHistory = {
      orders: [],
      fills: [],
      accounts: [],
      complete: true,
    };
    const settlement = vi.fn(async () => ({
      hash,
      block: 100,
      filled: 10,
      fee: "8",
    }));
    const readers = {
      state: async () => state,
      history: async () => history,
      settlement,
    };
    expect((await app.management.reconcile(close.id, readers)).phase).toBe(
      "forwarded",
    );
    expect(settlement).not.toHaveBeenCalled();
    history.orders = [row];
    history.fills = [row];
    expect((await app.management.reconcile(close.id, readers)).phase).toBe(
      "settled",
    );
    expect(() => assertNoUnresolvedOrders(h.storage, owner)).toThrow(
      "exposure",
    );
    expect(app.read()?.operations[0].phase).toBe("partial-fill"); // Closing this attempt does not settle siblings or the account ledger.
  });
  it("blocks management on expired authority, failed persistence, substituted payloads or unreviewed bracket changes", async () => {
    for (const change of [
      "session",
      "persistence",
      "payload",
      "position",
    ] as const) {
      const { app, input, h, sender } = await managementEnvironment();
      const op = await app.management.prepare(input);
      if (change === "session") input.sessionId = crypto.randomUUID();
      if (change === "persistence") h.rejectSave();
      if (change === "position") input.state.positions[0].id++;
      if (change === "payload") {
        const journal = app.read()!;
        journal.management![0].payload.s = 9;
        h.storage.setItem(orderJournalKey(owner), JSON.stringify(journal));
      }
      await expect(
        app.management.dispatch(op.id, async () => input),
      ).rejects.toThrow();
      expect(sender).not.toHaveBeenCalled();
    }
    const { app, input } = await managementEnvironment();
    input.action = {
      kind: "stop-loss",
      positionId: 99,
      trigger: 230000,
      price: 229000,
    };
    const replacement = await app.management.prepare(input);
    expect(replacement.payload).toMatchObject({
      t: 3,
      tp: 230000,
      p: 229000,
      s: 10,
    });
    input.action.trigger = 229000;
    await expect(
      app.management.dispatch(replacement.id, async () => input),
    ).rejects.toThrow("changed");
  });
  it("bounds partial reductions to exact residual lots and invalidates a review on a late trigger fill", async () => {
    const { app, input, state, sender } = await managementEnvironment();
    for (const size of [0, 10, 11, 1.5]) {
      input.action = {
        kind: "partial-close",
        positionId: 99,
        price: 240000,
        size,
      };
      await expect(app.management.prepare(input)).rejects.toThrow();
    }
    input.action = {
      kind: "partial-close",
      positionId: 99,
      price: 240000,
      size: 9,
    };
    const partial = await app.management.prepare(input);
    expect(partial.payload).toMatchObject({ t: 3, s: 9, fl: 4 });
    state.positions[0].size = 1n; // A protective fill arrived before dispatch.
    await expect(
      app.management.dispatch(partial.id, async () => input),
    ).rejects.toThrow();
    expect(sender).not.toHaveBeenCalled();
    await app.management.discard(partial.id);
    input.action = { kind: "close", positionId: 99, price: 240000 };
    expect((await app.management.prepare(input)).payload.s).toBe(1); // No dust is rounded away.
  });
  it("uses BTC's independent units, fee tier and margin", async () => {
    const btc = fixture("long", "BTC");
    btc.account.feeTier = 1;
    const review = assessTradeReview(owner, btc.sizing, btc.account);
    expect(review.blockers).toEqual([]);
    expect(review.feePpm).toBe(420n);
    expect(review.sizing.size.lots).toBe(34n);
    const h = environment();
    h.input.review = review;
    const app = createOrderApplication(owner, h.options);
    const entry = await app.prepare(h.input);
    expect(entry.payload).toMatchObject({ mkt: 16, t: 1, s: 34, p: 650650 });
    await app.discard(entry.id);
    btc.account.markets[0].open = false;
    await expect(app.prepare(h.input)).rejects.toThrow("closed to new entries");
    btc.account.markets[0].open = true;
  });
  it("encodes a short entry as t: 2 with its bracket around the entry and a funding allowance computed at the stop", async () => {
    for (const market of ["ETH", "BTC"] as const) {
      const f = fixture("short", market);
      const review = assessTradeReview(owner, f.sizing, f.account);
      expect(review.blockers).toEqual([]);
      const { size, intent } = review.sizing;
      const metadata = review.sizing.observation.metadata;
      // Short allowance notional is quantity * max(stop, limit), rounded up.
      const atStop = (size.quantity * intent.stop + U - 1n) / U;
      expect(review.entryNotionalCeiling).toBe(atStop);
      expect(atStop).toBeGreaterThan((size.quantity * size.limit) / U);
      const h = environment();
      h.input.review = review;
      const app = createOrderApplication(owner, h.options);
      const op = await app.prepare(h.input);
      expect(op.payload).toMatchObject({
        acc: 1057,
        mkt: metadata.marketId,
        t: 2,
        p: Number(size.limit / metadata.tick),
        s: Number(size.lots),
        lv: 300,
        fl: 4,
        mnp: 50,
      });
      // The stop sits above and the target below the entry.
      const entry = Number(size.entry / metadata.tick);
      expect(op.bracket!.target).toBeLessThan(entry);
      expect(op.bracket!.stop).toBeGreaterThan(entry);
      expect(op.bracket).toEqual({
        target: Number(intent.target / metadata.tick),
        stop: Number(intent.stop / metadata.tick),
      });
    }
  });
  it("preserves concurrent market records, admits only proven other-market exposure, and serializes shared funds", async () => {
    const { h, app, state } = await managementEnvironment();
    const btc = fixture("long", "BTC");
    state.markets.push(btc.observation.metadata);
    btc.account = state;
    const btcInput = {
      ...h.input,
      review: assessTradeReview(owner, btc.sizing, state),
    };
    // Legacy filled records lack a canonical opening identity: do not guess one from positions.
    await expect(app.prepare(btcInput)).rejects.toThrow("Resolve");
    const journal = app.read()!;
    journal.operations[0].positionId = 99;
    h.storage.setItem(orderJournalKey(owner), JSON.stringify(journal));
    const [first, second] = await Promise.allSettled([
      app.prepare(btcInput),
      app.prepare(btcInput),
    ]);
    expect(
      [first, second].filter((r) => r.status === "fulfilled"),
    ).toHaveLength(1);
    const saved = createOrderApplication(owner, h.options).read()!;
    expect(saved.operations.map((o) => [o.payload.mkt, o.phase])).toEqual([
      [32, "partial-fill"],
      [16, "prepared"],
    ]);
    expect(saved.operations[1].payload.rq).toBe(19);
    expect(saved.operations[0].positionId).toBe(99);
    expect(() => assertNoUnresolvedOrders(h.storage, owner)).toThrow(
      "exposure",
    );
    await app.discard(saved.operations[1].id);
    // Finalized spendable collateral is shared: a later depleted account invalidates affordability.
    state.free = 1n;
    await expect(app.prepare(btcInput)).rejects.toThrow("collateral");
    state.free = 98n * U;
    saved.operations[0].positionId = undefined;
    saved.operations[0].phase = "unknown";
    saved.operations[0].filled = 0;
    saved.operations[0].protection = "not-applicable";
    saved.operations[0].history = "unresolved";
    saved.operations[0].settlement = null;
    h.storage.setItem(orderJournalKey(owner), JSON.stringify(saved));
    await expect(app.prepare(btcInput)).rejects.toThrow("Resolve");
  });
  it("reviews independent ETH/BTC long/short protection with correct close side, buffer and immediate acknowledgment", async () => {
    for (const marketId of [32, 16] as const)
      for (const side of ["Long", "Short"] as const) {
        const { app, input, state, h } = await managementEnvironment();
        if (marketId === 16 && side === "Short")
          h.values.delete(orderJournalKey(owner)); // External actual exposure has no invented app entry.
        const market =
          marketId === 16
            ? fixture("long", "BTC").observation.metadata
            : state.markets[0];
        state.markets = [market];
        const price = marketId === 16 ? 650000n : 250000n;
        Object.assign(state.positions[0], { market, side, entryPrice: price });
        Object.assign(input.risk!, {
          marketId,
          side,
          entryPrice: price,
          mark: price,
          maintenanceFactor: BigInt(market.maintenanceMarginFactor),
          dynamicLeverage: BigInt(market.initialMarginFactor),
        });
        const trigger = Number(
          side === "Long" ? (price * 96n) / 100n : (price * 104n) / 100n,
        );
        const child =
          side === "Long"
            ? Math.ceil((trigger * 995) / 1000)
            : Math.floor((trigger * 1005) / 1000);
        input.action = {
          kind: "stop-loss",
          marketId,
          positionId: 99,
          trigger,
          price: child,
        };
        const stop = await app.management.prepare(input);
        expect(stop.payload).toMatchObject({
          mkt: marketId,
          t: side === "Long" ? 3 : 4,
          tpc: side === "Long" ? 4 : 3,
          p: child,
          s: 10,
        });
        await app.management.discard(stop.id);
        const originalExit = {
          id: 901,
          market,
          type: side === "Long" ? 3 : 4,
          status: 8,
          size: 10n,
          filled: 0n,
          flags: 4,
          leverage: 0,
          triggerPrice: BigInt(trigger),
          price: BigInt(child),
          triggerCondition: side === "Long" ? 4 : 3,
          linkedPosition: 99,
        };
        state.orders = [originalExit];
        input.action = {
          kind: "amend-stop-loss",
          marketId,
          positionId: 99,
          orderId: 901,
          trigger,
          price: child,
        };
        const amended = await app.management.prepare(input);
        expect(amended.payload).toMatchObject({
          t: 7,
          oid: 901,
          tpc: side === "Long" ? 4 : 3,
        });
        expect(
          positionProtection(state, state.positions[0]).stopLoss.state,
        ).toBe("waiting");
        await app.management.discard(amended.id);
        state.orders = [];
        input.action = {
          kind: "stop-loss",
          marketId,
          positionId: 99,
          trigger,
          price: child,
        };
        const originalCollateral = state.positions[0].collateral;
        state.positions[0].collateral = input.risk!.collateral = 0n;
        await expect(app.management.prepare(input)).rejects.toThrow(
          "1% mark-price buffer",
        );
        state.positions[0].collateral = input.risk!.collateral =
          originalCollateral;
        // Profitable live stops may be on either side of entry, with explicit immediate review.
        input.action.trigger = Number(
          side === "Long" ? (price * 101n) / 100n : (price * 99n) / 100n,
        );
        input.action.price =
          side === "Long"
            ? Math.ceil(input.action.trigger * 0.995)
            : Math.floor(input.action.trigger * 1.005);
        input.acknowledgeImmediate = false;
        await expect(app.management.prepare(input)).rejects.toThrow(
          "May trigger immediately",
        );
        input.acknowledgeImmediate = true;
        const immediate = await app.management.prepare(input);
        input.risk!.mark++;
        await expect(
          app.management.dispatch(immediate.id, async () => input),
        ).rejects.toThrow("changed");
        await app.management.discard(immediate.id);
        input.risk = undefined;
        input.action = {
          kind: "close",
          marketId,
          positionId: 99,
          price: Number(price),
        };
        expect((await app.management.prepare(input)).payload.t).toBe(
          side === "Long" ? 3 : 4,
        );
        if (marketId === 16 && side === "Short")
          expect(
            createOrderApplication(owner, h.options).read()!.operations,
          ).toEqual([]);
        expect(() =>
          validateManagementPayload({
            ...stop.payload,
            p: side === "Long" ? trigger + 1 : trigger - 1,
          }),
        ).toThrow();
      }
  });
  it("reads actual accrued funding, valid mark and quantity-specific margin at one finalized testnet block", async () => {
    const { state } = await managementEnvironment();
    let valid = true;
    let riskMarket = 32n;
    let riskShort = false;
    const calls: string[] = [];
    function result(data: Hex, to: string): Hex {
      if (to.toLowerCase() === "0xca11bde05977b3631167028862be2a173976ca11") {
        const decoded = decodeFunctionData({ abi: multicall3Abi, data });
        if (decoded.functionName !== "aggregate3")
          throw Error("Unexpected aggregate");
        return encodeFunctionResult({
          abi: multicall3Abi,
          functionName: "aggregate3",
          result: decoded.args[0].map((call) => ({
            success: true,
            returnData: result(call.callData, call.target),
          })),
        });
      }
      expect(to.toLowerCase()).toBe(testnet.exchange.toLowerCase());
      const decoded = decodeFunctionData({
        abi: [...positionRiskAbi, ...sizingAbi],
        data,
      });
      if (decoded.functionName === "getPositionV2") {
        expect(decoded.args).toEqual([riskMarket, BigInt(state.accountId)]);
        return encodeFunctionResult({
          abi: positionRiskAbi,
          functionName: "getPositionV2",
          result: [
            {
              accountId: BigInt(state.accountId),
              nextNodeId: 0n,
              prevNodeId: 0n,
              positionType: riskShort ? 1 : 0,
              depositCNS: 10n * U,
              pricePNS: 250000n,
              lotLNS: 10n,
              entryBlock: 90n,
              pnlCNS: -500000n,
              deltaPnlCNS: 0n,
              premiumPnlCNS: -500000n,
              priceResiduePNSQ16: 32000n,
            },
            250000n,
            valid,
          ],
        });
      }
      expect(decoded.functionName).toBe("getMarginFractions");
      expect(decoded.args).toEqual([riskMarket, 10n]);
      return encodeFunctionResult({
        abi: sizingAbi,
        functionName: "getMarginFractions",
        result: [1200n, 2000n, 1200n, 1000000n, 9000n, 9500n],
      });
    }
    const transport = custom(
      {
        request: async ({ method, params }) => {
          if (method === "eth_chainId") return "0x279f";
          if (method === "eth_getBlockByNumber") {
            expect(params).toEqual(["finalized", false]);
            return {
              number: "0x64",
              hash: `0x${"ab".repeat(32)}`,
              timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
              transactions: [],
            };
          }
          if (method !== "eth_call") throw Error(`Unexpected ${method}`);
          const [call, block] = params as [{ to: string; data: Hex }, string];
          calls.push(block);
          return result(call.data, call.to);
        },
      },
      { retryCount: 0 },
    );
    const risk = await readPositionRisk(state, 99, { transport });
    expect(risk).toMatchObject({
      premiumPnl: -500000n,
      size: 10n,
      mark: 250000n,
      entryResidueQ16: 32000,
      block: 100n,
    });
    expect(calls.every((block) => block === "0x64")).toBe(true);
    riskMarket = 16n;
    riskShort = true;
    state.positions[0].side = "Short";
    state.positions[0].market = {
      ...state.positions[0].market,
      symbol: "BTC",
      marketId: 16,
    };
    expect(await readPositionRisk(state, 99, { transport }, 16)).toMatchObject({
      marketId: 16,
      side: "Short",
      size: 10n,
    });
    valid = false;
    await expect(
      readPositionRisk(state, 99, { transport }, 16),
    ).rejects.toThrow("mark or position risk");
  });
  it("reviews actual-position protection risk while leaving full close reachable", async () => {
    const { app, input, state } = await managementEnvironment();
    input.action = { kind: "stop-loss", positionId: 99, trigger: 1, price: 1 };
    await expect(app.management.prepare(input)).rejects.toThrow(
      "1% mark-price buffer",
    );
    // This live stop locks in profit; entry-side restrictions must not reject it.
    input.risk!.mark = 270000n;
    input.action = {
      kind: "stop-loss",
      positionId: 99,
      trigger: 260000,
      price: 258700,
    };
    const profitable = await app.management.prepare(input);
    expect(profitable.payload.tp).toBe(260000);
    await app.management.discard(profitable.id);
    for (const bad of [
      undefined,
      { ...input.risk!, blockTime: Date.now() - 30001 },
      { ...input.risk!, collateral: 9n * U },
      { ...input.risk!, premiumPnl: -20n * U },
    ]) {
      input.risk = bad;
      await expect(app.management.prepare(input)).rejects.toThrow();
      input.action = { kind: "close", positionId: 99, price: 240000 };
      const close = await app.management.prepare(input);
      expect(close.payload.s).toBe(Number(state.positions[0].size));
      await app.management.discard(close.id);
      input.action = {
        kind: "stop-loss",
        positionId: 99,
        trigger: 260000,
        price: 258700,
      };
    }
  });
  it("binds immediate-trigger acknowledgment to the exact mark, funding, position and reviewed command", async () => {
    for (const kind of [
      "take-profit",
      "stop-loss",
      "amend-take-profit",
      "amend-stop-loss",
    ] as const) {
      const { app, input, state, sender } = await managementEnvironment();
      const stop = kind.includes("stop-loss");
      const trigger = stop ? 260000 : 240000;
      if (kind.startsWith("amend"))
        state.orders = [
          {
            id: 901,
            market: state.markets[0],
            type: 3,
            status: 8,
            size: 10n,
            filled: 0n,
            price: stop ? 238800n : 298500n,
            triggerPrice: stop ? 240000n : 300000n,
            flags: 4,
            leverage: 0,
            triggerCondition: stop ? 4 : 3,
            linkedPosition: 99,
          },
        ];
      input.action = {
        kind,
        positionId: 99,
        orderId: 901,
        trigger,
        price: (trigger * 995) / 1000,
      };
      await expect(app.management.prepare(input)).rejects.toThrow(
        "May trigger immediately",
      );
      input.acknowledgeImmediate = true;
      const op = await app.management.prepare(input);
      // Exact acknowledgment cannot survive a refreshed mark, even if still immediate.
      input.risk!.mark++;
      await expect(
        app.management.dispatch(op.id, async () => input),
      ).rejects.toThrow("changed");
      input.risk!.mark--;
      input.risk!.premiumPnl--;
      await expect(
        app.management.dispatch(op.id, async () => input),
      ).rejects.toThrow("changed");
      input.risk!.premiumPnl++;
      input.acknowledgeImmediate = false;
      await expect(
        app.management.dispatch(op.id, async () => input),
      ).rejects.toThrow("May trigger immediately");
      input.acknowledgeImmediate = true;
      input.risk!.blockTime = Date.now() - 30001;
      await expect(
        app.management.dispatch(op.id, async () => input),
      ).rejects.toThrow("stale");
      input.risk!.blockTime = Date.now();
      state.positions[0].collateral--;
      await expect(
        app.management.dispatch(op.id, async () => input),
      ).rejects.toThrow("changed");
      expect(sender).not.toHaveBeenCalled();
    }
  });
  it("blocks older prepared protection after a higher ambiguous close under the wallet lock", async () => {
    const sender = vi.fn(async (): Promise<unknown> => {
      throw Error("lost close ACK");
    });
    const { app, input } = await managementEnvironment(sender);
    const protection = await app.management.prepare(input);
    const closeInput = {
      ...input,
      action: { kind: "close" as const, positionId: 99, price: 249000 },
    };
    const close = await app.management.prepare(closeInput);
    await app.management.dispatch(close.id, async () => closeInput);
    await expect(
      app.management.dispatch(protection.id, async () => input),
    ).rejects.toThrow("previous management");
    expect(sender).toHaveBeenCalledTimes(1);
    expect(app.read()!.management![0].phase).toBe("prepared");
    await app.management.discard(protection.id);
    expect(app.read()!.management![1].phase).toBe("unknown");
  });
  it("retains vanished observed protection until positive terminal proof while keeping full-close recovery reachable", async () => {
    const { app, input, state, h } = await managementEnvironment();
    const protection = await app.management.prepare(input);
    await app.management.dispatch(protection.id, async () => input);
    state.lastRequestId = protection.payload.rq;
    state.orders = [
      {
        id: 901,
        request: protection.payload.rq,
        market: state.markets[0],
        type: 3,
        status: 8,
        size: 10n,
        filled: 0n,
        price: 298500n,
        triggerPrice: 300000n,
        triggerCondition: 3,
        flags: 4,
        leverage: 0,
        linkedPosition: 99,
      },
    ];
    const history: OrderHistory = {
      complete: true,
      orders: [],
      fills: [],
      accounts: [],
      positions: [],
    };
    const readers = { state: async () => state, history: async () => history };
    await app.management.reconcile(protection.id, readers);
    const journal = app.read()!;
    journal.operations[0].positionId = 99;
    h.storage.setItem(orderJournalKey(owner), JSON.stringify(journal));
    const btc = fixture("long", "BTC");
    state.markets.push(btc.observation.metadata);
    const btcInput = {
      ...h.input,
      review: assessTradeReview(owner, btc.sizing, state),
    };
    const independent = await app.prepare(btcInput);
    await app.discard(independent.id);
    state.orders = [];
    await expect(app.prepare(btcInput)).rejects.toThrow("management mutation");
    await expect(app.management.prepare(input)).rejects.toThrow(
      "previous management",
    );
    expect(app.read()!.management![0].phase).toBe("unknown");
    const closeInput = {
      ...input,
      risk: undefined,
      action: { kind: "close" as const, positionId: 99, price: 249000 },
    };
    const close = await app.management.prepare(closeInput);
    await app.management.discard(close.id);
    history.orders = [
      {
        account: 1057,
        market: 32,
        request: protection.payload.rq,
        order: 901,
        type: 3,
        status: 5,
        reason: 28,
        size: 10,
        filled: 0,
        price: 298500,
        fee: "0",
        block: 100,
        linkedPosition: 99,
        triggerPrice: 300000,
        triggerCondition: 3,
      },
    ];
    history.complete = false;
    expect((await app.management.reconcile(protection.id, readers)).phase).toBe(
      "unknown",
    );
    history.complete = true;
    expect((await app.management.reconcile(protection.id, readers)).phase).toBe(
      "cancelled",
    );
    const recoveredBtc = await app.prepare(btcInput);
    expect(recoveredBtc.payload.mkt).toBe(16);
    await app.discard(recoveredBtc.id);
    expect((await app.management.prepare(input)).phase).toBe("prepared");
  });
  it("releases only unique proved zero-execution native failures and requires a separate reviewed recovery command", async () => {
    for (const fault of [
      "none",
      "duplicate",
      "prior-waiting",
      "partial",
      "fee",
      "sr32",
      "no-receipt",
      "wrong-hash",
      "late-block",
      "fill",
      "position",
    ] as const) {
      const { app, input, state } = await managementEnvironment(
        vi.fn(async () => {
          throw Error("lost ACK");
        }),
      );
      input.action = { kind: "close", positionId: 99, price: 249000 };
      const close = await app.management.prepare(input);
      await app.management.dispatch(close.id, async () => input);
      state.lastRequestId = close.payload.rq;
      const hash = `0x${"cd".repeat(32)}` as const;
      const row = {
        account: 1057,
        market: 32,
        request: close.payload.rq,
        order: 910,
        type: 3,
        status: 7,
        reason: 11,
        size: 10,
        filled: 0,
        price: 249000,
        fee: "0",
        block: 100,
        hash,
      };
      const history: OrderHistory = {
        complete: true,
        orders: [row],
        fills: [],
        accounts: [],
        positions: [],
      };
      if (fault === "duplicate") history.orders.push({ ...row });
      if (fault === "prior-waiting")
        history.orders.unshift({ ...row, status: 8, block: 99 });
      if (fault === "partial") row.filled = 1;
      if (fault === "fee") row.fee = "1";
      if (fault === "sr32") row.reason = 32;
      if (fault === "late-block") row.block = 101;
      if (fault === "fill") history.fills.push({ ...row, filled: 1 });
      if (fault === "position") history.positions!.push({ ...row });
      const settlement = vi.fn(async () =>
        fault === "no-receipt"
          ? null
          : {
              rejected: "position-mismatch" as const,
              filled: 0,
              fee: "0",
              block: 100,
              hash:
                fault === "wrong-hash"
                  ? (`0x${"ef".repeat(32)}` as const)
                  : hash,
            },
      );
      const resolved = await app.management.reconcile(close.id, {
        state: async () => state,
        history: async () => history,
        settlement,
      });
      expect(resolved.phase).toBe(fault === "none" ? "rejected" : "unknown");
      expect(app.read()!.operations[0].filled).toBe(10);
      if (fault === "none")
        expect((await app.management.prepare(input)).payload.rq).toBe(
          close.payload.rq + 1,
        );
      else
        await expect(app.management.prepare(input)).rejects.toThrow(
          "previous management",
        );
    }
    const h = environment();
    const app = createOrderApplication(owner, {
      ...h.options,
      sender: async () => {
        throw Error("lost entry ACK");
      },
    });
    const entry = await app.prepare(h.input);
    await app.dispatch(entry.id, async () => h.input);
    const state = h.input.review.account;
    state.lastRequestId = entry.payload.rq;
    state.sources[0].block = 121;
    const hash = `0x${"ef".repeat(32)}` as const;
    const history: OrderHistory = {
      complete: true,
      orders: [
        {
          account: 1057,
          market: 32,
          request: entry.payload.rq,
          order: 910,
          type: 1,
          status: 7,
          reason: 14,
          size: entry.payload.s,
          filled: 0,
          price: entry.payload.p,
          fee: "0",
          block: 121,
          hash,
        },
      ],
      fills: [],
      accounts: [],
      positions: [],
    };
    expect(
      (
        await app.reconcile(entry.id, {
          state: async () => state,
          history: async () => history,
          settlement: async () => ({
            rejected: "expired",
            filled: 0,
            fee: "0",
            block: 121,
            hash,
          }),
        })
      ).phase,
    ).toBe("rejected");
    expect((await app.prepare(h.input)).payload.rq).toBe(entry.payload.rq + 1);
  });
  it("preserves observed protection on failed/unknown amendment and requires terminal cancellation before replacement", async () => {
    const sender = vi.fn(async (): Promise<unknown> => ({
      mt: 31,
      status: { code: 0 },
      statuses: [{ code: 0 }],
    }));
    sender.mockRejectedValueOnce(Error("lost amend response"));
    let { app, input, state } = await managementEnvironment(sender);
    state.orders = [
      {
        id: 901,
        request: 18,
        market: state.markets[0],
        type: 3,
        status: 8,
        size: 10n,
        filled: 0n,
        price: 298500n,
        flags: 4,
        leverage: 0,
        triggerCondition: 3,
        triggerPrice: 300000n,
        linkedPosition: 99,
      },
    ];
    const original = structuredClone(state.orders[0]);
    input.action = {
      kind: "amend-take-profit",
      positionId: 99,
      orderId: 901,
      trigger: 310000,
      price: 308450,
    };
    const amend = await app.management.prepare(input);
    expect(amend.payload).toMatchObject({
      t: 7,
      oid: 901,
      lp: 99,
      tp: 310000,
      tpc: 3,
      s: 10,
      fl: 4,
      lv: 0,
      lb: 0,
    });
    expect(amend.payload.mnp).toBeUndefined();
    expect(
      (await app.management.dispatch(amend.id, async () => input)).phase,
    ).toBe("unknown");
    state.lastRequestId = amend.payload.rq;
    const history: OrderHistory = {
      orders: [],
      fills: [],
      accounts: [],
      complete: true,
    };
    const readers = { state: async () => state, history: async () => history };
    expect((await app.management.reconcile(amend.id, readers)).phase).toBe(
      "unknown",
    );
    expect(state.orders[0]).toEqual(original);
    await expect(app.management.prepare(input)).rejects.toThrow("previous");
    history.orders = [
      {
        block: 100,
        account: 1057,
        market: 32,
        request: amend.payload.rq,
        order: 901,
        type: 7,
        status: 7,
        reason: 4,
        size: 10,
        filled: 0,
        price: 308450,
        fee: "0",
      },
    ];
    // A status 7 order row for the amendment's request, with the order untouched, proves it never applied.
    expect((await app.management.reconcile(amend.id, readers)).phase).toBe(
      "rejected",
    );
    expect(positionProtection(state, state.positions[0]).takeProfit.state).toBe(
      "waiting",
    );
    expect(state.orders[0].triggerPrice).toBe(300000n);
    ({ app, input, state } = await managementEnvironment(sender));
    state.orders = [structuredClone(original)];
    input.action = {
      kind: "amend-take-profit",
      positionId: 99,
      orderId: 901,
      trigger: 310000,
      price: 308450,
    };
    history.orders = [];
    const currentReaders = {
      state: async () => state,
      history: async () => history,
    };
    const next = await app.management.prepare(input);
    await app.management.dispatch(next.id, async () => input);
    state.lastRequestId = next.payload.rq;
    state.orders[0] = {
      ...original,
      request: next.payload.rq,
      triggerPrice: 310000n,
      price: 308450n,
    };
    expect(
      (await app.management.reconcile(next.id, currentReaders)).phase,
    ).toBe("observed");
    input.action = { kind: "cancel", orderId: 901 };
    const cancel = await app.management.prepare(input);
    expect(cancel.payload.tp).toBe(310000);
    await app.management.dispatch(cancel.id, async () => input);
    state.lastRequestId = cancel.payload.rq;
    state.orders = [];
    input.action = {
      kind: "take-profit",
      positionId: 99,
      trigger: 320000,
      price: 318400,
    };
    await expect(app.management.prepare(input)).rejects.toThrow("previous");
    expect(
      (await app.management.reconcile(cancel.id, currentReaders)).phase,
    ).toBe("forwarded");
    history.orders.push({
      block: 100,
      account: 1057,
      market: 32,
      request: cancel.payload.rq,
      order: 901,
      type: 3,
      status: 5,
      reason: 28,
      size: 10,
      filled: 0,
      price: 308450,
      fee: "0",
      linkedPosition: 99,
      triggerPrice: 310000,
      triggerCondition: 3,
    });
    expect(
      (await app.management.reconcile(cancel.id, currentReaders)).phase,
    ).toBe("observed");
    expect(positionProtection(state, state.positions[0]).takeProfit.state).toBe(
      "missing",
    );
    const replacement = await app.management.prepare(input);
    expect(replacement.payload).toMatchObject({ t: 3, tp: 320000, s: 10 });
    expect(positionProtection(state, state.positions[0]).takeProfit.state).toBe(
      "missing",
    );
  });
  // The entry's position 99 opened at block 100; later events come from Perpl's own position history.
  async function endedPosition() {
    const env = await managementEnvironment();
    const entry = env.app.read()!.operations[0];
    const open = {
      block: 100,
      hash: entry.settlement!.hash as Hex,
      log: 1,
      account: 1057,
      market: 32,
      order: 900,
      request: entry.payload.rq,
      type: 1,
      status: 1,
      reason: 21,
      size: 10,
      filled: 10,
      price: entry.payload.p,
      fee: "9",
      positionId: 99,
      side: 1,
    };
    const hash = (n: string) => `0x${n.repeat(32)}` as Hex;
    const event = (
      block: number,
      status: number,
      reason: number,
      pnl: string,
      funding: string,
      closeFee: string,
    ) => ({
      ...open,
      block,
      hash: hash(block === 101 ? "bc" : "cd"),
      order: block === 101 ? 903 : 902,
      type: 3,
      status,
      reason,
      pnl,
      funding,
      closeFee,
    });
    const history: OrderHistory = {
      orders: [{ ...open, status: 5, reason: 16 }],
      fills: [{ ...open, status: 5, reason: 16 }],
      accounts: [],
      positions: [open],
      complete: true,
    };
    env.state.positions = [];
    env.state.orders = [];
    env.state.sources[0].block = 102;
    const journal = env.app.read()!;
    journal.operations[0].positionId = 99;
    return {
      ...env,
      entry: journal.operations[0],
      journal,
      history,
      event,
      open,
    };
  }
  it("completes a manual full close with summed amounts and retires the stop and target", async () => {
    const { app, input, state, history, event } = await endedPosition();
    // Position and orders exist while the stop and target are recorded as observed.
    const live = structuredClone(state);
    live.positions = [
      {
        id: 99,
        market: state.markets[0],
        side: "Long",
        size: 10n,
        entryPrice: 250000n,
        entryResidueQ16: 0,
        collateral: 10n * U,
        fees: 9n,
      },
    ];
    live.orders = [];
    input.state = live;
    const readers = { state: async () => live, history: async () => history };
    const exit = async (
      action: ManagementAdmission["action"],
      id: number,
      condition: number,
      trigger: number,
      price: number,
    ) => {
      input.action = action;
      const op = await app.management.prepare(input);
      await app.management.dispatch(op.id, async () => input);
      live.lastRequestId = op.payload.rq;
      live.orders.push({
        id,
        request: op.payload.rq,
        market: state.markets[0],
        type: 3,
        status: 8,
        size: 10n,
        filled: 0n,
        price: BigInt(price),
        flags: 4,
        leverage: 0,
        triggerCondition: condition,
        triggerPrice: BigInt(trigger),
        linkedPosition: 99,
      });
      expect((await app.management.reconcile(op.id, readers)).phase).toBe(
        "observed",
      );
      return op;
    };
    const tp = await exit(
      { kind: "take-profit", positionId: 99, trigger: 300000, price: 298500 },
      901,
      3,
      300000,
      298500,
    );
    const sl = await exit(
      { kind: "stop-loss", positionId: 99, trigger: 240000, price: 238800 },
      902,
      4,
      240000,
      238800,
    );
    input.action = { kind: "close", positionId: 99, price: 240000 };
    const close = await app.management.prepare(input);
    await app.management.dispatch(close.id, async () => input);
    // The close fills, which cancels the linked exits and removes the position.
    state.lastRequestId = close.payload.rq;
    history.positions!.push({
      ...event(102, 2, 13, "1000", "-5", "8"),
      request: close.payload.rq,
    });
    const entry = app.read()!.operations[0];
    const done = await app.reconcile(entry.id, {
      state: async () => state,
      history: async () => history,
    });
    expect(done.completion).toEqual({
      positionId: 99,
      hash: `0x${"cd".repeat(32)}`,
      block: 102,
      orderId: 902,
      balance: state.balance.toString(),
      locked: state.locked.toString(),
      pnl: "1000",
      funding: "-5",
      fees: "17",
    });
    const phases = new Map(app.read()!.management!.map((o) => [o.id, o.phase]));
    expect(phases.get(tp.id)).toBe("cancelled");
    expect(phases.get(sl.id)).toBe("cancelled");
    // Seen live: history showed the end before indexing the close's order row, and the
    // sent close was relabeled "discarded" (never sent). It stays for its own reconcile,
    // which settles it from the position event and its finalized receipt.
    expect(phases.get(close.id)).toBe("forwarded");
    const settled = await app.management.reconcile(close.id, {
      state: async () => state,
      history: async () => history,
      settlement: async (_, hash) => ({
        filled: 10,
        fee: "8",
        block: 102,
        hash,
        closed: { pnl: "1000", funding: "-5" },
      }),
    });
    expect(settled).toMatchObject({
      phase: "settled",
      filled: 10,
      settlement: { hash: `0x${"cd".repeat(32)}`, block: 102, orderId: 902 },
    });
  });
  it("admits the next entry once a full close is processed, before history ends the position", async () => {
    // Seen live: right after a close, the next entry was refused because its stop and
    // target, gone with the position, were flipped to "unknown" while history lagged.
    const { app, input, state } = await endedPosition();
    const live = structuredClone(state);
    live.positions = [
      {
        id: 99,
        market: state.markets[0],
        side: "Long",
        size: 10n,
        entryPrice: 250000n,
        entryResidueQ16: 0,
        collateral: 10n * U,
        fees: 9n,
      },
    ];
    input.state = live;
    for (const [kind, id, condition, trigger, price] of [
      ["take-profit", 901, 3, 300000, 298500],
      ["stop-loss", 902, 4, 240000, 238800],
    ] as const) {
      input.action = { kind, positionId: 99, trigger, price };
      const op = await app.management.prepare(input);
      await app.management.dispatch(op.id, async () => input);
      live.lastRequestId = op.payload.rq;
      live.orders.push({
        id,
        request: op.payload.rq,
        market: state.markets[0],
        type: 3,
        status: 8,
        size: 10n,
        filled: 0n,
        price: BigInt(price),
        flags: 4,
        leverage: 0,
        triggerCondition: condition,
        triggerPrice: BigInt(trigger),
        linkedPosition: 99,
      });
      await app.management.reconcile(op.id, {
        state: async () => live,
        history: async () => ({
          orders: [],
          fills: [],
          accounts: [],
          positions: [],
          complete: true,
        }),
      });
    }
    input.action = { kind: "close", positionId: 99, price: 240000 };
    const close = await app.management.prepare(input);
    await app.management.dispatch(close.id, async () => input);
    // The signed read: close processed, position and its exits gone. History has nothing yet.
    state.lastRequestId = close.payload.rq;
    state.sources.push(
      { name: "Positions", block: 102, time: Date.now() },
      { name: "Orders", block: 102, time: Date.now() },
    );
    const journal = app.read()!;
    refreshRecordedProtection(journal, state);
    // Their true end is "cancelled" with the position, not an unknown outcome.
    expect(
      journal.management!.filter((o) => o.kind !== "close").map((o) => o.phase),
    ).toEqual(["observed", "observed"]);
    expect(() => assertEntryAvailable(journal, state, 32)).not.toThrow();
    expect(() => assertEntryAvailable(journal, live, 32)).toThrow("Resolve");
  });
  it("sums a partial close and the final close exactly once", async () => {
    const { journal, entry, state, history, event } = await endedPosition();
    history.positions!.push(
      event(101, 1, 14, "40", "-2", "3"),
      event(102, 2, 13, "-10", "1", "5"),
    );
    expect(
      reconcileLifecycleCompletion(journal, entry, state, history),
    ).toMatchObject({
      positionId: 99,
      block: 102,
      orderId: 902,
      pnl: "30",
      funding: "-1",
      fees: "17",
    });
    // A reduction without settled amounts is never counted as zero.
    delete history.positions![2].closeFee;
    expect(
      reconcileLifecycleCompletion(journal, entry, state, history),
    ).toBeNull();
  });
  it("never settles on absence, on a terminal row past a state source, or on an incomplete history", async () => {
    const { journal, entry, state, history, event } = await endedPosition();
    // The position is gone from state but history has no terminal row.
    expect(
      reconcileLifecycleCompletion(journal, entry, state, history),
    ).toBeNull();
    history.positions!.push(event(102, 2, 13, "1000", "-5", "8"));
    state.sources[0].block = 101;
    expect(
      reconcileLifecycleCompletion(journal, entry, state, history),
    ).toBeNull();
    state.sources[0].block = 102;
    history.complete = false;
    expect(
      reconcileLifecycleCompletion(journal, entry, state, history),
    ).toBeNull();
    history.complete = true;
    expect(
      reconcileLifecycleCompletion(journal, entry, state, history),
    ).not.toBeNull();
  });
  it("settles a trigger-closed position without a journal close command and unblocks a new entry", async () => {
    const { app, h, state, history, event } = await endedPosition();
    const entry = app.read()!.operations[0];
    const readers = { state: async () => state, history: async () => history };
    // Liquidation-style row: no order at all, and the exchange closed the position.
    history.positions!.push({
      ...event(102, 2, 13, "-700", "0", "8"),
      order: 0,
    });
    // While Perpl's reconciled read still shows the position, the entry blocks.
    const open = structuredClone(state);
    open.positions = [
      {
        id: 99,
        market: state.markets[0],
        side: "Long",
        size: 10n,
        entryPrice: 250000n,
        entryResidueQ16: 0,
        collateral: 10n * U,
        fees: 9n,
      },
    ];
    expect(() => assertEntryAvailable(app.read(), open, 32)).toThrow("Resolve");
    // Seen live: once that read shows it gone and its request processed, waiting 15 to
    // 45 s more for history only refused the next entry. Accounting still settles below.
    const lagging = structuredClone(state);
    lagging.sources.push(
      { name: "Positions", block: 101, time: Date.now() },
      { name: "Orders", block: 102, time: Date.now() },
    );
    // A positions replica behind the wallet read proves nothing about the fill.
    expect(() => assertEntryAvailable(app.read(), lagging, 32)).toThrow(
      "Resolve",
    );
    state.sources.push(
      { name: "Positions", block: 102, time: Date.now() },
      { name: "Orders", block: 102, time: Date.now() },
    );
    expect(() => assertEntryAvailable(app.read(), state, 32)).not.toThrow();
    const done = await app.reconcile(entry.id, readers);
    expect(done.completion).toMatchObject({
      orderId: 0,
      pnl: "-700",
      fees: "17",
    });
    expect(app.read()!.management ?? []).toHaveLength(0);
    expect(() => assertEntryAvailable(app.read(), state, 32)).not.toThrow();
    expect(() => assertNoUnresolvedOrders(h.storage, owner)).not.toThrow();
  });
  it("stops paging at rows older than every unresolved record", async () => {
    // Seen live: re-reading 3 to 4 full order-history pages on every reconcile spent the
    // minute's request budget, and a review right after a close was deferred.
    const pages: string[] = [];
    const rowAt = (time: number) => ({
      at: { b: 100, t: time, txid: "ab".repeat(32), l: time },
      acc: 1057,
      mkt: 32,
      oid: time,
      rq: 1,
      t: 1,
      os: 1,
      fs: 1,
      st: 4,
      p: 1,
      f: "0",
    });
    const history = await readOrderHistory(
      async (route, page) => {
        pages.push(`${route}:${page ?? ""}`);
        if (route !== "order-history") return { d: [], np: "" };
        const first = page === undefined;
        return {
          d: Array.from({ length: 100 }, (_, i) =>
            rowAt(first ? 5000 - i : 900 - i),
          ),
          np: first ? "next" : "after",
        };
      },
      undefined,
      1000,
    );
    expect(pages.filter((p) => p.startsWith("order-history"))).toEqual([
      "order-history:",
      "order-history:next",
    ]);
    expect(history.complete).toBe(true);
    expect(history.orders).toHaveLength(200);
  });
  it("cancels a pending signed history page without starting later routes", async () => {
    const controller = new AbortController();
    const routes: string[] = [];
    let signal: AbortSignal | undefined;
    const pending = readOrderHistory((route, _page, current) => {
      routes.push(route);
      signal = current;
      return new Promise((_, reject) =>
        current!.addEventListener("abort", () => reject(current!.reason), {
          once: true,
        }),
      );
    }, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejected;
    expect(routes).toEqual(["order-history"]);
    expect(signal!.aborted).toBe(true);
  });
  it("bounds and deduplicates paginated history without mistaking cursor exhaustion for finality", async () => {
    const at = { b: 100, txid: "ab".repeat(32), tx: 2, l: 1 };
    const order = {
      at,
      acc: 1057,
      mkt: 32,
      oid: 90,
      rq: 18,
      t: 1,
      st: 5,
      sr: 16,
      os: 20,
      fs: 10,
      p: 250000,
      f: "9",
    };
    const read = vi.fn(async (route: string, page?: string) =>
      route === "order-history"
        ? // A full page continues; the short second page ends the route.
          { d: page ? [] : Array(100).fill(order), np: page ? "" : "opaque+/=" }
        : { d: [], np: "" },
    );
    const history = await readOrderHistory(read);
    expect(history.orders).toHaveLength(1);
    expect(history.orders[0]).toMatchObject({
      hash: `0x${"ab".repeat(32)}`,
      transaction: 2,
    });
    expect(history.complete).toBe(true);
    expect(read).toHaveBeenCalledTimes(5);
    const ledgerAndPosition = await readOrderHistory(async (route) => ({
      np: "",
      d:
        route === "account-history"
          ? [
              {
                at,
                id: 1057,
                et: 8,
                m: 32,
                r: 18,
                o: 90,
                p: 99,
                a: "-7",
                b: "100000000",
                lb: "0",
                f: "0",
              },
            ]
          : route === "position-history"
            ? [
                {
                  at,
                  acc: 1057,
                  mkt: 32,
                  pid: 99,
                  rq: 18,
                  oid: 90,
                  sd: 1,
                  st: 2,
                  sr: 13,
                  s: 0,
                  ep: 250000,
                  fee: "17",
                  cfee: "8",
                  dpnl: "1000",
                  fnd: "-7",
                },
              ]
            : [],
    }));
    expect(ledgerAndPosition.accounts[0]).toMatchObject({
      positionId: 99,
      type: 8,
      amount: "-7",
      balance: "100000000",
      locked: "0",
      fee: "0",
    });
    expect(ledgerAndPosition.positions![0]).toMatchObject({
      positionId: 99,
      side: 1,
      reason: 13,
      pnl: "1000",
      funding: "-7",
      fee: "17",
      closeFee: "8",
    });
    await expect(
      readOrderHistory(async () => ({
        d: Array(100).fill(order),
        np: "repeat",
      })),
    ).rejects.toThrow("repeated");
    let n = 0;
    expect(
      (
        await readOrderHistory(async (route) =>
          route === "order-history"
            ? { d: Array(100).fill(order), np: String(++n) }
            : { d: [], np: "" },
        )
      ).complete,
    ).toBe(false);
    expect(n).toBe(4);
    await expect(
      readOrderHistory(async () => ({ d: [], np: 2 })),
    ).rejects.toThrow("Incomplete");
  });
});

describe("native consumer close preview", () => {
  it("uses opposing depth, actual residual lots, account fee tier and Q16 entry residue without requiring known funding to reduce", async () => {
    const { assessCloseReview } = await import("./perpl-close-review");
    for (const side of ["long", "short"] as const)
      for (const market of ["ETH", "BTC"] as const) {
        const f = fixture(side, market);
        const m = f.account.markets.find((m) => m.symbol === market)!;
        f.account.positions = [
          {
            id: 99,
            market: m,
            side: side === "long" ? "Long" : "Short",
            size: 11n,
            entryPrice: f.observation.mark / m.tick,
            entryResidueQ16: 32768,
            collateral: 12n * U,
            fees: 17n,
          },
        ];
        const p = f.account.positions[0];
        const preview = assessCloseReview(
          owner,
          f.account,
          99,
          f.observation,
          25,
        );
        expect(preview.lots).toBe(2n);
        expect(preview.remaining).toBe(9n);
        expect(preview.entryFee).toBe(4n);
        expect(preview.net).toBeUndefined();
        expect(
          managementPayload(
            owner,
            {
              state: f.account,
              action: preview.action,
              sessionId: "",
              sessionExpiresAt: 0,
              reviewExpiresAt: 0,
              ttlBlocks: 20,
            },
            Date.now(),
          ),
        ).toMatchObject({
          t: side === "long" ? 3 : 4,
          s: 2,
          p: preview.action.kind === "partial-close" ? preview.action.price : 0,
          fl: 4,
          mnp: 0,
        });
        const risk = {
          accountId: f.account.accountId,
          positionId: 99,
          marketId: m.marketId,
          side: p.side,
          size: p.size,
          entryPrice: p.entryPrice,
          entryResidueQ16: p.entryResidueQ16,
          collateral: p.collateral,
          premiumPnl: -100n,
          block: 100n,
          blockTime: Date.now(),
          mark: p.entryPrice,
          maintenanceFactor: BigInt(m.maintenanceMarginFactor),
          dynamicLeverage: BigInt(m.initialMarginFactor),
        };
        const full = assessCloseReview(
          owner,
          f.account,
          99,
          f.observation,
          100,
          risk,
        );
        expect(full.lots).toBe(11n);
        expect(full.entryFee).toBe(17n);
        expect(full.funding).toBe(-100n);
        expect(full.net).toBe(full.gross - 100n - full.fees);
        expect(full.back).toBe(p.collateral + full.gross - 100n - full.exitFee);
        const noResidue = assessCloseReview(
          owner,
          { ...f.account, positions: [{ ...p, entryResidueQ16: 0 }] },
          99,
          f.observation,
          100,
        );
        expect(full.gross).not.toBe(noResidue.gross);
        expect(
          assessCloseReview(owner, f.account, 99, f.observation, 100, {
            ...risk,
            size: 12n,
          }).net,
        ).toBeUndefined();
        expect(() =>
          assessCloseReview(
            owner,
            f.account,
            99,
            { ...f.observation, bids: [], asks: [] },
            100,
          ),
        ).toThrow("Opposing depth");
      }
  });
});

it("resumes original protection only at the canonical actual fill, withholding unknown/rejected/duplicate legs and changed exposure", async () => {
  const { initialProtectionAction } = await import("./perpl-lifecycle");
  const f = fixture();
  f.account.positions = [
    {
      id: 99,
      market: f.observation.metadata,
      side: "Long",
      size: 5n,
      entryPrice: 250000n,
      entryResidueQ16: 0,
      collateral: 10n * U,
      fees: 1n,
    },
  ];
  const entry: import("./order-journal").OrderOperation = {
    id: crypto.randomUUID(),
    binding: "a".repeat(64),
    sessionId: crypto.randomUUID(),
    expiresAt: Date.now() + 1000,
    protocolId: 17,
    payload: {
      rq: 18,
      acc: 1057,
      mkt: 32,
      t: 1,
      p: 250000,
      s: 20,
      lv: 300,
      fl: 4,
      mnp: 50,
      lb: 120,
    },
    bracket: { target: 300000, stop: 240000 },
    positionId: 99,
    phase: "partial-fill",
    filled: 5,
    protection: "pending",
    history: "settled",
    settlement: { hash: `0x${"1".repeat(64)}`, block: 100, orderId: 9 },
  };
  const action = initialProtectionAction(entry, f.account, [], "stop-loss");
  expect(action).toMatchObject({
    kind: "stop-loss",
    positionId: 99,
    trigger: 240000,
    price: 238800,
  });
  expect(
    initialProtectionAction(
      { ...entry, positionId: undefined },
      f.account,
      [],
      "stop-loss",
    ),
  ).toBeUndefined();
  expect(
    initialProtectionAction(
      { ...entry, history: "unresolved" },
      f.account,
      [],
      "stop-loss",
    ),
  ).toBeUndefined();
  const input: ManagementAdmission = {
    state: f.account,
    action: action!,
    sessionId: entry.sessionId,
    sessionExpiresAt: Date.now() + 10000,
    reviewExpiresAt: Date.now() + 10000,
    ttlBlocks: 20,
    risk: {
      accountId: 1057,
      positionId: 99,
      marketId: 32,
      block: 100n,
      blockTime: Date.now(),
      size: 5n,
      entryPrice: 250000n,
      entryResidueQ16: 0,
      collateral: 10n * U,
      premiumPnl: 0n,
      mark: 250000n,
      maintenanceFactor: 2000n,
      dynamicLeverage: 1200n,
    },
  };
  const payload = { ...managementPayload(owner, input, Date.now()), rq: 19 };
  const recorded: import("./order-journal").ManagementOperation = {
    id: crypto.randomUUID(),
    binding: "a".repeat(64),
    sessionId: entry.sessionId,
    expiresAt: Date.now() + 10000,
    protocolId: 18,
    kind: "stop-loss",
    positionId: 99,
    payload,
    phase: "unknown",
    filled: 0,
    settlement: null,
  };
  for (const phase of [
    "unknown",
    "forwarded",
    "cancelled",
    "prepared",
  ] as const)
    expect(
      initialProtectionAction(
        entry,
        f.account,
        [{ ...recorded, phase }],
        "stop-loss",
      ),
    ).toBeUndefined();
  // A rejected (provably unsent) or discarded leg may be re-issued under a new request id.
  for (const phase of ["discarded", "rejected"] as const)
    expect(
      initialProtectionAction(
        entry,
        f.account,
        [{ ...recorded, phase }],
        "stop-loss",
      ),
    ).toEqual(action);
  expect(initialProtectionAction(entry, f.account, [], "stop-loss")).toEqual(
    action,
  );
  expect(
    initialProtectionAction(entry, f.account, [recorded], "take-profit"),
  ).toBeUndefined(); // unknown stop cannot be bypassed
  f.account.orders = [
    {
      id: 10,
      market: f.observation.metadata,
      type: 3,
      status: 8,
      size: 5n,
      filled: 0n,
      request: 19,
      price: BigInt(payload.p!),
      triggerPrice: BigInt(payload.tp!),
      triggerCondition: payload.tpc,
      linkedPosition: 99,
      flags: 4,
      leverage: 0,
    },
  ];
  expect(
    positionProtection(f.account, f.account.positions[0]).stopLoss.state,
  ).toBe("waiting");
  expect(
    initialProtectionAction(
      entry,
      f.account,
      [{ ...recorded, phase: "observed", observedOrderId: 10 }],
      "stop-loss",
    ),
  ).toBeUndefined();
  expect(
    initialProtectionAction(
      entry,
      f.account,
      [{ ...recorded, phase: "observed", observedOrderId: 10 }],
      "take-profit",
    ),
  ).toMatchObject({ trigger: 300000, price: 298500 });
  f.account.orders = [];
  f.account.positions[0].size = 6n;
  expect(() =>
    initialProtectionAction(entry, f.account, [], "stop-loss"),
  ).toThrow("Exposure changed");
});
