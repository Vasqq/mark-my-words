/** Presentation-only series maths for the live chart. Prices here are display dollars. */
export interface Sample {
  time: number; // ms
  price: number;
}

/** The artifact's chart advances one point every 600 ms and keeps 160 of them (96 s). */
export const TICK_MS = 600;
export const WINDOW_TICKS = 160;

/**
 * The price at `time` on the straight line between the two real samples around it.
 * Before the first sample or after the last it holds that sample: it never extrapolates.
 */
export function priceAt(samples: readonly Sample[], time: number): number {
  if (!samples.length) return NaN;
  if (time <= samples[0].time) return samples[0].price;
  for (let i = 1; i < samples.length; i++) {
    const next = samples[i];
    if (time > next.time) continue;
    const previous = samples[i - 1];
    const span = next.time - previous.time;
    return span <= 0
      ? next.price
      : previous.price +
          ((next.price - previous.price) * (time - previous.time)) / span;
  }
  return samples[samples.length - 1].price;
}

/**
 * How far behind real time the line is drawn. Perpl's testnet mark changes every few seconds,
 * so drawing one update behind lets the line glide into each new price instead of jumping.
 */
export function playbackDelay(samples: readonly Sample[]): number {
  const n = samples.length;
  const gap = n > 1 ? samples[n - 1].time - samples[n - 2].time : 4000;
  return Math.min(8000, Math.max(2000, gap));
}

/** The window of evenly spaced points ending at `end`, read off the real samples. */
export function windowAt(samples: readonly Sample[], end: number): number[] {
  return Array.from({ length: WINDOW_TICKS }, (_, i) =>
    priceAt(samples, end - (WINDOW_TICKS - 1 - i) * TICK_MS),
  );
}

/**
 * A curve through every real point (Catmull-Rom), resampled to `count` points so a range of
 * sixty candles draws as a line rather than sixty corners. It passes through each close.
 */
export function smooth(points: readonly Sample[], count = 240): Sample[] {
  const n = points.length;
  if (n < 3) return [...points];
  const at = (i: number) => points[Math.min(n - 1, Math.max(0, i))];
  return Array.from({ length: count }, (_, k) => {
    const x = (k * (n - 1)) / (count - 1);
    const i = Math.min(n - 2, Math.floor(x));
    const t = x - i;
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)].map(
      (p) => p.price,
    );
    const price =
      0.5 *
      (2 * p1 +
        (p2 - p0) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
        (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
    return {
      price,
      time: at(i).time + (at(i + 1).time - at(i).time) * t,
    };
  });
}
