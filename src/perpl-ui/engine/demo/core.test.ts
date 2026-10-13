import source from "../../../../docs/frontend/reference/source/core.js?raw";
import { describe, it, expect } from "vitest";
import { compute, fmtUsd, fmtP, MK } from "./core";
import type { DemoDraft as Draft } from "./core";
function reference(draft: Draft, free: number) {
  const evaluate = new Function(
    "draft",
    "marks",
    "free",
    source +
      "\nreturn JSON.stringify({calculation:compute(draft,marks,free),formatted:[fmtUsd(-0.001,2,true),fmtUsd(1234.56),fmtP(marks[draft.market],MK[draft.market])]});",
  );
  return JSON.parse(evaluate(draft, { ETH: 2478.4, BTC: 61842.5 }, free));
}
const draft: Draft = {
  market: "ETH",
  side: "long",
  goal: 500,
  target: 3100,
  budget: 800,
  stop: 2404.05,
  lev: 3,
  rev: 1,
};
describe("reference demo financial boundaries", () => {
  for (const [label, patch, free] of [
    ["long fees", {}, 800],
    ["invalid long target", { target: 2000 }, 800],
    ["short fees", { side: "short", target: 2000, stop: 2600 }, 800],
    ["shortfall", { budget: 20 }, 20],
    ["minimum goal", { goal: 0.01 }, 800],
    ["depth boundary", { goal: 10000000 }, 800],
    ["BTC units", { market: "BTC", target: 70000, stop: 59000 }, 800],
  ] as const) {
    it(label, () => {
      const d = { ...draft, ...patch };
      const expected = reference(d, free);
      const actual = {
        calculation: compute(d, { ETH: 2478.4, BTC: 61842.5 }, free),
        formatted: [
          fmtUsd(-0.001, 2, true),
          fmtUsd(1234.56),
          fmtP(d.market === "ETH" ? 2478.4 : 61842.5, MK[d.market]),
        ],
      };
      expect(JSON.parse(JSON.stringify(actual))).toEqual(expected);
    });
  }
  it("never admits a target on the wrong side of the mark", () => {
    expect(compute({ ...draft, target: 2000 }, { ETH: 2478.4 }, 800).ok).toBe(
      false,
    );
  });
});
