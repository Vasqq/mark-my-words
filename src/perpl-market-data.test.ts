import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeContext,
  normalizeObservation,
  observationFresh,
  PerplMarketDataSource,
  SOURCE_MAX_AGE_MS,
} from "./perpl-market-data";
import { testnet } from "./testnet-config";

// Representative public testnet wire values observed October 9; never account data.
const at = { b: 69613687, t: 1791571394000 };
const context = () => ({
  chain: { chain_id: 10143 },
  instances: [
    { id: 12, address: testnet.exchange.toLowerCase(), collateral_token_id: 1 },
  ],
  tokens: [
    {
      id: 1,
      address: testnet.collateral.toLowerCase(),
      symbol: "AUSD",
      decimals: 6,
    },
  ],
  markets: [
    {
      symbol: "ETH",
      id: 32,
      instance_id: 12,
      size_units: "ETH",
      ver: 272,
      funding_interval_blocks: 8571,
      funding_interval_sec: 2580,
      config: {
        at,
        is_open: true,
        price_decimals: 2,
        size_decimals: 3,
        initial_margin: 1200,
        maintenance_margin: 2000,
        taker_fee: 345,
        taker_fees: [345, 300, 0],
      },
    },
    {
      symbol: "BTC",
      id: 16,
      instance_id: 12,
      size_units: "BTC",
      ver: 272,
      funding_interval_blocks: 8571,
      funding_interval_sec: 2580,
      config: {
        at,
        is_open: true,
        price_decimals: 1,
        size_decimals: 5,
        initial_margin: 1500,
        maintenance_margin: 2500,
        taker_fee: 345,
      },
    },
  ],
});
const book = (block = at.b) => ({
  mt: 15,
  sn: block,
  at: { ...at, b: block },
  bid: [{ p: 248028, s: 36284, o: 1 }],
  ask: [{ p: 248058, s: 35861, o: 1 }],
});
const ticker = (id = 32, block = at.b) => ({
  mt: 9,
  sn: block,
  d: {
    [id]: { at: { ...at, b: block }, mrk: 248067, bid: 248028, ask: 248058 },
  },
});
const fetcher = (read: (url: string) => unknown | Promise<unknown>) =>
  vi.fn(
    async (url: RequestInfo | URL) =>
      new Response(JSON.stringify(await read(String(url)))),
  ) as unknown as typeof fetch;
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
afterEach(() => {
  vi.useRealTimers();
});

describe("public Perpl normalization", () => {
  it("resolves independent ETH/BTC precision and exact depth without fixture economics", () => {
    const eth = normalizeContext(context(), "ETH"),
      btc = normalizeContext(context(), "BTC");
    expect([eth.marketId, eth.tick, eth.lot]).toEqual([32, 10000n, 1000n]);
    expect([btc.marketId, btc.tick, btc.lot]).toEqual([16, 100000n, 10n]);
    const result = normalizeObservation(eth, ticker(), book(), at.t);
    expect(result.mark).toBe(2480670000n);
    expect(result.asks[0].lots * eth.lot).toBe(35861000n);
    expect(eth.reportedFunding).toBeUndefined();
    expect(eth.baseTakerFeePpm).toBe(345n);
  });
  it("refuses wrong environment, unsupported units, unsafe integers and missing critical fields", () => {
    const c = context();
    c.chain.chain_id = 143;
    expect(() => normalizeContext(c, "ETH")).toThrow("Wrong network");
    for (const field of ["instances", "tokens"] as const) {
      const wrong = context();
      wrong[field][0].address = `0x${"1".repeat(40)}`;
      expect(() => normalizeContext(wrong, "ETH")).toThrow("contracts");
      const missing = context();
      expect(() =>
        normalizeContext(
          {
            ...missing,
            [field]: [{ ...missing[field][0], address: undefined }],
          },
          "ETH",
        ),
      ).toThrow("contracts");
    }
    const precision = context();
    precision.markets[1].config.size_decimals = 7;
    expect(() => normalizeContext(precision, "BTC")).toThrow("precision");
    const m = normalizeContext(context(), "ETH");
    const unsafe = book();
    unsafe.ask[0].p = Number.MAX_SAFE_INTEGER + 1;
    expect(() => normalizeObservation(m, ticker(), unsafe, at.t)).toThrow(
      "exact integer",
    );
    expect(() =>
      normalizeObservation(m, { mt: 9, sn: at.b, d: {} }, book(), at.t),
    ).toThrow("selected market");
    expect(() =>
      normalizeContext({ ...context(), markets: [] }, "BTC"),
    ).toThrow("unavailable");
  });
  it("rejects malformed books, snapshot/delta confusion and incoherent source times", () => {
    const m = normalizeContext(context(), "ETH");
    for (const payload of [
      { ...book(), mt: 16 },
      { ...book(), ask: [] },
      { ...book(), ask: [book().ask[0], book().ask[0]] },
      { ...book(), at: { ...at, t: at.t - 61000 } },
    ])
      expect(() => normalizeObservation(m, ticker(), payload, at.t)).toThrow();
    // Read just now, but Perpl's own stamp is over two minutes old: not current.
    const old = normalizeObservation(m, ticker(), book(), at.t + 121000);
    expect(observationFresh(old, at.t + 121000)).toBe(false);
    // A quiet market: stamp a minute old, read just now, still current. Read long ago: not.
    const quiet = normalizeObservation(m, ticker(), book(), at.t + 60000);
    expect(observationFresh(quiet, at.t + 60000)).toBe(true);
    expect(observationFresh(quiet, at.t + 76000)).toBe(false);
    expect(observationFresh(old, at.t - 3000)).toBe(false);
  });
});

describe("public source lifecycle", () => {
  it("keeps cached snapshots stable and refuses source regressions and receipt-only freshness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at.t);
    let block = at.b;
    const source = new PerplMarketDataSource(
      undefined,
      fetcher((url) =>
        url.includes("context")
          ? context()
          : url.includes("ticker")
            ? ticker(32, block)
            : book(block),
      ),
    );
    const stop = source.subscribe(() => {});
    await flush();
    expect(source.getSnapshot().status).toBe("ready");
    const first = source.getSnapshot();
    expect(source.getSnapshot()).toBe(first);
    block--;
    await vi.advanceTimersByTimeAsync(4000);
    // An older snapshot is ignored: the newer one stays, with no error and no backoff.
    expect(source.getSnapshot().status).toBe("ready");
    expect(source.getSnapshot().observation).toMatchObject({
      ...first.observation,
      receivedAt: expect.any(Number),
    });
    expect(source.getSnapshot().error).toBeUndefined();
    block++;
    await vi.advanceTimersByTimeAsync(SOURCE_MAX_AGE_MS);
    expect(source.getSnapshot().status).toBe("stale");
    stop();
  });
  it("cancels old-market and unmounted responses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at.t);
    let resolveOld!: (value: unknown) => void;
    let firstContext = true;
    const read = fetcher((url) => {
      if (url.includes("context") && firstContext) {
        firstContext = false;
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      }
      return url.includes("context")
        ? context()
        : url.includes("ticker")
          ? ticker(16)
          : book();
    });
    const source = new PerplMarketDataSource(undefined, read);
    const listener = vi.fn();
    const stop = source.subscribe(listener);
    source.selectMarket("BTC");
    await flush();
    expect(source.getSnapshot().market).toBe("BTC");
    expect(source.getSnapshot().observation?.metadata.marketId).toBe(16);
    const current = source.getSnapshot();
    resolveOld(context());
    await flush();
    expect(source.getSnapshot()).toBe(current);
    stop();
    const calls = listener.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(listener.mock.calls.length).toBe(calls);
    expect(source.getSnapshot().status).toBe("idle");
  });
  it("never makes cached data fresh on reconnect before a valid replacement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at.t);
    let blocked = false;
    const source = new PerplMarketDataSource(
      undefined,
      fetcher((url) =>
        blocked
          ? new Promise(() => {})
          : url.includes("context")
            ? context()
            : url.includes("ticker")
              ? ticker()
              : book(),
      ),
    );
    const stop = source.subscribe(() => {});
    await flush();
    expect(source.getSnapshot().status).toBe("ready");
    stop();
    blocked = true;
    const again = source.subscribe(() => {});
    expect(source.getSnapshot().status).toBe("stale");
    again();
  });
  it("reports transport failures and retries without a second connection after cleanup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at.t);
    const read = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const source = new PerplMarketDataSource(undefined, read);
    const stop = source.subscribe(() => {});
    await flush();
    expect(source.getSnapshot().status).toBe("unavailable");
    expect(source.getSnapshot().error).toContain("CORS");
    await vi.advanceTimersByTimeAsync(8000);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

it("normalizes only real native candle data with bounded resolution, timestamps and OHLC; an empty history stays empty", async () => {
  const { candleWindow, normalizeCandles } = await import("./perpl-candles");
  const window = candleWindow("1H", 1791814000000);
  const metadata = normalizeContext(context(), "ETH");
  const candle = {
    t: window.from,
    o: 250000,
    c: 250010,
    h: 250020,
    l: 249990,
    v: "1000",
    n: 1,
  };
  const series = {
    mt: 12,
    at: { b: metadata.configBlock, t: window.to },
    r: 60,
    d: [candle],
  };
  expect(normalizeCandles(series, metadata, window).candles).toEqual([
    { time: window.from, close: 2500100000n },
  ]);
  expect(
    normalizeCandles({ ...series, d: [] }, metadata, window).candles,
  ).toEqual([]);
  for (const broken of [
    { ...series, r: 300 },
    { ...series, mt: 999 },
    { ...series, at: { b: metadata.configBlock, t: 1 } },
    { ...series, at: { b: metadata.configBlock, t: Date.now() + 86400000 } },
    { ...series, at: { b: metadata.configBlock - 1, t: window.to } },
    { ...series, d: [candle, candle] },
    { ...series, d: [{ ...candle, t: window.from - 1 }] },
    { ...series, d: [{ ...candle, h: 250000 }] },
    { ...series, d: Array(1025).fill(candle) },
  ])
    expect(() => normalizeCandles(broken, metadata, window)).toThrow();
  expect(candleWindow("1W", window.to).seconds).toBe(3600);
  const btc = normalizeContext(context(), "BTC");
  expect(
    normalizeCandles(
      {
        ...series,
        d: [{ ...candle, c: 650000, o: 650000, h: 650010, l: 649990 }],
      },
      btc,
      window,
    ).candles[0].close,
  ).toBe(65000000000n);
});
