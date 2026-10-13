import test from "node:test";
import assert from "node:assert/strict";
import { createAccountRelay } from "./account-api.mjs";

const appOrigin = "http://localhost:3000";
const owner = `0x${"1".repeat(40)}`;
const payload = () => ({
  chain_id: 10143,
  address: owner,
  public_key: `0x${"2".repeat(64)}`,
  scope_mask: 2,
  label: "Testnet session",
  expires_at: Date.now() + 3_500_000,
});
const request = (
  route = "payload",
  body = payload(),
  headers = {},
  method = "POST",
) =>
  new Request(appOrigin + "/perpl-account/" + route, {
    method,
    headers: {
      Host: "localhost:3000",
      Origin: appOrigin,
      "Content-Type": "application/json",
      "X-Perpl-Client": "1",
      ...headers,
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
const json = (body) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });

test("account routes require the configured app origin and forward only bounded, fixed testnet requests", async () => {
  const calls = [];
  const relay = createAccountRelay({
    appOrigin,
    fetcher: async (...args) => {
      calls.push(args);
      return json({ typed_data: {}, mac: "opaque" });
    },
  });
  assert.equal((await createAccountRelay()(request())).status, 503);
  for (const headers of [
    { Origin: "https://evil.example" },
    { Origin: "" },
    { Host: "evil.example" },
    { "Sec-Fetch-Site": "cross-site" },
    { "X-Perpl-Client": "" },
    { "Content-Type": "text/plain" },
  ])
    assert.equal(
      (await relay(request("payload", payload(), headers))).status,
      403,
    );
  assert.equal((await relay(request("payload", null, {}, "GET"))).status, 405);
  assert.equal(
    (await relay(request("payload?url=https://evil.example"))).status,
    404,
  );
  assert.equal((await relay(request("submit-orders"))).status, 400);
  for (const body of [
    null,
    [],
    { ...payload(), chain_id: 143 },
    { ...payload(), scope_mask: 7 },
    { ...payload(), expires_at: 0 },
    { ...payload(), target_profile: owner },
    { ...payload(), public_key: "invalid" },
    { ...payload(), address: [owner] },
    { ...payload(), label: "x".repeat(17000) },
  ])
    assert.equal((await relay(request("payload", body))).status, 400);
  assert.equal(calls.length, 0);
  const response = await relay(
    request("payload", payload(), {
      Cookie: "do-not-forward",
      Authorization: "do-not-forward",
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(calls[0][0], "https://testnet.perpl.xyz/api/v1/api-key/payload");
  assert.deepEqual(calls[0][1].headers, {
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(calls[0][1].credentials, "omit");
  const enroll = {
    chain_id: 10143,
    address: owner,
    typed_data: {
      primaryType: "PerplRegisterApiKey",
      domain: { chainId: "0x279f" },
      message: {
        signer: owner,
        scope: "3",
        label: "Testnet session",
        origin: "",
        builderId: "0",
        maxBuilderFeePer100K: "0",
        ipCidrs: "",
        expiresAt: String(Date.now() + 3500000),
      },
    },
    mac: "opaque",
    signature: `0x${"3".repeat(130)}`,
    pop_signature: `0x${"4".repeat(128)}`,
  };
  assert.equal((await relay(request("enroll", enroll))).status, 200);
  assert.equal(calls[1][0], "https://testnet.perpl.xyz/api/v1/api-key/enroll");
  assert.equal(
    (
      await relay(
        request("enroll", {
          ...enroll,
          typed_data: {
            ...enroll.typed_data,
            message: { ...enroll.typed_data.message, signer: 4 },
          },
        }),
      )
    ).status,
    400,
  );
  const signed = {
    key: "test-key",
    timestamp: String(Date.now()),
    nonce: "a".repeat(22),
    signature: "b".repeat(86),
  };
  assert.equal((await relay(request("verify", signed))).status, 200);
  assert.equal(
    calls[2][0],
    "https://testnet.perpl.xyz/api/v1/trading/fills?count=1",
  );
  assert.equal(calls[2][1].method, "GET");
  assert.equal(calls[2][1].body, undefined);
  assert.equal(calls[2][1].headers["X-API-Key"], "test-key");
  assert.equal(calls[2][1].headers.Origin, undefined);
  for (const route of ["wallet", "positions", "orders"]) {
    assert.equal((await relay(request(route, signed))).status, 200);
    assert.equal(
      calls.at(-1)[0],
      `https://testnet.perpl.xyz/api/v1/trading/${route}`,
    );
    assert.equal(calls.at(-1)[1].method, "GET");
    assert.equal(calls.at(-1)[1].body, undefined);
    assert.equal(
      (await relay(request(route, { ...signed, d: [] }))).status,
      400,
    );
  }
  for (const route of [
    "order-history",
    "fills",
    "account-history",
    "position-history",
  ]) {
    const cursor = "opaque+/=cursor";
    assert.equal(
      (await relay(request(route, { ...signed, page: cursor }))).status,
      200,
    );
    assert.equal(
      calls.at(-1)[0],
      `https://testnet.perpl.xyz/api/v1/trading/${route}?count=100&page=opaque%2B%2F%3Dcursor`,
    );
    assert.equal(calls.at(-1)[1].method, "GET");
    assert.equal(calls.at(-1)[1].body, undefined);
    for (const invalid of [
      { ...signed, page: "a".repeat(513) },
      { ...signed, count: 1000 },
      { ...signed, target: "https://evil.example" },
    ])
      assert.equal((await relay(request(route, invalid))).status, 400);
  }
  assert.equal(
    (await relay(request("wallet", { ...signed, page: "cursor" }))).status,
    400,
  );
});

test("account relay bounds traffic and response size, and never retries or exposes upstream error content", async () => {
  let calls = 0;
  const limited = createAccountRelay({
    appOrigin,
    fetcher: async () => {
      calls++;
      return json({});
    },
  });
  for (let i = 0; i < 96; i++)
    assert.equal((await limited(request())).status, 200);
  assert.equal((await limited(request())).status, 429);
  assert.equal(calls, 96);
  const signed = {
    key: "fixture",
    timestamp: String(Date.now()),
    nonce: "a".repeat(22),
    signature: "b".repeat(86),
  };
  // Each user has their own minute window: another key is not starved by the first.
  for (let i = 0; i < 104; i++)
    assert.equal(
      (
        await limited(
          request("wallet", signed, { "X-Perpl-Priority": "recovery" }),
        )
      ).status,
      200,
    );
  assert.equal(
    (
      await limited(
        request("orders", signed, { "X-Perpl-Priority": "recovery" }),
      )
    ).status,
    429,
  );
  assert.equal(
    (
      await limited(
        request("payload", payload(), { "X-Perpl-Priority": "write" }),
      )
    ).status,
    429,
  );
  assert.equal(calls, 200);
  // Order writes keep the last slots up to 54.
  const order = JSON.stringify({
    d: [
      {
        rq: 1,
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
    ],
  });
  for (let i = 0; i < 6; i++)
    assert.equal(
      (await limited(request("submit-orders", { ...signed, body: order })))
        .status,
      200,
    );
  assert.equal(
    (await limited(request("submit-orders", { ...signed, body: order })))
      .status,
    429,
  );
  assert.equal(calls, 206);
  for (const upstream of [
    () => new Response("credential-like diagnostic", { status: 400 }),
    () => json({ large: "a".repeat(140000) }),
    () => new Response("not json"),
    () => {
      throw Error("lost response");
    },
  ]) {
    let attempts = 0;
    const relay = createAccountRelay({
      appOrigin,
      fetcher: async () => {
        attempts++;
        return upstream();
      },
    });
    const response = await relay(request());
    assert(response.status >= 400);
    assert.equal(attempts, 1);
    assert(!(await response.text()).includes("credential-like"));
  }
});

test("order relay validates exact bounded ETH/BTC direction payloads and forwards them upstream", async () => {
  const { validateOrderBody, orderCapabilityEnabled, executionCapabilities } =
    await import("./order-wire.mjs");
  const calls = [];
  const relay = createAccountRelay({
    appOrigin,
    fetcher: async (...args) => {
      calls.push(args);
      return json({});
    },
  });
  const order = {
    rq: 1,
    acc: 1057,
    mkt: 32,
    t: 1,
    p: 250000,
    s: 20,
    lv: 300,
    fl: 4,
    mnp: 50,
    lb: 120,
  };
  const signed = (p) => ({
    key: "fixture",
    timestamp: String(Date.now()),
    nonce: "a".repeat(22),
    signature: "b".repeat(86),
    body: JSON.stringify({ d: [p] }),
  });
  const cancel = {
    rq: 4,
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
  };
  const amend = { ...cancel, rq: 5, t: 7, s: 10, p: 252810 };
  for (const p of [
    amend,
    cancel,
    order,
    { ...order, mkt: 16 },
    { ...order, mkt: 16, t: 2 },
    { ...amend, mkt: 16, p: 255350, tpc: 4 },
    { ...amend, mkt: 16, t: 4, oid: undefined, mnp: 0, p: 255350, tpc: 4 },
    {
      rq: 2,
      acc: 1057,
      mkt: 32,
      t: 3,
      p: 240000,
      s: 10,
      lv: 0,
      fl: 4,
      mnp: 0,
      lb: 120,
    },
    {
      rq: 3,
      acc: 1057,
      mkt: 32,
      t: 3,
      p: 298500,
      s: 10,
      lv: 0,
      fl: 4,
      mnp: 0,
      lb: 0,
      tp: 300000,
      tpc: 3,
      lp: 9,
    },
  ]) {
    assert.equal(validateOrderBody(signed(p).body), signed(p).body);
    assert.equal(orderCapabilityEnabled(signed(p).body), true);
    assert.equal(
      (await relay(request("submit-orders", signed(p)))).status,
      200,
    );
  }
  assert.equal(calls.length, 9);
  calls.length = 0;
  for (const change of [
    { mkt: 99 },
    { t: 6 },
    { p: 0 },
    { mnp: 1000 },
    { s: 1.5 },
    { bf: 0 },
    { lb: 0 },
    { enabled: true },
  ])
    assert.equal(
      (await relay(request("submit-orders", signed({ ...order, ...change }))))
        .status,
      400,
    );
  for (const invalid of [
    {
      rq: 4,
      acc: 1057,
      mkt: 32,
      t: 5,
      oid: cancel.oid,
      s: 0,
      fl: 0,
      lv: 0,
      lb: 120,
    },
    { ...cancel, fl: 0 },
    { ...cancel, lv: 100 },
    { ...cancel, tp: 0 },
    { ...cancel, tpc: 1 },
    { ...cancel, lp: 0 },
    { ...cancel, lb: 120 },
  ])
    assert.throws(() => validateOrderBody(signed(invalid).body));
  for (const invalid of [
    { ...amend, mnp: 0 },
    { ...amend, p: 0 },
    { ...amend, s: 0 },
    { ...amend, oid: 0 },
    { ...amend, lp: 0 },
    { ...amend, tpc: 1 },
  ])
    assert.throws(() => validateOrderBody(signed(invalid).body));
  const collateral = {
    rq: 6,
    acc: 1057,
    mkt: 32,
    t: 6,
    s: 0,
    lv: 0,
    fl: 4,
    lb: 0,
    a: "1000000",
    lp: 99,
  };
  for (const p of [collateral, { ...collateral, mkt: 16 }]) {
    assert.equal(validateOrderBody(signed(p).body), signed(p).body);
    assert.equal(orderCapabilityEnabled(signed(p).body), true);
  }
  for (const invalid of [
    { ...order, a: "1000000" },
    { ...cancel, a: "1000000" },
    { ...order, a: 1000000 },
    { ...collateral, a: "0" },
    { ...collateral, a: "01" },
    { ...collateral, a: "1.5" },
    { ...collateral, a: "-1" },
    { ...collateral, a: " 1" },
    { ...collateral, a: "1".repeat(16) },
    { ...collateral, a: 1000000 },
    { ...collateral, a: undefined },
    { ...collateral, lp: 0 },
    { ...collateral, lp: undefined },
    { ...collateral, s: 1 },
    { ...collateral, lv: 300 },
    { ...collateral, fl: 0 },
    { ...collateral, lb: 120 },
    { ...collateral, p: 250000 },
    { ...collateral, mnp: 0 },
    { ...collateral, oid: 5 },
    { ...collateral, tp: 250000, tpc: 3 },
  ])
    assert.throws(() => validateOrderBody(signed(invalid).body));
  assert.throws(() => validateOrderBody('{"d":[{"rq":1,"rq":2}]}'));
  assert.throws(() => validateOrderBody(JSON.stringify({ d: [order, order] })));
  assert.deepEqual(calls, []);
});
