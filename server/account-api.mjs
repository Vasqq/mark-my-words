import { createHash } from "node:crypto";
import {
  executionEnabled,
  orderCapabilityEnabled,
  validateOrderBody,
} from "./order-wire.mjs";
const upstream = "https://testnet.perpl.xyz/api";
const address = /^0x[\da-f]{40}$/i;
const hex = (value, bytes) =>
  typeof value === "string" &&
  new RegExp(`^0x[\\da-f]{${bytes * 2}}$`, "i").test(value);
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const keys = (value, names) =>
  object(value) && Object.keys(value).sort().join() === names.sort().join();
const reply = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

async function limitedJson(body, limit) {
  if (!body) throw Error("Missing body");
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error("Body too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Fixed testnet enrollment, signed read and bounded order routes; no signer or credential store. */
export function createAccountRelay({
  appOrigin,
  fetcher = fetch,
  now = Date.now,
} = {}) {
  const origin = appOrigin ? new URL(appOrigin) : null;
  if (
    origin &&
    (origin.origin !== appOrigin ||
      !["http:", "https:"].includes(origin.protocol))
  )
    throw Error("PERPL_APP_ORIGIN must be an exact HTTP(S) origin.");
  // Perpl limits each key, so each user gets their own minute window. Keyed by a digest:
  // the relay never stores a credential.
  const windows = new Map();

  return async function accountApi(request) {
    const path = new URL(request.url).pathname + new URL(request.url).search;
    let route = {
      "/perpl-account/payload": "/v1/api-key/payload",
      "/perpl-account/enroll": "/v1/api-key/enroll",
      "/perpl-account/verify": "/v1/trading/fills?count=1",
      "/perpl-account/wallet": "/v1/trading/wallet",
      "/perpl-account/positions": "/v1/trading/positions",
      "/perpl-account/orders": "/v1/trading/orders",
      "/perpl-account/submit-orders": "/v1/trading/orders",
      "/perpl-account/order-history": "/v1/trading/order-history",
      "/perpl-account/fills": "/v1/trading/fills",
      "/perpl-account/account-history": "/v1/trading/account-history",
      "/perpl-account/position-history": "/v1/trading/position-history",
    }[path];
    if (!route) return reply(404, { error: "Unknown account route." });
    if (!origin)
      return reply(503, {
        error: "Account API is not configured on this server.",
      });
    if (request.method !== "POST")
      return reply(405, { error: "POST required." });
    if (
      request.headers.get("origin") !== appOrigin ||
      request.headers.get("host") !== origin.host ||
      request.headers.get("x-perpl-client") !== "1" ||
      !/^application\/json(?:;|$)/i.test(
        request.headers.get("content-type") ?? "",
      ) ||
      (request.headers.has("sec-fetch-site") &&
        request.headers.get("sec-fetch-site") !== "same-origin")
    )
      return reply(403, {
        error: "Account requests must come from this app origin.",
      });
    let body;
    try {
      body = await limitedJson(request.body, 16_384);
    } catch {
      return reply(400, { error: "Invalid account request." });
    }
    const headers = { Accept: "application/json" };
    let method = "POST";
    let orderBody;
    if (path.endsWith("/payload")) {
      if (
        !keys(body, [
          "chain_id",
          "address",
          "public_key",
          "scope_mask",
          "label",
          "expires_at",
        ]) ||
        body.chain_id !== 10143 ||
        typeof body.address !== "string" ||
        !address.test(body.address) ||
        !hex(body.public_key, 32) ||
        body.scope_mask !== 2 ||
        body.label !== "Testnet session" ||
        !Number.isSafeInteger(body.expires_at) ||
        body.expires_at <= now() ||
        body.expires_at > now() + 86_400_000
      )
        return reply(400, { error: "Invalid enrollment parameters." });
    } else if (path.endsWith("/enroll")) {
      const message = body?.typed_data?.message;
      if (
        !keys(body, [
          "chain_id",
          "address",
          "typed_data",
          "mac",
          "signature",
          "pop_signature",
        ]) ||
        body.chain_id !== 10143 ||
        typeof body.address !== "string" ||
        !address.test(body.address) ||
        typeof body.mac !== "string" ||
        !body.mac ||
        body.mac.length > 2048 ||
        !hex(body.signature, 65) ||
        !hex(body.pop_signature, 64) ||
        body.typed_data?.primaryType !== "PerplRegisterApiKey" ||
        ![10143, "10143", "0x279f"].includes(
          body.typed_data?.domain?.chainId,
        ) ||
        !object(message) ||
        typeof message.signer !== "string" ||
        message.signer.toLowerCase() !== body.address.toLowerCase() ||
        message.scope !== "3" ||
        message.label !== "Testnet session" ||
        message.origin !== "" ||
        message.builderId !== "0" ||
        message.maxBuilderFeePer100K !== "0" ||
        message.ipCidrs !== "" ||
        typeof message.expiresAt !== "string" ||
        !/^\d{13}$/.test(message.expiresAt) ||
        Number(message.expiresAt) <= now() ||
        Number(message.expiresAt) > now() + 86_400_000
      )
        return reply(400, { error: "Invalid enrollment proof." });
    } else {
      const mutation = path.endsWith("/submit-orders");
      const history = [
        "/perpl-account/order-history",
        "/perpl-account/fills",
        "/perpl-account/account-history",
        "/perpl-account/position-history",
      ].includes(path);
      const page = object(body) ? body.page : undefined;
      if (
        page !== undefined &&
        (!history ||
          typeof page !== "string" ||
          !/^[\x21-\x7e]{1,512}$/.test(page))
      )
        return reply(400, { error: "Invalid history cursor." });
      if (history) {
        const query = new URLSearchParams({ count: "100" });
        if (page !== undefined) query.set("page", page);
        route += `?${query}`;
      }
      if (
        !keys(body, [
          "key",
          "timestamp",
          "nonce",
          "signature",
          ...(page === undefined ? [] : ["page"]),
          ...(mutation ? ["body"] : []),
        ]) ||
        typeof body.key !== "string" ||
        !/^[\x21-\x7e]{1,4096}$/.test(body.key) ||
        typeof body.timestamp !== "string" ||
        typeof body.nonce !== "string" ||
        typeof body.signature !== "string" ||
        !/^\d{13}$/.test(body.timestamp) ||
        Math.abs(Number(body.timestamp) - now()) > 30_000 ||
        !/^[\w-]{22}$/.test(body.nonce) ||
        !/^[\w-]{86}$/.test(body.signature)
      )
        return reply(400, { error: "Invalid signed read." });
      if (mutation) {
        try {
          orderBody = validateOrderBody(body.body);
        } catch {
          return reply(400, { error: "Invalid bounded testnet order." });
        }
        if (!(executionEnabled && orderCapabilityEnabled(orderBody)))
          return reply(503, { error: "Order execution is unavailable." });
      }
      method = mutation ? "POST" : "GET";
      headers["X-API-Key"] = body.key;
      headers["X-API-Timestamp"] = body.timestamp;
      headers["X-API-Nonce"] = body.nonce;
      headers["X-API-Signature"] = body.signature;
    }
    const subject = createHash("sha256")
      .update(typeof body.key === "string" ? body.key : String(body.address))
      .digest("hex");
    for (const [key, times] of windows)
      if (!times.some((at) => now() - at < 60_000)) windows.delete(key);
    if (!windows.has(subject) && windows.size >= 2048)
      return reply(429, { error: "Account relay is busy. Wait a minute." });
    const requests = (windows.get(subject) ?? []).filter(
      (at) => now() - at < 60_000,
    );
    windows.set(subject, requests);
    const priority = request.headers.get("x-perpl-priority") ?? "observation";
    if (!["observation", "recovery", "write"].includes(priority))
      return reply(400, { error: "Invalid request priority." });
    // Perpl documents "about 60" authenticated requests a minute as approximate and says
    // HTTP 429 is the real signal. Opening a position and registering its stop and target
    // needs more than 60 reads in that first minute, and throttling ourselves there delays
    // the stop. So this ceiling only stops a runaway client; a 429 from Perpl is handled
    // as a refusal. Order writes, then recovery, go before background reads.
    const ceiling = path.endsWith("/submit-orders")
      ? 110
      : priority === "recovery" &&
          !["/perpl-account/payload", "/perpl-account/enroll"].includes(path)
        ? 104
        : 96;
    if (requests.length >= ceiling)
      return reply(429, {
        error: "Account request limit reached. Wait a minute.",
      });
    requests.push(now());
    try {
      // No Origin upstream: observed testnet behavior, separately guarded by the app-origin checks above.
      const response = await fetcher(upstream + route, {
        method,
        headers: {
          ...headers,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(method === "POST"
          ? { body: orderBody ?? JSON.stringify(body) }
          : {}),
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return reply(
          response.status >= 400 && response.status < 500
            ? response.status
            : 502,
          { error: `Perpl returned HTTP ${response.status}.` },
        );
      }
      if (!response.headers.get("content-type")?.includes("application/json")) {
        await response.body?.cancel();
        throw Error("Expected JSON");
      }
      const result = await limitedJson(response.body, 131_072);
      return reply(200, result);
    } catch {
      return reply(502, {
        error:
          "Perpl response could not be verified. Enrollment or an order may have completed; do not automatically retry.",
      });
    }
  };
}
