import { useEffect, useRef, useState } from "react";
import type { MarketId } from "../../../financial-model";
import {
  playbackDelay,
  priceAt,
  TICK_MS,
  windowAt,
  type Sample,
} from "./chart-series";

const markets = { ETH: 32, BTC: 16 } as const;
const ids = Object.keys(markets) as MarketId[];
const READ_MS = 2000;

interface Line {
  samples: Sample[]; // real marks, on this browser's clock
  skew?: number; // this clock minus Perpl's, fixed at the first read
}

/**
 * The live chart's line: real Perpl marks, drawn one update behind so each new price is
 * glided into, and advanced every 600 ms like the reference chart. It never invents a
 * price; between real updates it follows the straight line between them or holds.
 *
 * `tick` is micro AUSD per native price tick for each market, `older` optional earlier
 * closes used only to fill the first seconds after the server starts.
 */
export function useLiveLine(
  tick: Record<MarketId, bigint | undefined>,
  older: Record<MarketId, readonly Sample[]>,
) {
  const lines = useRef<Record<MarketId, Line>>({
    ETH: { samples: [] },
    BTC: { samples: [] },
  });
  const [state, setState] = useState<{
    count: number;
    mark: Record<MarketId, number>;
    seed: Partial<Record<MarketId, number[]>>;
  }>({ count: 0, mark: { ETH: NaN, BTC: NaN }, seed: {} });
  const inputs = useRef({ tick, older });
  inputs.current = { tick, older };

  useEffect(() => {
    let stopped = false;
    const read = async (id: MarketId) => {
      const unit = inputs.current.tick[id];
      if (unit === undefined) return;
      const response = await fetch(
        `/perpl-public/v1/market-data/${markets[id]}/recent`,
        { credentials: "omit", cache: "no-store" },
      );
      if (!response.ok) return;
      const body: unknown = await response.json();
      const rows = (body as { d?: unknown })?.d;
      if (!Array.isArray(rows) || stopped) return;
      const line = lines.current[id];
      const parsed: Sample[] = [];
      for (const row of rows) {
        if (
          !Array.isArray(row) ||
          !Number.isSafeInteger(row[0]) ||
          !Number.isSafeInteger(row[1]) ||
          row[1] <= 0
        )
          return; // one bad row discards the read; nothing is guessed
        parsed.push({
          time: row[0] as number,
          price: Number(BigInt(row[1] as number) * unit) / 1e6,
        });
      }
      if (!parsed.length) return;
      line.skew ??= Date.now() - parsed[parsed.length - 1].time;
      line.samples = parsed.map((s) => ({ ...s, time: s.time + line.skew! }));
    };
    const poll = () =>
      void Promise.all(ids.map((id) => read(id).catch(() => {})));
    poll();
    const reader = setInterval(poll, READ_MS);
    const ticker = setInterval(() => {
      const now = Date.now();
      setState((previous) => {
        const mark = { ...previous.mark };
        const seed = { ...previous.seed };
        for (const id of ids) {
          const { samples, skew } = lines.current[id];
          if (!samples.length) continue;
          const at = now - playbackDelay(samples);
          mark[id] = priceAt(samples, at);
          if (!seed[id]) {
            const before = inputs.current.older[id]
              .map((s) => ({ ...s, time: s.time + (skew ?? 0) }))
              .filter((s) => s.time < samples[0].time);
            seed[id] = windowAt([...before, ...samples], at);
          }
        }
        return { count: previous.count + 1, mark, seed };
      });
    }, TICK_MS);
    return () => {
      stopped = true;
      clearInterval(reader);
      clearInterval(ticker);
    };
  }, []);
  return state;
}
