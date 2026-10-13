import { describe, expect, it } from "vitest";
import {
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  multicall3Abi,
  type Hex,
} from "viem";
import { U, type Intent } from "./financial-model";
import type { PublicMarketObservation } from "./perpl-market-data";
import {
  reviewLiveSizing,
  sizeLiveIntent,
  sizingAbi,
  sizingReviewFresh,
} from "./perpl-sizing";
import { testnet } from "./testnet-config";

function book(side: Intent["side"] = "long"): {
  intent: Intent;
  observation: PublicMarketObservation;
} {
  const now = Date.now();
  return {
    intent: {
      market: "ETH",
      side,
      goal: U,
      target: (side === "long" ? 2520n : 2480n) * U,
      stop: (side === "long" ? 2400n : 2600n) * U,
      budget: 800n * U,
      leverage: 300n,
      revision: 0,
    },
    observation: {
      metadata: {
        symbol: "ETH",
        marketId: 32,
        instanceId: 12,
        configBlock: 100,
        configTime: now,
        contextVersion: 1,
        tick: 10000n,
        lot: 1000n,
        priceDecimals: 2,
        sizeDecimals: 3,
        open: true,
        baseTakerFeePpm: 345n,
        initialMarginFactor: 1200,
        maintenanceMarginFactor: 2000,
        fundingIntervalBlocks: 8571,
        fundingIntervalSeconds: 2580,
      },
      mark: 2500n * U,
      bestAsk: 2501n * U,
      bestBid: 2499n * U,
      asks: [2501n, 2504n, 2511n, 2513n].map((price) => ({
        price: price * U,
        lots: 100n,
      })),
      bids: [2499n, 2496n, 2489n, 2487n].map((price) => ({
        price: price * U,
        lots: 100n,
      })),
      bookBlock: 100,
      stateBlock: 100,
      bookTime: now,
      stateTime: now,
      receivedAt: now,
    },
  };
}

describe("public draft allowance boundary", () => {
  it("sizes with zero or absent allowance without changing quantity", () => {
    const { intent, observation } = book();
    const { budget: _budget, ...draft } = intent;
    const expected = sizeLiveIntent(intent, observation);
    expect(sizeLiveIntent(draft, observation)).toEqual(expected);
    const zeroAllowance: Intent = { ...intent, budget: 0n };
    expect(sizeLiveIntent(zeroAllowance, observation)).toEqual(expected);
  });
});

describe("live sizing", () => {
  it("matches an exhaustive lot oracle across long/short depth and rejects goals past peak payoff", () => {
    for (const side of ["long", "short"] as const) {
      const { intent, observation } = book(side);
      const levels = side === "long" ? observation.asks : observation.bids;
      for (const goal of [1n, 900000n, 900001n, 1500000n, 1500001n]) {
        let lots = 0n,
          cost = 0n,
          expected: bigint | undefined;
        for (const level of levels.slice(0, 3)) {
          for (let n = 0n; n < level.lots; n++) {
            lots++;
            cost += level.price / 1000n;
            if (
              (side === "long" ? 1n : -1n) *
                ((intent.target * lots) / 1000n - cost) >=
              goal
            ) {
              expected = lots;
              break;
            }
          }
          if (expected) break;
        }
        if (expected)
          expect(sizeLiveIntent({ ...intent, goal }, observation).lots).toBe(
            expected,
          );
        else
          expect(() =>
            sizeLiveIntent({ ...intent, goal }, observation),
          ).toThrow("cannot reach");
      }
    }
  });

  it("sizes millions of BTC lots without lot iteration and preserves micro-AUSD precision", () => {
    const { intent, observation } = book();
    observation.metadata = {
      ...observation.metadata,
      symbol: "BTC",
      marketId: 16,
      tick: 100000n,
      lot: 10n,
      priceDecimals: 1,
      sizeDecimals: 5,
    };
    observation.mark = 60000n * U;
    observation.asks = [{ price: 60000n * U + 100000n, lots: 10_000_000n }];
    const result = sizeLiveIntent(
      {
        ...intent,
        market: "BTC",
        target: 61000n * U,
        stop: 59000n * U,
        goal: 50000n * U,
      },
      observation,
    );
    expect(result.lots).toBe(5_000_501n);
    expect(result.targetGross).toBeGreaterThanOrEqual(50000n * U);
    expect(result.targetGross - 9999n).toBeLessThan(50000n * U);
    expect(result.notional).toBe(result.lots * 600001n);
  });

  it("rejects a target inside the 0.1% limit band for long and short", () => {
    // Micro-AUSD: the bound itself, then one tick beyond it.
    for (const [side, inside, outside] of [
      ["long", 2_502_500_000n, 2_502_510_000n],
      ["short", 2_497_500_000n, 2_497_490_000n],
    ] as const) {
      const { intent, observation } = book(side);
      const near = { ...intent, goal: U / 10n };
      expect(() =>
        sizeLiveIntent({ ...near, target: inside }, observation),
      ).toThrow("at least 0.1% beyond");
      expect(
        sizeLiveIntent({ ...near, target: outside }, observation).lots,
      ).toBeGreaterThan(0n);
    }
  });

  it("rejects stale, mismatched, closed, off-tick and unfillable inputs", () => {
    const { intent, observation } = book();
    expect(() =>
      sizeLiveIntent(intent, observation, Date.now() + 30001),
    ).toThrow("stale");
    expect(() =>
      sizeLiveIntent({ ...intent, market: "BTC" }, observation),
    ).toThrow("Select BTC");
    expect(() =>
      sizeLiveIntent(intent, {
        ...observation,
        metadata: { ...observation.metadata, open: false },
      }),
    ).toThrow("closed");
    expect(() =>
      sizeLiveIntent({ ...intent, target: intent.target + 1n }, observation),
    ).toThrow("price tick");
    expect(() =>
      sizeLiveIntent({ ...intent, target: observation.mark }, observation),
    ).toThrow("live mark");
    expect(() =>
      sizeLiveIntent(intent, {
        ...observation,
        asks: [{ price: 2513n * U, lots: 1000000n }],
      }),
    ).toThrow("cannot reach");
  });

  it("pins the size-specific margin read to finalized testnet state and fails closed on source drift", async () => {
    const { intent, observation } = book();
    let chain = "0x279f",
      dynamic = 250n,
      base = 1200n,
      age = 0;
    const calls: unknown[][] = [];
    function result(data: Hex, to: string): Hex {
      if (
        to.toLowerCase() ===
        testnet.chain.contracts.multicall3.address.toLowerCase()
      ) {
        const decoded = decodeFunctionData({ abi: multicall3Abi, data });
        if (decoded.functionName !== "aggregate3")
          throw Error("Unexpected aggregate");
        return encodeFunctionResult({
          abi: multicall3Abi,
          functionName: "aggregate3",
          result: decoded.args[0].map((call) => ({
            success: true,
            returnData: result(call.callData, call.target),
          })),
        });
      }
      expect(to.toLowerCase()).toBe(testnet.exchange.toLowerCase());
      const decoded = decodeFunctionData({ abi: sizingAbi, data });
      expect(decoded.args).toEqual([32n, 53n]);
      return encodeFunctionResult({
        abi: sizingAbi,
        functionName: "getMarginFractions",
        result: [base, 2000n, dynamic, 10000000n, 9000n, 9500n],
      });
    }
    const transport = custom(
      {
        request: async ({ method, params }) => {
          if (method === "eth_chainId") return chain;
          if (method === "eth_getBlockByNumber") {
            expect(params).toEqual(["finalized", false]);
            return {
              number: "0x64",
              hash: `0x${"ab".repeat(32)}`,
              timestamp: `0x${(Math.floor(Date.now() / 1000) - age).toString(16)}`,
              transactions: [],
            };
          }
          if (method !== "eth_call") throw Error(`Unexpected ${method}`);
          const [call, block] = params as [{ to: string; data: Hex }, string];
          calls.push([block]);
          return result(call.data, call.to);
        },
      },
      { retryCount: 0 },
    );
    const review = await reviewLiveSizing(intent, observation, { transport });
    expect(calls).toEqual([["0x64"]]);
    expect(review.dynamicLeverage).toBe(250n);
    expect(review.baseMargin).toBe(44184334n);
    // Fresh means the market was read within 15 s; an old read is stale whatever its stamp.
    expect(sizingReviewFresh(review, Date.now() + 16000)).toBe(false);
    expect(sizingReviewFresh(review, Date.now() + 14000)).toBe(true);
    chain = "0x8f";
    await expect(
      reviewLiveSizing(intent, observation, { transport }),
    ).rejects.toThrow("not Monad testnet");
    chain = "0x279f";
    age = 30;
    await expect(
      reviewLiveSizing(intent, observation, { transport }),
    ).rejects.toThrow("too far apart");
    age = 0;
    base = 1100n;
    await expect(
      reviewLiveSizing(intent, observation, { transport }),
    ).rejects.toThrow("configuration changed");
    base = 1200n;
    dynamic = 0n;
    await expect(
      reviewLiveSizing(intent, observation, { transport }),
    ).rejects.toThrow("Margin limits");
  });
});
