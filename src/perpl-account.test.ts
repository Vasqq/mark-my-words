import { accountLockName } from "./account-coordination";
import { orderJournalKey } from "./order-journal";
import { describe, expect, it, vi } from "vitest";
import {
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  erc20Abi,
  multicall3Abi,
  type Address,
  type Hex,
} from "viem";
import { accountAbi, readTestnetAccount } from "./perpl-account";
import { testnet } from "./testnet-config";
import {
  fundingAbi,
  faucetAbi,
  reviewTestAusd,
  reviewOrderForwarding,
  fundingPlan,
  fundingStep,
  reviewFunding,
} from "./perpl-funding";
import {
  createFundingApplication,
  type FundingWallet,
} from "./funding-application";

const owner = "0x1111111111111111111111111111111111111111" as Address;
const other = "0x2222222222222222222222222222222222222222" as Address;
const hash = `0x${"ab".repeat(32)}` as Hex;
const txHash = `0x${"cd".repeat(32)}` as Hex;

function rpc(
  options: {
    absent?: boolean;
    failure?: boolean;
    chain?: string;
    decimals?: number;
    accountOwner?: Address;
    age?: number;
    collateral?: Address;
    approveResult?: boolean;
    allowance?: bigint;
    locked?: bigint;
    walletAusd?: bigint;
    walletMon?: bigint;
    faucetToken?: Address;
    faucetRevert?: boolean;
    nonce?: number;
    pendingNonce?: number;
    receipt?: {
      data: Hex;
      to: Address;
      nonce: number;
      from?: Address;
      status?: "0x0" | "0x1";
      block?: string;
      canonical?: boolean;
    };
  } = {},
) {
  const reads: { method: string; params: readonly unknown[] }[] = [];
  async function request(
    { method, params = [] }: { method: string; params?: readonly unknown[] },
    record = true,
  ): Promise<unknown> {
    if (record) reads.push({ method, params });
    if (method === "eth_chainId") return options.chain ?? "0x279f";
    if (method === "eth_getTransactionCount")
      return `0x${(params[1] === "pending" ? (options.pendingNonce ?? options.nonce ?? 0) : (options.nonce ?? 0)).toString(16)}`;
    if (
      method === "eth_getTransactionReceipt" ||
      method === "eth_getTransactionByHash"
    ) {
      const receipt = options.receipt;
      if (!receipt) return null;
      return {
        hash: txHash,
        transactionHash: txHash,
        chainId: "0x279f",
        nonce: `0x${receipt.nonce.toString(16)}`,
        from: receipt.from ?? owner,
        to: receipt.to,
        input: receipt.data,
        value: "0x0",
        blockHash: receipt.canonical === false ? txHash : hash,
        blockNumber: receipt.block ?? "0x100000",
        transactionIndex: "0x0",
        type: "0x2",
        status: receipt.status ?? "0x1",
        gasUsed: "0x10000",
        cumulativeGasUsed: "0x10000",
        effectiveGasPrice: "0x3b9aca00",
        logs: [],
      };
    }
    if (method === "eth_getBlockByNumber")
      return {
        number: "0x100000",
        baseFeePerGas: "0x3b9aca00",
        hash,
        timestamp: `0x${(Math.floor(Date.now() / 1000) - (options.age ?? 0)).toString(16)}`,
        transactions: [],
      };
    if (method === "eth_getBalance")
      return `0x${(options.walletMon ?? 1000000000000000000n).toString(16)}`;
    if (method === "eth_estimateGas") return "0x10000";
    if (method === "eth_maxPriorityFeePerGas" || method === "eth_gasPrice")
      return "0x3b9aca00";
    if (method !== "eth_call") throw Error(`Unexpected RPC: ${method}`);
    const call = params[0] as { to: string; data: `0x${string}` };
    if (
      call.to.toLowerCase() ===
      testnet.chain.contracts.multicall3.address.toLowerCase()
    ) {
      const decoded = decodeFunctionData({
        abi: multicall3Abi,
        data: call.data,
      });
      if (decoded.functionName === "getEthBalance")
        return encodeFunctionResult({
          abi: multicall3Abi,
          functionName: "getEthBalance",
          result: options.walletMon ?? 1000000000000000000n,
        });
      if (decoded.functionName !== "aggregate3")
        throw Error("Unexpected multicall");
      const result = await Promise.all(
        decoded.args[0].map(async (item) => {
          try {
            const data = await request(
              {
                method: "eth_call",
                params: [{ to: item.target, data: item.callData }, params[1]],
              },
              false,
            );
            return { success: true, returnData: data as Hex };
          } catch (error) {
            if (typeof error === "object" && error && "data" in error)
              return { success: false, returnData: error.data as Hex };
            throw error;
          }
        }),
      );
      return encodeFunctionResult({
        abi: multicall3Abi,
        functionName: "aggregate3",
        result,
      });
    }
    if (call.to.toLowerCase() === testnet.ausdFaucet.toLowerCase()) {
      const { functionName } = decodeFunctionData({
        abi: faucetAbi,
        data: call.data,
      });
      if (functionName === "token")
        return encodeFunctionResult({
          abi: faucetAbi,
          functionName,
          result: options.faucetToken ?? testnet.collateral,
        });
      if (options.faucetRevert) throw Error("Faucet claim is unavailable");
      return "0x";
    }
    if (call.to.toLowerCase() === testnet.exchange.toLowerCase()) {
      const { functionName } = decodeFunctionData({
        abi: [...accountAbi, ...fundingAbi],
        data: call.data,
      });
      if (functionName === "createAccount")
        return encodeFunctionResult({
          abi: fundingAbi,
          functionName,
          result: 1020n,
        });
      if (
        functionName === "depositCollateral" ||
        functionName === "withdrawCollateral"
      )
        return "0x";
      if (functionName === "getMinAccountOpenCNS")
        return encodeFunctionResult({
          abi: accountAbi,
          functionName,
          result: 100000000n,
        });
      if (functionName === "getExchangeInfo")
        return encodeFunctionResult({
          abi: accountAbi,
          functionName,
          result: [
            0n,
            0n,
            0n,
            6n,
            options.collateral ?? testnet.collateral,
            other,
          ],
        });
      if (
        functionName === "isHalted" ||
        functionName === "addressBlocked" ||
        functionName === "whitelistingEnabled" ||
        functionName === "whitelisted"
      )
        return encodeFunctionResult({
          abi: accountAbi,
          functionName,
          result: false,
        });
      if (options.failure) throw Error("RPC unavailable");
      if (options.absent)
        throw {
          code: 3,
          message: "execution reverted",
          data: encodeErrorResult({
            abi: accountAbi,
            errorName: "AccountDoesNotExist",
            args: [owner],
          }),
        };
      return encodeFunctionResult({
        abi: accountAbi,
        functionName: "getAccountByAddr",
        result: {
          accountId: 1019n,
          accountAddr: options.accountOwner ?? owner,
          balanceCNS: 1234567n,
          lockedBalanceCNS: options.locked ?? 1000000n,
          frozen: 0,
          positions: { bank1: 0n, bank2: 8n, bank3: 0n, bank4: 0n },
        },
      });
    }
    const { functionName } = decodeFunctionData({
      abi: erc20Abi,
      data: call.data,
    });
    if (functionName === "decimals")
      return encodeFunctionResult({
        abi: erc20Abi,
        functionName,
        result: options.decimals ?? 6,
      });
    if (functionName === "approve")
      return encodeFunctionResult({
        abi: erc20Abi,
        functionName,
        result: options.approveResult ?? true,
      });
    if (functionName === "balanceOf" || functionName === "allowance")
      return encodeFunctionResult({
        abi: erc20Abi,
        functionName,
        result:
          functionName === "balanceOf"
            ? (options.walletAusd ?? 7654321n)
            : (options.allowance ?? 2000000n),
      });
    throw Error(`Unexpected contract read: ${functionName}`);
  }
  const transport = custom({ request }, { retryCount: 0 });
  return { transport, reads };
}

describe("read-only Perpl account boundary", () => {
  it("keeps identity and exact balances together at one finalized block", async () => {
    const source = rpc();
    const result = await readTestnetAccount(owner, source);
    expect(result).toMatchObject({
      owner,
      chainId: 10143,
      block: 1048576n,
      blockHash: hash,
      walletMon: 1000000000000000000n,
      walletAusd: 7654321n,
      allowance: 2000000n,
      exchangeAccount: {
        id: 1019n,
        balance: 1234567n,
        free: 234567n,
        locked: 1000000n,
        hasPosition: true,
      },
    });
    expect(source.reads[1].params).toEqual(["finalized", false]);
    expect(source.reads.slice(2).map((read) => read.params[1])).toEqual([
      "0x100000",
    ]);
    expect(
      source.reads.filter((read) => read.method === "eth_call"),
    ).toHaveLength(1);
  });

  it("distinguishes a missing exchange account from a failed RPC", async () => {
    expect(
      (await readTestnetAccount(owner, rpc({ absent: true }))).exchangeAccount,
    ).toBeNull();
    await expect(
      readTestnetAccount(owner, rpc({ failure: true })),
    ).rejects.toThrow();
  });

  it("rejects wrong network, units, identity, stale blocks and aborted reads", async () => {
    for (const options of [
      { chain: "0x8f" },
      { decimals: 18 },
      { accountOwner: other },
      { collateral: other },
      { age: 61 },
    ])
      await expect(readTestnetAccount(owner, rpc(options))).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      readTestnetAccount(owner, {
        ...rpc(),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it("plans exact approval and account creation separately from later deposits", async () => {
    const snapshot = await readTestnetAccount(owner, rpc({ absent: true }));
    snapshot.walletAusd = 200000000n;
    const plan = fundingPlan(snapshot, "100.000001");
    expect(plan.blockers).toEqual([]);
    expect(plan.steps.map((step) => step.kind)).toEqual([
      "reset-allowance",
      "approve",
      "create-account",
    ]);
    expect(
      decodeFunctionData({ abi: erc20Abi, data: plan.steps[1].data }).args,
    ).toEqual([testnet.exchange, 100000001n]);
    expect(
      decodeFunctionData({ abi: fundingAbi, data: plan.steps[2].data }).args,
    ).toEqual([100000001n]);
    expect(plan.steps.every((step) => step.value === 0n)).toBe(true);
    const existing = await readTestnetAccount(owner, rpc());
    expect(fundingPlan(existing, "1").steps.map((step) => step.kind)).toEqual([
      "deposit",
    ]);
    expect(
      fundingPlan({ ...snapshot, allowance: 0n }, "100").steps.map(
        (step) => step.kind,
      ),
    ).toEqual(["approve", "create-account"]);
  });

  it("blocks invalid precision, stale state, insufficient funds and restricted accounts", async () => {
    const snapshot = await readTestnetAccount(owner, rpc({ absent: true }));
    for (const input of ["0", "-1", "1.0000001", "1e3", "", "NaN"])
      expect(() => fundingPlan(snapshot, input)).toThrow();
    expect(() =>
      fundingPlan({ ...snapshot, receivedAt: Date.now() - 31000 }, "100"),
    ).toThrow();
    const blocked = fundingPlan(
      {
        ...snapshot,
        walletMon: 0n,
        funding: {
          ...snapshot.funding,
          halted: true,
          addressBlocked: true,
          whitelistEnabled: true,
        },
      },
      "1",
    );
    expect(blocked.blockers).toHaveLength(5);
    expect(fundingPlan(snapshot, "100").blockers).toHaveLength(1);
  });

  it("simulates only the next step, rejects false approvals, and never submits a transaction", async () => {
    const source = rpc();
    const review = await reviewFunding(owner, "3", source);
    expect(review.nextStepEstimate?.gas).toBe(98304n);
    expect(review.steps.map((step) => step.kind)).toEqual([
      "reset-allowance",
      "approve",
      "deposit",
    ]);
    expect(
      source.reads.every(
        (read) =>
          !read.method.includes("send") && !read.method.includes("sign"),
      ),
    ).toBe(true);
    await expect(
      reviewFunding(owner, "3", rpc({ approveResult: false })),
    ).rejects.toThrow("approval preflight");
    const deposit = await reviewFunding(
      owner,
      "3",
      rpc({ allowance: 3000000n }),
    );
    expect(deposit.steps.map((step) => step.kind)).toEqual(["deposit"]);
    expect(deposit.nextStepEstimate?.gas).toBe(98304n);
    const create = await reviewFunding(
      owner,
      "100",
      rpc({ absent: true, allowance: 100000000n, walletAusd: 100000000n }),
    );
    expect(create.steps.map((step) => step.kind)).toEqual(["create-account"]);
    expect(create.nextStepEstimate?.gas).toBe(98304n);
  });
});

function fundingEnvironment(options: Parameters<typeof rpc>[0] = {}) {
  const source = rpc(options);
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  let locked = false;
  const boundary = {
    storage,
    reads: source,
    exclusive: async <T>(name: string, work: () => Promise<T>) => {
      expect(name).toBe(accountLockName(owner));
      if (locked) throw Error("Another tab is handling this wallet.");
      locked = true;
      try {
        return await work();
      } finally {
        locked = false;
      }
    },
  };
  const wallet: FundingWallet = {
    prepare: vi.fn(async () => ({ address: owner, chainId: 10143 })),
    send: vi.fn(async () => txHash),
  };
  return {
    source,
    values,
    storage,
    boundary,
    wallet,
    app: createFundingApplication(owner, boundary),
  };
}

describe("testnet funding lifecycle", () => {
  it("reviews forwarding as a persistent permission, submits no funds and restores its exact receipt", async () => {
    const state: Parameters<typeof rpc>[0] = { walletAusd: 0n, allowance: 0n };
    const env = fundingEnvironment(state);
    expect(
      (await reviewOrderForwarding(owner, rpc({ absent: true }))).blockers,
    ).toContain("Create a Perpl account before enabling forwarding.");
    const review = await reviewOrderForwarding(owner, env.source);
    expect(review.amount).toBe(0n);
    expect(review.blockers).toEqual([]);
    expect(review.steps).toEqual([fundingStep("enable-forwarding", 0n)]);
    expect(
      decodeFunctionData({ abi: fundingAbi, data: review.steps[0].data }),
    ).toMatchObject({ functionName: "allowOrderForwarding", args: [true] });
    await expect(
      env.app.submit({ ...review, amount: 1n }, null, env.wallet),
    ).rejects.toThrow("changed");
    expect(env.wallet.send).not.toHaveBeenCalled();
    await env.app.submit(review, null, env.wallet);
    expect(env.wallet.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: testnet.exchange, value: 0n }),
      expect.stringContaining("persists beyond API-session expiry"),
    );
    state.receipt = { ...review.steps[0], nonce: 0 };
    expect(
      await createFundingApplication(owner, env.boundary).reconcile(),
    ).toMatchObject({
      status: "confirmed",
      kind: "enable-forwarding",
      amount: "0",
    });
    expect(env.wallet.send).toHaveBeenCalledTimes(1);
  });
  it("withdraws only free exchange collateral to the owner without token approvals", async () => {
    const state: Parameters<typeof rpc>[0] = { walletAusd: 0n, allowance: 0n };
    const env = fundingEnvironment(state);
    const snapshot = await readTestnetAccount(owner, env.source);
    expect(snapshot.exchangeAccount?.free).toBe(234567n);
    expect(fundingPlan(snapshot, "0.234568", "withdraw").blockers).toContain(
      "Withdrawal exceeds this account's free test AUSD balance.",
    );
    expect(
      fundingPlan({ ...snapshot, exchangeAccount: null }, "1", "withdraw")
        .blockers,
    ).toHaveLength(1);
    expect(
      (await readTestnetAccount(owner, rpc({ locked: 2000000n })))
        .exchangeAccount?.free,
    ).toBe(0n);
    state.locked = 0n;
    const review = await reviewFunding(owner, "1", env.source, "withdraw");
    expect(review.blockers).toEqual([]);
    expect(review.steps).toEqual([fundingStep("withdraw", 1000000n)]);
    await env.app.submit(review, null, env.wallet);
    expect(env.wallet.send).toHaveBeenCalledWith(
      expect.objectContaining(fundingStep("withdraw", 1000000n)),
      "Withdraw 1 test AUSD from your Perpl account to this wallet.",
    );
    state.receipt = { ...review.steps[0], nonce: 0 };
    expect(
      await createFundingApplication(owner, env.boundary).reconcile(),
    ).toMatchObject({
      status: "confirmed",
      kind: "withdraw",
      amount: "1000000",
    });
    expect(env.wallet.send).toHaveBeenCalledTimes(1);
  });
  it("claims only the configured test collateral for the selected wallet and reconciles it without a deposit", async () => {
    const state: Parameters<typeof rpc>[0] = {
      absent: true,
      walletAusd: 0n,
      allowance: 0n,
    };
    const env = fundingEnvironment(state);
    const review = await reviewTestAusd(owner, env.source);
    expect(review.blockers).toEqual([]);
    expect(review.steps).toEqual([fundingStep("claim-test-ausd", 0n, owner)]);
    expect(
      decodeFunctionData({ abi: faucetAbi, data: review.steps[0].data }).args,
    ).toEqual([owner]);
    await env.app.submit(review, null, env.wallet);
    state.receipt = { ...review.steps[0], nonce: 0 };
    const confirmed = await createFundingApplication(
      owner,
      env.boundary,
    ).reconcile();
    expect(confirmed).toMatchObject({
      status: "confirmed",
      kind: "claim-test-ausd",
      amount: "0",
    });
    expect(env.wallet.send).toHaveBeenCalledTimes(1);
    expect(
      (await readTestnetAccount(owner, env.source)).exchangeAccount,
    ).toBeNull();
    await expect(
      reviewTestAusd(owner, rpc({ faucetToken: other })),
    ).rejects.toThrow("Faucet token");
    await expect(
      reviewTestAusd(owner, rpc({ faucetRevert: true })),
    ).rejects.toThrow();
  });
  it("keeps approval separate from deposit, restores a pending receipt, and rejects stale reviews", async () => {
    const state: Parameters<typeof rpc>[0] = {
      allowance: 0n,
      walletAusd: 200000000n,
    };
    const env = fundingEnvironment(state);
    const review = await reviewFunding(owner, "100", env.source);
    const sent = await env.app.submit(review, null, env.wallet);
    expect(sent.status).toBe("pending");
    expect(env.wallet.send).toHaveBeenCalledWith(
      expect.objectContaining({
        ...fundingStep("approve", 100000000n),
        from: owner,
        chainId: 10143,
        nonce: 0,
        gasLimit: 98304n,
      }),
      "Allow the Perpl Exchange to spend exactly 100 test AUSD. This does not deposit funds.",
    );
    const reloaded = createFundingApplication(owner, env.boundary);
    expect((await reloaded.reconcile())?.status).toBe("pending");
    await expect(
      reloaded.submit(review, sent.revision, env.wallet),
    ).rejects.toThrow("Resolve the previous");
    state.receipt = { ...fundingStep("approve", 100000000n), nonce: 0 };
    const confirmed = await reloaded.reconcile();
    expect(confirmed?.status).toBe("confirmed");
    expect(confirmed?.kind).toBe("approve");
    await expect(reloaded.submit(review, null, env.wallet)).rejects.toThrow(
      "activity changed",
    );
    state.allowance = 100000000n;
    state.nonce = 1;
    const deposit = await reviewFunding(owner, "100", env.source);
    await reloaded.submit(deposit, confirmed!.revision, env.wallet);
    expect(env.wallet.send).toHaveBeenCalledTimes(2);
    state.receipt = {
      ...fundingStep("deposit", 100000000n),
      nonce: 1,
      status: "0x0",
    };
    expect((await reloaded.reconcile())?.status).toBe("reverted");
  });

  it("blocks duplicate tabs, stale or changed requirements, wrong wallets, and unavailable persistence before signing", async () => {
    const state = { allowance: 0n, walletAusd: 200000000n, pendingNonce: 0 };
    const env = fundingEnvironment(state);
    const review = await reviewFunding(owner, "100", env.source);
    vi.stubGlobal("navigator", {});
    try {
      const unsupported = createFundingApplication(owner, {
        storage: env.storage,
        reads: env.source,
      });
      await expect(
        unsupported.submit(review, null, env.wallet),
      ).rejects.toThrow("cannot safely coordinate");
      expect(env.wallet.prepare).not.toHaveBeenCalled();
      expect(env.wallet.send).not.toHaveBeenCalled();
      expect(env.values.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
    const noGas = await reviewFunding(
      owner,
      "100",
      rpc({ ...state, walletMon: 1n }),
    );
    expect(noGas.blockers).toContain(
      "Test MON balance is below the next step's estimated fee ceiling.",
    );
    await expect(env.app.submit(noGas, null, env.wallet)).rejects.toThrow(
      "Check funding",
    );
    expect(env.wallet.send).not.toHaveBeenCalled();
    await expect(
      env.app.submit({ ...review, expiresAt: 0 }, null, env.wallet),
    ).rejects.toThrow("Check funding");
    for (const identity of [
      { address: other, chainId: 10143 },
      { address: owner, chainId: 143 },
    ]) {
      await expect(
        env.app.submit(review, null, {
          ...env.wallet,
          prepare: async () => identity,
        }),
      ).rejects.toThrow("selected wallet");
    }
    state.allowance = 100000000n;
    await expect(env.app.submit(review, null, env.wallet)).rejects.toThrow(
      "requirements or fees changed",
    );
    state.allowance = 0n;
    state.pendingNonce = 1;
    await expect(env.app.submit(review, null, env.wallet)).rejects.toThrow(
      "another pending",
    );
    state.pendingNonce = 0;
    env.values.set(orderJournalKey(owner), "{}");
    await expect(env.app.submit(review, null, env.wallet)).rejects.toThrow(
      "order",
    );
    expect(env.wallet.send).not.toHaveBeenCalled();
    env.values.delete(orderJournalKey(owner));
    const save = env.storage.setItem;
    env.storage.setItem = () => {
      throw Error("Storage full");
    };
    await expect(env.app.submit(review, null, env.wallet)).rejects.toThrow(
      "Storage full",
    );
    expect(env.wallet.send).not.toHaveBeenCalled();
    env.storage.setItem = save;
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    env.wallet.send = vi.fn(async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return txHash;
    });
    const first = env.app.submit(review, null, env.wallet);
    await ready;
    await expect(
      createFundingApplication(owner, env.boundary).submit(
        review,
        null,
        env.wallet,
      ),
    ).rejects.toThrow("Another tab");
    release();
    await first;
    expect(env.wallet.send).toHaveBeenCalledTimes(1);
    const key = [...env.values.keys()][0];
    env.values.set(key, "{}");
    await expect(env.app.submit(review, null, env.wallet)).rejects.toThrow(
      "record is invalid",
    );
  });

  it("retains unknown outcomes, requires matching finalized receipts, and identifies replacement transactions", async () => {
    const state: Parameters<typeof rpc>[0] = {
      allowance: 0n,
      walletAusd: 200000000n,
    };
    const env = fundingEnvironment(state);
    env.wallet.send = vi.fn(async () => {
      throw Error("Response lost after broadcast");
    });
    const review = await reviewFunding(owner, "100", env.source);
    expect((await env.app.submit(review, null, env.wallet)).status).toBe(
      "unknown",
    );
    await expect(
      env.app.submit(review, env.app.read()!.revision, env.wallet),
    ).rejects.toThrow("Resolve the previous");
    state.receipt = {
      ...fundingStep("approve", 100000000n),
      nonce: 0,
      from: other,
    };
    await expect(env.app.reconcile(txHash)).rejects.toThrow("does not match");
    state.receipt.from = owner;
    state.receipt.block = "0x100001";
    expect(
      (await env.app.reconcile(`0x${txHash.slice(2).toUpperCase()}`))?.status,
    ).toBe("pending");
    state.receipt.block = "0x100000";
    state.receipt.canonical = false;
    await expect(env.app.reconcile(txHash)).rejects.toThrow("finalized chain");
    state.receipt.canonical = true;
    state.receipt.data = "0x";
    state.receipt.to = owner;
    expect((await env.app.reconcile(txHash))?.status).toBe("replaced");
    expect(env.wallet.send).toHaveBeenCalledTimes(1);
  });

  it("preserves recovery after a hash-save failure and allows retry only after an explicit wallet rejection", async () => {
    const state: Parameters<typeof rpc>[0] = {
      allowance: 100000000n,
      walletAusd: 200000000n,
      absent: true,
    };
    const env = fundingEnvironment(state);
    const review = await reviewFunding(owner, "100", env.source);
    env.wallet.send = vi.fn(async () => {
      throw { code: 4001 };
    });
    const rejected = await env.app.submit(review, null, env.wallet);
    expect(rejected.status).toBe("rejected");
    const save = env.storage.setItem;
    env.wallet.send = vi.fn(async () => {
      env.storage.setItem = () => {
        throw Error("Storage full");
      };
      return txHash;
    });
    await expect(
      env.app.submit(review, rejected.revision, env.wallet),
    ).rejects.toThrow(`Transaction submitted: ${txHash}`);
    expect(env.app.read()?.status).toBe("requesting");
    await expect(
      env.app.submit(review, env.app.read()!.revision, env.wallet),
    ).rejects.toThrow("Resolve the previous");
    env.storage.setItem = save;
    state.receipt = { ...fundingStep("create-account", 100000000n), nonce: 0 };
    expect(
      (await createFundingApplication(owner, env.boundary).reconcile(txHash))
        ?.status,
    ).toBe("confirmed");
    expect(env.wallet.send).toHaveBeenCalledTimes(1);
  });
});

it("settles only matching finalized order segments, excluding counterparties and noncanonical receipts", async () => {
  const { readEntrySettlement, orderReceiptAbi } =
    await import("./perpl-order-history");
  const { encodeAbiParameters, encodeEventTopics } = await import("viem");
  const payload = {
    rq: 18,
    acc: 1057,
    mkt: 32 as const,
    t: 1 as const,
    p: 250000,
    s: 20,
    lv: 300,
    fl: 4 as const,
    mnp: 50 as const,
    lb: 120,
  };
  let requestExecutionBlock = 120n;
  let closing = false;
  let short = false;
  let requestMarket = 32n;
  let decreasing = false;
  let decreaseEnd = 10n;
  let fillPrice = 249999n;
  const requestEvent = orderReceiptAbi[0];
  const fillEvent = orderReceiptAbi[1];
  const log = (
    kind: "request" | "fill" | "close",
    account = 1057,
    market = 32n,
    side = 0,
  ) => ({
    address: testnet.exchange,
    topics: encodeEventTopics({
      abi: orderReceiptAbi,
      eventName:
        kind === "request"
          ? "OrderRequestV2"
          : kind === "close"
            ? decreasing
              ? "PositionDecreased"
              : "PositionClosed"
            : "TakerOrderFilledV2",
    }),
    data:
      kind === "close"
        ? decreasing
          ? encodeAbiParameters(orderReceiptAbi[3].inputs, [
              market,
              BigInt(account),
              side,
              200000n,
              100000n,
              20n,
              decreaseEnd,
              -40n,
              -2n,
            ])
          : encodeAbiParameters(orderReceiptAbi[2].inputs, [
              market,
              BigInt(account),
              side,
              250001n,
              -100n,
              0n,
            ])
        : kind === "request"
          ? encodeAbiParameters(requestEvent.inputs, [
              requestMarket,
              BigInt(account),
              18n,
              0n,
              closing ? (short ? 3 : 2) : short ? 1 : 0,
              250000n,
              20n,
              0n,
              false,
              false,
              true,
              10n,
              closing ? 0n : 300n,
              requestExecutionBlock,
              0n,
              closing ? 0n : 50n,
              100000n,
              "0x",
            ])
          : encodeAbiParameters(fillEvent.inputs, [
              fillPrice,
              fillPrice,
              fillPrice,
              10n,
              9n,
              -833300n,
              99166700n,
              0n,
              0n,
            ]),
    blockNumber: "0x64",
    blockHash: hash,
    transactionHash: txHash,
    logIndex: "0x0",
    transactionIndex: "0x0",
    removed: false,
  });
  let overrideLogs: ReturnType<typeof log>[] | undefined;
  let canonical = true;
  let account = 1057;
  let ambiguousClose = false;
  let ownerSide = 0;
  const transport = custom({
    request: async ({ method }) => {
      if (method === "eth_chainId") return "0x279f";
      if (method === "eth_getTransactionReceipt")
        return {
          transactionHash: txHash,
          blockNumber: "0x64",
          blockHash: hash,
          transactionIndex: "0x0",
          from: other,
          to: testnet.exchange,
          status: "0x1",
          type: "0x2",
          gasUsed: "0x10000",
          cumulativeGasUsed: "0x10000",
          effectiveGasPrice: "0x1",
          logs: overrideLogs ?? [
            log("request", 1),
            log("fill"),
            log("request", account),
            ...(closing
              ? [
                  log("close", 7, 32n, 1),
                  log("close", account, requestMarket === 32n ? 16n : 32n, 1),
                  log("close", account, requestMarket, ownerSide),
                  ...(ambiguousClose ? [log("close", account)] : []),
                ]
              : []),
            log("fill"),
          ],
        };
      if (method === "eth_getBlockByNumber")
        return {
          number: "0x64",
          hash: canonical ? hash : txHash,
          timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
          transactions: [],
        };
      throw Error("Unexpected write or RPC");
    },
  });
  expect(await readEntrySettlement(payload, txHash, { transport })).toEqual({
    filled: 10,
    fee: "9",
    block: 100,
    hash: txHash,
  });
  closing = true;
  fillPrice = 250001n;
  const closePayload = {
    ...payload,
    t: 3 as const,
    lv: 0 as const,
    mnp: 0 as const,
  };
  expect(
    await readEntrySettlement(closePayload, txHash, { transport }),
  ).toMatchObject({
    filled: 10,
    fee: "9",
    closed: { pnl: "-100", funding: "0" },
  });
  decreasing = true;
  expect(
    await readEntrySettlement(closePayload, txHash, { transport }),
  ).toMatchObject({
    filled: 10,
    decreased: { start: 20, end: 10, pnl: "-40", funding: "-2" },
  });
  decreaseEnd = 9n;
  await expect(
    readEntrySettlement(closePayload, txHash, { transport }),
  ).rejects.toThrow("settlement");
  decreaseEnd = 10n;
  decreasing = false;
  ambiguousClose = true;
  await expect(
    readEntrySettlement(closePayload, txHash, { transport }),
  ).rejects.toThrow("Ambiguous");
  ambiguousClose = false;
  ownerSide = 1;
  await expect(
    readEntrySettlement(closePayload, txHash, { transport }),
  ).rejects.toThrow("Ambiguous");
  ownerSide = 0;
  fillPrice = 249999n;
  await expect(
    readEntrySettlement(closePayload, txHash, { transport }),
  ).rejects.toThrow("settlement");
  closing = false;
  account = 99;
  expect(await readEntrySettlement(payload, txHash, { transport })).toBeNull();
  account = 1057;
  short = true;
  requestMarket = 16n;
  ownerSide = 1;
  closing = false;
  fillPrice = 250001n;
  expect(
    await readEntrySettlement({ ...payload, mkt: 16, t: 2 }, txHash, {
      transport,
    }),
  ).toMatchObject({ filled: 10, fee: "9" });
  closing = true;
  fillPrice = 249999n;
  expect(
    await readEntrySettlement({ ...closePayload, mkt: 16, t: 4 }, txHash, {
      transport,
    }),
  ).toMatchObject({ filled: 10, closed: { pnl: "-100", funding: "0" } });
  fillPrice = 250001n;
  await expect(
    readEntrySettlement({ ...closePayload, mkt: 16, t: 4 }, txHash, {
      transport,
    }),
  ).rejects.toThrow("settlement");
  fillPrice = 249999n;
  ownerSide = 0;
  await expect(
    readEntrySettlement({ ...closePayload, mkt: 16, t: 4 }, txHash, {
      transport,
    }),
  ).rejects.toThrow("Ambiguous");
  short = false;
  requestMarket = 32n;
  ownerSide = 0;
  closing = false;
  closing = true;
  fillPrice = 250001n;
  const completedLog = {
    ...log("request"),
    topics: encodeEventTopics({
      abi: orderReceiptAbi,
      eventName: "OrderBatchCompleted",
    }),
    data: encodeAbiParameters(orderReceiptAbi[7].inputs, [1n]),
  };
  const rejectionLog = {
    ...log("request"),
    topics: encodeEventTopics({
      abi: orderReceiptAbi,
      eventName: "CloseOrderPositionMismatch",
    }),
    data: encodeAbiParameters(orderReceiptAbi[6].inputs, [1, 2]),
  };
  overrideLogs = [log("request"), rejectionLog, completedLog];
  expect(
    await readEntrySettlement(closePayload, txHash, { transport }),
  ).toMatchObject({
    rejected: "position-mismatch",
    filled: 0,
    fee: "0",
    block: 100,
  });
  overrideLogs = [log("request"), rejectionLog, log("request"), rejectionLog];
  expect(
    await readEntrySettlement(closePayload, txHash, { transport }),
  ).toBeNull();
  overrideLogs = [log("request"), log("fill"), rejectionLog];
  expect(
    (await readEntrySettlement(closePayload, txHash, { transport }))?.rejected,
  ).toBeUndefined();
  overrideLogs = [
    log("request"),
    {
      ...rejectionLog,
      data: encodeAbiParameters(orderReceiptAbi[6].inputs, [0, 2]),
    },
  ];
  expect(
    await readEntrySettlement(closePayload, txHash, { transport }),
  ).toBeNull();
  overrideLogs = [log("request"), rejectionLog, completedLog];
  short = true;
  requestMarket = 16n;
  overrideLogs = [
    log("request"),
    {
      ...rejectionLog,
      data: encodeAbiParameters(orderReceiptAbi[6].inputs, [0, 3]),
    },
    completedLog,
  ];
  expect(
    await readEntrySettlement({ ...closePayload, mkt: 16, t: 4 }, txHash, {
      transport,
    }),
  ).toMatchObject({ rejected: "position-mismatch", filled: 0 });
  short = false;
  requestMarket = 32n;
  closing = false;
  requestExecutionBlock = 90n;
  overrideLogs = [
    log("request"),
    {
      ...rejectionLog,
      topics: encodeEventTopics({
        abi: orderReceiptAbi,
        eventName: "ExceedsLastExecutionBlock",
      }),
      data: encodeAbiParameters(orderReceiptAbi[4].inputs, [90n]),
    },
    completedLog,
  ];
  expect(
    await readEntrySettlement({ ...payload, lb: 90 }, txHash, { transport }),
  ).toMatchObject({ rejected: "expired", filled: 0 });
  requestExecutionBlock = 120n;
  closing = true;
  overrideLogs = [log("request"), rejectionLog, completedLog];
  canonical = false;
  expect(
    await readEntrySettlement(closePayload, txHash, { transport }),
  ).toBeNull();
});
