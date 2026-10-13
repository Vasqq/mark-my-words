import type { PublicMarketMetadata } from "./perpl-market-data";
const ranges = {
  "1H": { seconds: 60, span: 3600000 },
  "1D": { seconds: 300, span: 86400000 },
  "1W": { seconds: 3600, span: 604800000 },
} as const;
export type CandleRange = keyof typeof ranges;
const object = (v: unknown) => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("Incomplete candle series.");
  return v as Record<string, unknown>;
};
const integer = (v: unknown, min = 0) => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min)
    throw Error("Invalid native candle value.");
  return v;
};
export function candleWindow(range: CandleRange, now = Date.now()) {
  const { seconds, span } = ranges[range];
  const to = Math.floor(now / (seconds * 1000)) * seconds * 1000;
  return { seconds, from: to - span, to };
}
export function normalizeCandles(
  value: unknown,
  metadata: PublicMarketMetadata,
  window: ReturnType<typeof candleWindow>,
  now = Date.now(),
) {
  const series = object(value);
  const at = object(series.at);
  if (![11, 12].includes(integer(series.mt, 1)))
    throw Error("Unexpected candle message type.");
  const block = integer(at.b, 1);
  const time = integer(at.t, 1);
  // REST emits mt12 with at.t at the newest candle OPEN, not a15-second spot-quote clock.
  // Keep the requested historical window frozen while validating its source/grid coherence.
  if (
    ![60, 300, 3600].includes(window.seconds) ||
    window.to > now + 2000 ||
    time > now + 2000 ||
    time > window.to ||
    time < window.to - window.seconds * 1000 ||
    block < metadata.configBlock ||
    time % (window.seconds * 1000)
  )
    throw Error(
      "Candle source is stale, future-dated or incoherent with the requested window.",
    );
  if (
    series.r !== window.seconds ||
    !Array.isArray(series.d) ||
    series.d.length > 1024
  )
    throw Error("Candle resolution or bounded series is invalid.");
  let previous = -1;
  const candles = series.d.map((value) => {
    const c = object(value);
    const t = integer(c.t, 1);
    const o = integer(c.o, 1),
      close = integer(c.c, 1),
      h = integer(c.h, 1),
      l = integer(c.l, 1);
    integer(c.n);
    if (
      typeof c.v !== "string" ||
      !/^\d{1,78}$/.test(c.v) ||
      t < window.from ||
      t > window.to ||
      t > time ||
      t <= previous ||
      t % (window.seconds * 1000) ||
      l > Math.min(o, close) ||
      h < Math.max(o, close) ||
      l > h
    )
      throw Error("Candle chronology or OHLC is invalid.");
    previous = t;
    return { time: t, close: BigInt(close) * metadata.tick };
  });
  return { candles, at: time, window };
}
export async function readCandles(
  metadata: PublicMarketMetadata,
  range: CandleRange,
  signal?: AbortSignal,
  fetcher = fetch,
) {
  const window = candleWindow(range);
  const response = await fetcher(
    `/perpl-public/v1/market-data/${metadata.marketId}/candles/${window.seconds}/${window.from}-${window.to}`,
    { credentials: "omit", cache: "no-store", signal },
  );
  if (!response.ok)
    throw Error(
      `Historical ${range} data unavailable (HTTP ${response.status}).`,
    );
  return normalizeCandles(await response.json(), metadata, window);
}
