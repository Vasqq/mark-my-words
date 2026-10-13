import test from "node:test";
import assert from "node:assert/strict";
import { createPublicDataRelay } from "./public-data.mjs";
const path = "/perpl-public/v1/market-data/32/book?levels=100";
const json = (body) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });

test("only fixed public GET routes reach the upstream, without caller authority", async () => {
  const calls = [];
  const relay = createPublicDataRelay({
    fetcher: async (...args) => {
      calls.push(args);
      return json({ at: { t: 123 } });
    },
  });
  for (const forbidden of [
    "/perpl-public/v1/trading/orders",
    path + "&url=https://example.com",
    "/perpl-public/v1/market-data/1/ticker",
    "/perpl-public/v1/api-key/enroll",
  ])
    assert.equal((await relay(forbidden)).status, 404);
  assert.equal((await relay(path, "POST")).status, 405);
  assert.equal(calls.length, 0);
  assert.equal((await relay(path)).status, 200);
  assert.equal(
    calls[0][0],
    "https://testnet.perpl.xyz/api/v1/market-data/32/book?levels=100",
  );
  assert.deepEqual(calls[0][1].headers, { Accept: "application/json" });
  assert.equal(calls[0][1].redirect, "error");
});

test("coalesces concurrent readers, preserves source time and never serves expired data after failure", async () => {
  let clock = 0,
    calls = 0,
    release;
  const relay = createPublicDataRelay({
    now: () => clock,
    fetcher: async () => {
      calls++;
      if (calls > 1) throw Error("offline");
      await new Promise((resolve) => {
        release = resolve;
      });
      return json({ at: { t: 123 } });
    },
  });
  const a = relay(path),
    b = relay(path);
  release();
  assert.deepEqual(await (await a).json(), { at: { t: 123 } });
  assert.deepEqual(await (await b).json(), { at: { t: 123 } });
  assert.equal((await relay(path)).status, 200);
  assert.equal(calls, 1);
  clock = 4001;
  assert.equal((await relay(path)).status, 502);
  assert.equal(calls, 2);
});

test("honors upstream cooldown and rejects malformed or oversized data without caching it", async () => {
  let clock = 0,
    calls = 0;
  const relay = createPublicDataRelay({
    now: () => clock,
    fetcher: async () => {
      calls++;
      if (calls === 1)
        return new Response(null, {
          status: 429,
          headers: { "Retry-After": "10" },
        });
      if (calls === 2) return new Response("<html>gateway error</html>");
      if (calls === 3) return json({ data: "a".repeat(2_000_001) });
      return json({ at: { t: 456 } });
    },
  });
  assert.equal((await relay(path)).status, 429);
  assert.equal((await relay(path)).status, 429);
  assert.equal(calls, 1);
  clock = 10001;
  assert.equal((await relay(path)).status, 502);
  assert.equal((await relay(path)).status, 502);
  assert.equal((await relay(path)).status, 200);
});

test("bounds official candle windows and shares caching/coalescing with the fixed public budget", async () => {
  const now = 1791814000000;
  let calls = 0;
  const relay = createPublicDataRelay({
    now: () => now,
    fetcher: async (url) => {
      calls++;
      assert.match(
        url,
        /^https:\/\/testnet.perpl.xyz\/api\/v1\/market-data\/32\/candles\/60\//,
      );
      return json({ mt: 18, r: 60, at: { b: 100, t: now }, d: [] });
    },
  });
  const valid = `/perpl-public/v1/market-data/32/candles/60/${now - 3600000}-${now}`;
  const responses = await Promise.all([relay(valid), relay(valid)]);
  assert.equal(responses[0].status, 200);
  assert.equal(responses[1].status, 200);
  assert.deepEqual(await responses[0].json(), await responses[1].json());
  assert.equal(calls, 1);
  for (const invalid of [
    valid + "?url=evil",
    valid.replace("/32/", "/1/"),
    valid.replace("/60/", "/30/"),
    `/perpl-public/v1/market-data/32/candles/60/${now - 1025 * 60000}-${now}`,
    `/perpl-public/v1/market-data/32/candles/60/${now}-${now - 1}`,
  ])
    assert.equal((await relay(invalid)).status, 404);
});

test("answers a market's ticker from the shared sample and holds a candle window for its candle", async () => {
  let now = 1791814000000;
  const calls = [];
  const relay = createPublicDataRelay({
    now: () => now,
    fetcher: async (url) => {
      calls.push(url);
      return json(
        url.endsWith("/market-data/ticker")
          ? {
              mt: 9,
              sn: 120,
              d: {
                16: { at: { b: 119, t: now }, mrk: 830000 },
                32: { at: { b: 120, t: now }, mrk: 250000 },
              },
            }
          : { mt: 12, r: 3600, at: { b: 100, t: now }, d: [] },
      );
    },
  });
  await relay.sample();
  const ticker = await relay("/perpl-public/v1/market-data/16/ticker");
  assert.deepEqual(await ticker.json(), {
    mt: 9,
    sn: 120,
    d: { 16: { at: { b: 119, t: now }, mrk: 830000 } },
  });
  assert.equal(calls.length, 1);
  // An old sample is never served: the route reads Perpl itself.
  now += 4_000;
  await relay("/perpl-public/v1/market-data/16/ticker");
  assert.equal(calls.length, 2);

  const week = `/perpl-public/v1/market-data/16/candles/3600/${now - 7 * 86400000}-${now}`;
  await relay(week);
  now += 9 * 60_000;
  await relay(week);
  assert.equal(calls.length, 3);
  now += 2 * 60_000;
  await relay(week);
  assert.equal(calls.length, 4);
});
