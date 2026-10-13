import { describe, expect, it } from "vitest";
import {
  playbackDelay,
  priceAt,
  smooth,
  TICK_MS,
  WINDOW_TICKS,
  windowAt,
} from "./chart-series";

const samples = [
  { time: 0, price: 100 },
  { time: 4000, price: 104 },
  { time: 10000, price: 101 },
];

describe("live chart series", () => {
  it("reads a price off the straight line between two real samples and never extrapolates", () => {
    expect(priceAt(samples, 1000)).toBe(101);
    expect(priceAt(samples, 7000)).toBe(102.5);
    expect(priceAt(samples, -5000)).toBe(100);
    expect(priceAt(samples, 99999)).toBe(101);
    expect(priceAt([], 0)).toBeNaN();
  });

  it("draws one update behind, within two to eight seconds", () => {
    expect(playbackDelay(samples)).toBe(6000);
    expect(playbackDelay([samples[0]])).toBe(4000);
    expect(playbackDelay([samples[0], { time: 500, price: 1 }])).toBe(2000);
    expect(playbackDelay([samples[0], { time: 60000, price: 1 }])).toBe(8000);
  });

  it("builds the seed window at the chart's tick spacing, ending at the requested time", () => {
    const window = windowAt(samples, 10000);
    expect(window).toHaveLength(WINDOW_TICKS);
    expect(window.at(-1)).toBe(101);
    expect(window.at(-2)).toBeCloseTo(priceAt(samples, 10000 - TICK_MS));
    expect(window[0]).toBe(100);
  });

  it("smooths a range into a curve that still passes through every real close", () => {
    const curve = smooth(samples, 201);
    expect(curve).toHaveLength(201);
    expect(curve[0].price).toBe(100);
    expect(curve[100].price).toBeCloseTo(104);
    expect(curve[200].price).toBeCloseTo(101);
    expect(smooth(samples.slice(0, 2))).toHaveLength(2);
  });
});
