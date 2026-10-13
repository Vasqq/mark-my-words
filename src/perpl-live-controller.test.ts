import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createLiveController } from "./perpl-ui/engine/live/controller";
import { sizeLiveIntent, type LiveSizingReview } from "./perpl-sizing";
import { managementPayload } from "./perpl-lifecycle";
import type { TradingState } from "./perpl-trading-state";
import type { PublicMarketObservation } from "./perpl-market-data";
import type { PublicDraft } from "./public-draft";
const owner = "0x1111111111111111111111111111111111111111";
const fixture = vi.hoisted(() => ({
  state: undefined as TradingState | undefined,
  sizing: undefined as LiveSizingReview | undefined,
  payloads: [] as Record<string, number>[],
  reads: 0,
  historyCalls: 0,
  sessionId: "11111111-1111-4111-8111-111111111111" as string | undefined,
  historyPages: 8,
  unknownStop: false,
  terminal: false,
  onRead: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("./perpl-account", async (original) => ({
  ...(await original<typeof import("./perpl-account")>()),
  readTestnetAccount: async () => ({
    owner: owner,
    chainId: 10143,
    block: 100n,
    exchangeAccount: { id: 1057n },
  }),
}));
vi.mock("./perpl-trading-state", async (original) => ({
  ...(await original<typeof import("./perpl-trading-state")>()),
  readTradingState: async () => {
    fixture.reads++;
    await fixture.onRead?.();
    const state = structuredClone(fixture.state!);
    state.receivedAt = Date.now();
    state.sources = state.sources.map((s) => ({ ...s, time: Date.now() }));
    return state;
  },
}));
vi.mock("./perpl-sizing", async (original) => ({
  ...(await original<typeof import("./perpl-sizing")>()),
  reviewPublicSizing: async () => {
    const sizing = structuredClone(fixture.sizing!);
    sizing.blockTime = Date.now();
    sizing.observation.receivedAt =
      sizing.observation.bookTime =
      sizing.observation.stateTime =
        Date.now();
    return sizing;
  },
}));
vi.mock("./perpl-lifecycle", async (original) => ({
  ...(await original<typeof import("./perpl-lifecycle")>()),
  readPositionRisk: async () => ({
    accountId: 1057,
    positionId: 99,
    marketId: 32,
    block: 100n,
    blockTime: Date.now(),
    side: "Long",
    size: 2n,
    entryPrice: 250000n,
    entryResidueQ16: 0,
    collateral: 2000000n,
    premiumPnl: 0n,
    mark: 250000n,
    maintenanceFactor: 2000n,
    dynamicLeverage: 1200n,
  }),
}));
vi.mock("./perpl-order-history", async (original) => ({
  ...(await original<typeof import("./perpl-order-history")>()),
  readEntrySettlement: async (p: { s: number; t: number }) =>
    p.t === 1
      ? { hash: `0x${"a".repeat(64)}`, block: 100, filled: p.s, fee: "1725" }
      : {
          hash: `0x${"b".repeat(64)}`,
          block: 101,
          filled: p.s,
          fee: "100",
          amount: "1",
          balance: "100000001",
          closed: { pnl: "100", funding: "0" },
        },
}));
vi.mock("./perpl-session", () => ({
  createPerplSession: () => ({
    status: () => ({
      state: fixture.sessionId ? "active" : "unavailable",
      expiresAt: Date.now() + 3600000,
    }),
    identity: () =>
      fixture.sessionId
        ? {
            id: fixture.sessionId,
            expiresAt: Date.now() + 3600000,
          }
        : null,
    dispose: () => {},
    snapshot: async (
      work: () => Promise<unknown>,
      _priority: "observation" | "recovery",
    ) => {
      return work();
    },
    history: async (route: string, page?: string) => {
      fixture.historyCalls++;
      const p = fixture.payloads.find((p) => p.t === 1);
      const at = { b: 100, t: Date.now(), txid: "a".repeat(64), l: 1 };
      const data: Record<string, unknown>[] =
        !p || page
          ? []
          : route === "order-history"
            ? [
                {
                  at,
                  acc: 1057,
                  mkt: 32,
                  oid: 900,
                  rq: p.rq,
                  t: 1,
                  os: p.s,
                  fs: p.s,
                  st: 4,
                  p: p.p,
                  f: "1725",
                },
              ]
            : route === "fills"
              ? [
                  {
                    at,
                    acc: 1057,
                    mkt: 32,
                    oid: 900,
                    t: 1,
                    s: p.s,
                    p: 250000,
                    f: "1725",
                  },
                ]
              : route === "position-history"
                ? [
                    {
                      at,
                      acc: 1057,
                      mkt: 32,
                      pid: 99,
                      rq: p.rq,
                      oid: 900,
                      sd: 1,
                      st: 1,
                      sr: 21,
                      s: p.s,
                      ep: 250000,
                      fee: "1725",
                    },
                  ]
                : [];
      const protective = fixture.payloads.filter((p) => p.tp !== undefined);
      const closing = fixture.payloads.find(
        (p) => p.t === 3 && p.tp === undefined,
      );
      if (!page && route === "order-history") {
        protective.forEach((exit, index) =>
          data.push({
            at: { ...at, l: 2 + index },
            acc: 1057,
            mkt: 32,
            oid: exit.tpc === 4 ? 901 : 902,
            rq: exit.rq,
            t: 3,
            os: exit.s,
            fs: 0,
            st: 8,
            p: exit.p,
            f: "0",
            lp: 99,
            tp: exit.tp,
            tpc: exit.tpc,
          }),
        );
      }
      if (!page && closing) {
        const finalAt = { b: 101, t: Date.now(), txid: "b".repeat(64), l: 1 };
        if (route === "order-history") {
          data.push({
            at: finalAt,
            acc: 1057,
            mkt: 32,
            oid: 903,
            rq: closing.rq,
            t: 3,
            os: closing.s,
            fs: closing.s,
            st: 4,
            p: closing.p,
            f: "100",
          });
          if (fixture.terminal)
            protective.forEach((exit, index) =>
              data.push({
                at: { ...finalAt, l: 4 + index },
                acc: 1057,
                mkt: 32,
                oid: exit.tpc === 4 ? 901 : 902,
                rq: closing.rq,
                t: 3,
                os: exit.s,
                fs: 0,
                st: 5,
                sr: 28,
                p: exit.p,
                f: "0",
                lp: 99,
                tp: exit.tp,
                tpc: exit.tpc,
              }),
            );
        }
        if (route === "fills")
          data.push({
            at: finalAt,
            acc: 1057,
            mkt: 32,
            oid: 903,
            t: 3,
            s: closing.s,
            p: 250000,
            f: "100",
          });
        if (route === "position-history")
          data.push({
            at: finalAt,
            acc: 1057,
            mkt: 32,
            pid: 99,
            rq: closing.rq,
            oid: 903,
            sd: 1,
            st: 2,
            sr: 13,
            s: closing.s,
            ep: 250000,
            fee: "1825",
            cfee: "100",
            dpnl: "100",
            fnd: "0",
          });
        if (route === "account-history")
          data.push({
            at: finalAt,
            id: 1057,
            m: 32,
            o: 903,
            r: closing.rq,
            p: 99,
            et: 4,
            a: "1",
            b: "100000001",
            lb: "0",
            f: "100",
          });
      }
      return {
        d: data,
        np:
          (fixture.historyPages === 16 && page !== "3") ||
          (fixture.historyPages === 8 &&
            (route === "account-history" ||
              fixture.payloads.some((p) => p.t === 1)) &&
            !page)
            ? String(Number(page ?? "0") + 1)
            : "",
      };
    },
    submit: async (body: string) => {
      const p = JSON.parse(body).d[0];
      fixture.payloads.push(p);
      fixture.state!.lastRequestId = p.rq;
      if (p.t === 1)
        fixture.state!.positions = [
          {
            id: 99,
            market: fixture.state!.markets[0],
            side: "Long",
            size: BigInt(p.s),
            entryPrice: 250000n,
            entryResidueQ16: 0,
            collateral: 2000000n,
            fees: 1725n,
          },
        ];
      else if (p.t === 3 && p.tp === undefined) {
        fixture.state!.positions = [];
        fixture.state!.orders = [];
        fixture.state!.sources[0].block = 101;
        fixture.state!.balance = fixture.state!.free = 100000001n;
      } else if (p.t === 6) {
        // Acknowledged only. A test raises the position's collateral itself.
      } else if (!fixture.unknownStop)
        fixture.state!.orders.push({
          id: p.tpc === 4 ? 901 : 902,
          request: p.rq,
          market: fixture.state!.markets[0],
          type: 3,
          status: 8,
          size: BigInt(p.s),
          filled: 0n,
          price: BigInt(p.p),
          flags: 4,
          leverage: 0,
          triggerPrice: BigInt(p.tp),
          triggerCondition: p.tpc,
          linkedPosition: p.lp,
        });
      if (p.tpc === 4 && fixture.unknownStop)
        throw Error("Unknown forwarding outcome");
      return { mt: 31, status: { code: 0 }, statuses: [{ code: 0 }] };
    },
  }),
}));
let store: Map<string, string>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T16:00:00Z"));
  store = new Map();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", {
    localStorage: storage,
    location: { origin: "http://localhost:3000" },
  });
  const held = new Set<string>();
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        name: string,
        options: unknown,
        work?: (held: object | null) => Promise<unknown>,
      ) => {
        const callback =
          typeof options === "function"
            ? (options as (held: object | null) => Promise<unknown>)
            : work!;
        if (held.has(name)) return callback(null);
        held.add(name);
        try {
          return await callback({});
        } finally {
          held.delete(name);
        }
      },
    },
  });
  vi.stubGlobal("document", { createElement: () => ({ click: () => {} }) });
  fixture.payloads = [];
  fixture.reads = 0;
  fixture.historyCalls = 0;
  fixture.sessionId = "11111111-1111-4111-8111-111111111111";
  fixture.historyPages = 8;
  fixture.unknownStop = false;
  fixture.terminal = false;
  fixture.onRead = undefined;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function environment() {
  fixture.payloads = [];
  fixture.reads = 0;
  fixture.unknownStop = false;
  fixture.terminal = false;
  fixture.onRead = undefined;
  const metadata = {
    symbol: "ETH" as const,
    marketId: 32,
    instanceId: 12,
    configBlock: 69090219,
    configTime: Date.now(),
    contextVersion: 272,
    orderTtlBlocks: 20,
    tick: 10000n,
    lot: 1000n,
    priceDecimals: 2,
    sizeDecimals: 3,
    open: true,
    baseTakerFeePpm: 345n,
    initialMarginFactor: 1200,
    maintenanceMarginFactor: 2000,
    fundingIntervalBlocks: 8571,
    fundingIntervalSeconds: 2580,
  };
  const draft: PublicDraft = {
    market: "ETH",
    side: "long",
    goal: 1000000n,
    target: 3000000000n,
    stop: 2400000000n,
    leverage: 300n,
    revision: 1,
  };
  const observation: PublicMarketObservation = {
    metadata,
    mark: 2500000000n,
    bestAsk: 2500000000n,
    bestBid: 2500000000n,
    asks: [{ price: 2500000000n, lots: 1000n }],
    bids: [{ price: 2500000000n, lots: 1000n }],
    bookBlock: 100,
    stateBlock: 100,
    bookTime: Date.now(),
    stateTime: Date.now(),
    receivedAt: Date.now(),
  };
  fixture.sizing = {
    intent: { ...draft, budget: 100000000n },
    observation,
    size: sizeLiveIntent(draft, observation),
    block: 100n,
    blockTime: Date.now(),
    dynamicLeverage: 1200n,
    maintenanceFactor: 2000n,
    baseMargin: 0n,
  };
  fixture.state = {
    owner: owner,
    accountId: 1057,
    balance: 100000000n,
    free: 100000000n,
    locked: 0n,
    forwarding: true,
    frozen: false,
    feeTier: 0,
    lastRequestId: 100,
    markets: [metadata],
    restrictions: {
      minimumInitialDeposit: 100000000n,
      halted: false,
      addressBlocked: false,
      whitelistEnabled: false,
      whitelisted: false,
    },
    positions: [],
    orders: [],
    sources: [{ name: "Wallet", block: 100, time: Date.now() }],
    receivedAt: Date.now(),
    reconciled: true,
  };
  const controller = createLiveController(
    owner,
    () => undefined,
    () => undefined,
  );
  return { controller, draft, observation };
}
// confirmEntry waits 1500 ms (real setTimeout) before recovering; drive fake timers until it settles.
async function settle<T>(work: Promise<T>): Promise<T> {
  let done = false;
  const tracked = work.finally(() => {
    done = true;
  });
  tracked.catch(() => undefined);
  for (let i = 0; !done && i < 100; i++) await vi.advanceTimersByTimeAsync(500);
  return tracked;
}
async function reviewed(e: ReturnType<typeof environment>) {
  const reviewed = await e.controller.reviewDraft(e.draft, e.observation);
  expect(reviewed).toBeDefined();
  return reviewed!;
}
it("sends the entry, then the stop, then the target, once each, and reconciles the bracket", async () => {
  const e = environment();
  const review = await reviewed(e);
  await settle(e.controller.confirmEntry(review.id, e.draft, e.observation));
  expect(fixture.payloads.map((p) => [p.t, p.tpc])).toEqual([
    [1, undefined],
    [3, 4],
    [3, 3],
  ]);
  expect(
    e.controller.getSnapshot().journal?.management?.map((op) => op.phase),
  ).toEqual(["observed", "observed"]);
  await e.controller.recover();
  expect(fixture.payloads).toHaveLength(3); // Recovery never resends an observed leg.
  e.controller.dispose();
});
it("never sends a target after an unknown unobserved stop or authority change during its independent readback", async () => {
  const e = environment();
  const review = await reviewed(e);
  fixture.unknownStop = true;
  await settle(e.controller.confirmEntry(review.id, e.draft, e.observation));
  expect(fixture.payloads).toHaveLength(2);
  expect(e.controller.getSnapshot().journal?.management?.[0].phase).toBe(
    "unknown",
  );
  await e.controller.recover();
  expect(fixture.payloads).toHaveLength(2); // Still no target, and no second stop.
  e.controller.dispose();
  store.clear();
  const other = environment();
  const second = await reviewed(other);
  fixture.onRead = async () => {
    if (fixture.payloads.length === 2) other.controller.invalidate();
  };
  await settle(
    other.controller.confirmEntry(second.id, other.draft, other.observation),
  );
  expect(fixture.payloads).toHaveLength(2);
  expect(other.controller.getSnapshot().error).toContain("Account");
  other.controller.dispose();
});
it("refuses a changed residual position without duplicating the entry or the stop", async () => {
  const e = environment();
  const review = await reviewed(e);
  fixture.onRead = async () => {
    if (fixture.reads === 2) fixture.state!.positions[0].size = 3n;
  };
  await settle(e.controller.confirmEntry(review.id, e.draft, e.observation));
  expect(fixture.payloads.map((p) => p.t)).toEqual([1]);
  expect(e.controller.getSnapshot().error).toContain("Exposure changed");
  e.controller.dispose();
});
it("encodes the same collateral increase for a long and a short and refuses more than the free balance", () => {
  const e = environment();
  const state = fixture.state!;
  const body = (side: "Long" | "Short", marketId: 16 | 32, amount: number) => {
    state.positions = [
      {
        id: 99,
        market: { ...state.markets[0], marketId },
        side,
        size: 8n,
        entryPrice: 250000n,
        entryResidueQ16: 0,
        collateral: 2000000n,
        fees: 0n,
      },
    ];
    return managementPayload(
      owner,
      {
        state,
        action: { kind: "add-collateral", marketId, positionId: 99, amount },
        sessionId: fixture.sessionId!,
        sessionExpiresAt: Date.now() + 3600000,
        reviewExpiresAt: Date.now() + 10000,
        ttlBlocks: 20,
      },
      Date.now(),
    );
  };
  const wire = { acc: 1057, lv: 0, t: 6, s: 0, fl: 4, lb: 0, lp: 99 };
  expect(body("Long", 32, 1000000)).toEqual({ ...wire, mkt: 32, a: "1000000" });
  expect(body("Short", 16, 2500000)).toEqual({
    ...wire,
    mkt: 16,
    a: "2500000",
  });
  expect(() => body("Long", 32, 0)).toThrow();
  expect(() => body("Long", 32, 100000001)).toThrow("free balance");
  state.positions = [];
  expect(() =>
    managementPayload(
      owner,
      {
        state,
        action: {
          kind: "add-collateral",
          marketId: 32,
          positionId: 99,
          amount: 1,
        },
        sessionId: fixture.sessionId!,
        sessionExpiresAt: Date.now() + 3600000,
        reviewExpiresAt: Date.now() + 10000,
        ttlBlocks: 20,
      },
      Date.now(),
    ),
  ).toThrow("no longer open");
  e.controller.dispose();
});
it("keeps an acknowledged collateral increase pending until a signed read shows it, and never resends", async () => {
  const e = environment();
  const review = await reviewed(e);
  await settle(e.controller.confirmEntry(review.id, e.draft, e.observation));
  const added = await e.controller.reviewCollateral(99, 32, "1");
  expect(added?.collateral).toEqual({
    amount: 1000000n,
    before: 2000000n,
    after: 3000000n,
    left: 99000000n,
  });
  const outcome = await settle(e.controller.confirmManagement(added!.id));
  expect(outcome.state).toBe("pending");
  const sent = fixture.payloads.filter((p) => p.t === 6);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ mkt: 32, a: "1000000", lp: 99, lb: 0 });
  const last = () => e.controller.getSnapshot().journal!.management!.at(-1)!;
  expect([last().kind, last().phase, last().collateralBefore]).toEqual([
    "add-collateral",
    "forwarded",
    "2000000",
  ]);
  await e.controller.recover();
  expect(last().phase).toBe("forwarded"); // The acknowledgment is not the increase.
  // Unresolved, it blocks a second increase instead of sending one.
  const again = await e.controller.reviewCollateral(99, 32, "1");
  await settle(e.controller.confirmManagement(again!.id));
  expect(fixture.payloads.filter((p) => p.t === 6)).toHaveLength(1);
  fixture.state!.positions[0].collateral = 2999999n;
  await e.controller.recover();
  expect(last().phase).toBe("forwarded");
  fixture.state!.positions[0].collateral = 3000000n;
  await e.controller.recover();
  expect(last().phase).toBe("observed");
  e.controller.dispose();
});
