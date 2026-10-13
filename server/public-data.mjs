const UPSTREAM = "https://testnet.perpl.xyz/api";
const routes = new Map([
  ["/perpl-public/v1/pub/context", 30_000],
  ...[16, 32].flatMap((id) => [
    [`/perpl-public/v1/market-data/${id}/ticker`, 4_000],
    [`/perpl-public/v1/market-data/${id}/book?levels=100`, 4_000],
  ]),
]);
const MAX_BYTES = 2_000_000;
// Perpl documents about 100 public requests a minute; stay under it across all visitors.
const BUDGET = 92;
const failure = (status, message, retry = 0) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(retry ? { "Retry-After": String(retry) } : {}),
    },
  });

/** Public snapshots only. No caller-supplied URL, headers, credentials or request body reach Perpl. */
export function createPublicDataRelay({
  fetcher = fetch,
  now = Date.now,
} = {}) {
  const cache = new Map();
  const pending = new Map();
  let requests = [];
  let cooldownUntil = 0;
  // The last two minutes of marks for the live chart, kept by one sampler for every visitor.
  // Each entry is [source time in ms, mark in native ticks]: exactly what Perpl reported.
  const recent = new Map([
    [16, []],
    [32, []],
  ]);
  // The sampler's latest full ticker. It already holds every market's state, so the
  // per-market ticker route is answered from it instead of asking Perpl a second time.
  let tickers;

  /** One upstream request for all markets. Called on a timer by the server, never by a client. */
  async function sample() {
    if (now() < cooldownUntil) return;
    requests = requests.filter((at) => now() - at < 60_000);
    if (requests.length >= BUDGET) return;
    requests.push(now());
    try {
      const upstream = await fetcher(UPSTREAM + "/v1/market-data/ticker", {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(4_000),
      });
      if (!upstream.ok) {
        if (upstream.status === 429) cooldownUntil = now() + 60_000;
        await upstream.body?.cancel();
        return;
      }
      const body = await upstream.json();
      if (body?.mt !== 9 || !body.d || typeof body.d !== "object") return;
      tickers = Number.isSafeInteger(body.sn)
        ? { at: now(), sn: body.sn, d: body.d }
        : undefined;
      for (const [market, series] of recent) {
        const state = body.d[market];
        const time = state?.at?.t;
        const mark = state?.mrk;
        if (
          !Number.isSafeInteger(time) ||
          !Number.isSafeInteger(mark) ||
          mark <= 0 ||
          time > now() + 2_000 ||
          (series.length && time <= series.at(-1)[0])
        )
          continue; // unchanged or unusable: keep what was really observed
        series.push([time, mark]);
        while (series.length && now() - series[0][0] > 150_000) series.shift();
      }
    } catch {
      /* A missed sample is a gap, never a guessed price. */
    }
  }

  async function read(path, method = "GET") {
    const live = /^\/perpl-public\/v1\/market-data\/(16|32)\/recent$/.exec(
      path,
    );
    if (live) {
      if (method !== "GET")
        return failure(405, "Only public GET requests are supported.");
      return response(JSON.stringify({ d: recent.get(Number(live[1])) }));
    }
    const candle =
      /^\/perpl-public\/v1\/market-data\/(16|32)\/candles\/(60|300|3600)\/(\d{13})-(\d{13})$/.exec(
        path,
      );
    const validCandle =
      candle &&
      Number(candle[4]) > Number(candle[3]) &&
      Number(candle[4]) <= now() + 60000 &&
      Number(candle[3]) >= now() - 8 * 86400000 &&
      (Number(candle[4]) - Number(candle[3])) / (Number(candle[2]) * 1000) <=
        1024;
    if (!routes.has(path) && !validCandle)
      return failure(404, "Unknown public data route.");
    if (method !== "GET")
      return failure(405, "Only public GET requests are supported.");
    const ticker = /^\/perpl-public\/v1\/market-data\/(16|32)\/ticker$/.exec(
      path,
    );
    const state = ticker && tickers?.d[ticker[1]];
    // Only while the sample is as fresh as this route's own cache would be; otherwise the
    // route reads Perpl itself, so a stopped sampler never serves an old price.
    if (state && typeof state === "object" && now() - tickers.at < 4_000)
      return response(
        JSON.stringify({ mt: 9, sn: tickers.sn, d: { [ticker[1]]: state } }),
      );
    const hit = cache.get(path);
    if (hit && now() < hit.expires) return response(hit.body);
    if (pending.has(path)) return (await pending.get(path)).clone();
    if (now() < cooldownUntil)
      return failure(
        429,
        "Public data cooling down.",
        Math.ceil((cooldownUntil - now()) / 1000),
      );
    requests = requests.filter((at) => now() - at < 60_000);
    if (requests.length >= BUDGET)
      return failure(429, "Public data request budget reached.", 5);
    requests.push(now());

    const request = (async () => {
      try {
        const upstream = await fetcher(
          UPSTREAM + path.slice("/perpl-public".length),
          {
            method: "GET",
            headers: { Accept: "application/json" },
            redirect: "error",
            credentials: "omit",
            signal: AbortSignal.timeout(8_000),
          },
        );
        if (!upstream.ok) {
          if (upstream.status === 429) {
            const raw = upstream.headers.get("retry-after");
            const delay =
              raw && /^\d+$/.test(raw)
                ? Number(raw) * 1000
                : raw
                  ? Date.parse(raw) - now()
                  : 60_000;
            cooldownUntil =
              now() + Math.max(1_000, Number.isFinite(delay) ? delay : 60_000);
          }
          await upstream.body?.cancel();
          return failure(
            upstream.status === 429 ? 429 : 502,
            "Perpl public data is unavailable.",
            upstream.status === 429
              ? Math.ceil((cooldownUntil - now()) / 1000)
              : 0,
          );
        }
        if (
          !upstream.headers.get("content-type")?.includes("application/json") ||
          !upstream.body
        ) {
          await upstream.body?.cancel();
          throw Error("Expected JSON");
        }
        const reader = upstream.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) throw Error("Response too large");
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        const body = Buffer.concat(chunks).toString("utf8");
        const decoded = JSON.parse(body);
        if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
          throw Error("Expected object");
        // Preserve source timestamps exactly; the client validates schema, chain and freshness.
        for (const [key, entry] of cache)
          if (entry.expires <= now()) cache.delete(key);
        if (cache.size >= 64) cache.delete(cache.keys().next().value);
        // A candle window is fixed by its path; only its newest candle is still moving.
        // Hold it for one candle, ten minutes at most, rather than re-reading each minute.
        const hold =
          routes.get(path) ?? Math.min(Number(candle[2]) * 1000, 600_000);
        cache.set(path, { body, expires: now() + hold });
        return response(body);
      } catch {
        return failure(502, "Perpl public data could not be read.");
      }
    })();
    // A stalled upstream body must never leave this route waiting forever: every later
    // caller would join the same promise.
    let timer;
    const bounded = Promise.race([
      request,
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve(failure(502, "Perpl public data timed out.")),
          10_000,
        );
      }),
    ]);
    pending.set(path, bounded);
    try {
      return (await bounded).clone();
    } finally {
      clearTimeout(timer);
      pending.delete(path);
    }
  }
  return Object.assign(read, { sample });
}

function response(body) {
  // Browser/CDN caching must not make a source observation appear newly fetched.
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
