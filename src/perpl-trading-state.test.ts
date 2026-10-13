import { describe, expect, it } from "vitest";
import type { TestnetAccount } from "./perpl-account";
import { testnet } from "./testnet-config";
import {
  normalizeTradingState,
  readTradingState,
  tradingStateFresh,
} from "./perpl-trading-state";

const owner = `0x${"1".repeat(40)}` as const;
function fixture() {
  const now = Date.now();
  const at = { b: 69913595, t: now - 1000 };
  const context = {
    chain: { chain_id: 10143 },
    instances: [{ id: 12, address: testnet.exchange, collateral_token_id: 1 }],
    tokens: [
      { id: 1, address: testnet.collateral, symbol: "AUSD", decimals: 6 },
    ],
    markets: [
      ["ETH", 32, 2, 3],
      ["BTC", 16, 1, 5],
    ].map(([symbol, id, price, size]) => ({
      symbol,
      id,
      instance_id: 12,
      size_units: symbol,
      ver: 1,
      funding_interval_blocks: 8571,
      funding_interval_sec: 2580,
      config: {
        at,
        is_open: true,
        price_decimals: price,
        size_decimals: size,
        initial_margin: 1200,
        maintenance_margin: 2000,
        taker_fee: 345,
      },
    })),
  };
  const positions = [
    {
      acc: 1057,
      mkt: 32,
      pid: 10,
      sd: 1,
      st: 1,
      s: 2,
      ep: 248058,
      epr: 32768,
      c: "1000000",
      fee: "1712",
    },
    {
      acc: 1057,
      mkt: 16,
      pid: 11,
      sd: 2,
      st: 1,
      s: 3,
      ep: 1000000,
      c: "1000000",
      fee: "-1035",
    },
  ];
  const order = {
    acc: 1057,
    mkt: 32,
    oid: 20,
    t: 3,
    st: 8,
    os: 2,
    fs: 0,
    tp: 240000,
    tpc: 4,
    lp: 10,
  };
  const responses = {
    context,
    wallet: {
      mt: 19,
      sn: at.b,
      at,
      addr: owner,
      as: [
        {
          in: 12,
          id: 1057,
          fr: false,
          fw: false,
          ft: 0,
          lfr: 17,
          b: "98000000",
          lb: "2000000",
        },
      ],
    },
    positions: { mt: 26, sn: at.b, at, d: positions },
    orders: { mt: 23, sn: at.b, at, d: [order] },
  };
  const chain: TestnetAccount = {
    owner,
    chainId: 10143,
    block: BigInt(at.b),
    blockHash: `0x${"1".repeat(64)}`,
    blockTime: at.t,
    receivedAt: now,
    walletMon: 1000000000000000000n,
    walletAusd: 9900000000n,
    allowance: 0n,
    funding: {
      minimumInitialDeposit: 100000000n,
      halted: false,
      addressBlocked: false,
      whitelistEnabled: false,
      whitelisted: false,
    },
    exchangeAccount: {
      id: 1057n,
      balance: 98000000n,
      free: 96000000n,
      locked: 2000000n,
      frozen: 0,
      hasPosition: true,
    },
  };
  return { now, responses, chain };
}

describe("authenticated trading snapshots", () => {
  it("starts no authenticated reads after pre-abort and forwards supersession to every pending signed read", async () => {
    const f = fixture();
    const routes: string[] = [];
    const controller = new AbortController();
    controller.abort();
    await expect(
      readTradingState(
        owner,
        async (route) => {
          routes.push(route);
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(routes).toEqual([]);
    const delayed = new AbortController();
    const signals: AbortSignal[] = [];
    const pending = readTradingState(
      owner,
      (route, signal) => {
        routes.push(route);
        signals.push(signal!);
        return new Promise((_, reject) =>
          signal!.addEventListener("abort", () => reject(signal!.reason), {
            once: true,
          }),
        );
      },
      {
        signal: delayed.signal,
        fetcher: async () => new Response(JSON.stringify(f.responses.context)),
        readChain: async () => f.chain,
      },
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    delayed.abort();
    await rejected;
    expect(routes).toEqual(["wallet", "positions", "orders"]);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });
  it("reads multi-market exposure and linked orders with exact units, and reconciles independent chain balances", async () => {
    const f = fixture();
    const routes: string[] = [];
    const result = await readTradingState(
      owner,
      async (route) => {
        routes.push(route);
        return f.responses[route];
      },
      {
        fetcher: async (url) => {
          expect(url).toBe("/perpl-public/v1/pub/context");
          return new Response(JSON.stringify(f.responses.context));
        },
        readChain: async () => f.chain,
      },
    );
    expect(routes).toEqual(["wallet", "positions", "orders"]);
    expect(result.reconciled).toBe(true);
    expect(result.balance).toBe(98000000n);
    expect(result.free).toBe(96000000n);
    expect(result.forwarding).toBe(false);
    expect(
      result.positions.map((p) => [
        p.market.symbol,
        p.size,
        p.market.sizeDecimals,
        p.side,
      ]),
    ).toEqual([
      ["ETH", 2n, 3, "Long"],
      ["BTC", 3n, 5, "Short"],
    ]);
    expect(result.positions[0].entryResidueQ16).toBe(32768);
    expect(result.positions[1].fees).toBe(-1035n);
    expect(result.orders[0]).toMatchObject({
      linkedPosition: 10,
      triggerPrice: 240000n,
      status: 8,
    });
    expect(tradingStateFresh(result, f.now + 31000)).toBe(false);
    expect(tradingStateFresh(result, f.now + 29000)).toBe(true);
    f.chain.exchangeAccount!.free++;
    expect(normalizeTradingState(owner, f.responses, f.chain).reconciled).toBe(
      false,
    );
    f.chain.exchangeAccount!.free--;
    f.chain.exchangeAccount!.hasPosition = false;
    expect(normalizeTradingState(owner, f.responses, f.chain).reconciled).toBe(
      false,
    );
  });

  it("fails closed on wrong identity, stale or missing snapshots, unsafe units and unsupported exposure", () => {
    const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
      (f) => {
        f.responses.wallet.addr = `0x${"2".repeat(40)}` as typeof owner;
      },
      (f) => {
        f.responses.wallet.as[0].id = 42;
      },
      (f) => {
        f.responses.positions.at = {
          ...f.responses.positions.at,
          t: f.now - 31000,
        };
      },
      (f) => {
        f.responses.orders.sn--;
      },
      (f) => {
        f.responses.positions.d[0].s = Number.MAX_SAFE_INTEGER + 1;
      },
      (f) => {
        f.responses.positions.d[0].mkt = 48;
      },
      (f) => {
        f.responses.positions.d.push(f.responses.positions.d[0]);
      },
      (f) => {
        f.responses.positions.d[0].st = 2;
      },
      (f) => {
        f.responses.orders.d[0].fs = 3;
      },
      (f) => {
        f.responses.orders.d[0].st = 4;
      },
      (f) => {
        f.responses.wallet.as[0].b = "1.5";
      },
      (f) => {
        f.responses.context.chain.chain_id = 143;
      },
      (f) => {
        f.responses.context.markets[1].config.size_decimals = 8;
      },
      (f) => {
        f.responses.orders.d = null as never;
      },
    ];
    for (const change of changes) {
      const f = fixture();
      change(f);
      expect(() =>
        normalizeTradingState(owner, f.responses, f.chain, f.now),
      ).toThrow();
    }
  });

  it("does not treat unavailable account data as an empty portfolio or successful reconciliation", async () => {
    const f = fixture();
    await expect(
      readTradingState(
        owner,
        async (route) => {
          if (route === "orders") throw Error("HTTP 503");
          return f.responses[route];
        },
        {
          fetcher: async () =>
            new Response(JSON.stringify(f.responses.context)),
          readChain: async () => f.chain,
        },
      ),
    ).rejects.toThrow("HTTP 503");
    f.responses.positions.d = [];
    f.responses.orders.d = [];
    f.chain.exchangeAccount!.hasPosition = false;
    expect(normalizeTradingState(owner, f.responses, f.chain).reconciled).toBe(
      true,
    );
    f.chain.exchangeAccount = null;
    expect(normalizeTradingState(owner, f.responses, f.chain).reconciled).toBe(
      false,
    );
  });
});
