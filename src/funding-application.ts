import { testnetLimits } from "./testnet-limits";
import {
  accountLock,
  accountLockName,
  type AccountLock,
} from "./account-coordination";
import { assertNoUnresolvedOrders } from "./order-journal";
import {
  formatUnits,
  getAddress,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from "viem";
import {
  fundingStep,
  reviewFunding,
  reviewTestAusd,
  reviewOrderForwarding,
  type FundingReview,
  type FundingStep,
} from "./perpl-funding";
import { testnetClient, type TestnetReadOptions } from "./testnet-config";

export interface FundingAttempt {
  version: 1;
  revision: string;
  owner: Address;
  amount: string;
  nonce: number;
  kind: FundingStep["kind"];
  status:
    | "requesting"
    | "pending"
    | "unknown"
    | "confirmed"
    | "reverted"
    | "rejected"
    | "replaced";
  hash?: Hex;
}
export interface FundingWallet {
  prepare(): Promise<{ address: string; chainId: number }>;
  send(
    transaction: Omit<FundingStep, "kind"> & {
      kind: FundingStep["kind"] | "owner-close" | "owner-cancel";
      from: Address;
      chainId: 10143;
      nonce: number;
      gasLimit: bigint;
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
    },
    description: string,
  ): Promise<Hex>;
}
type Exclusive = AccountLock;
export function unresolved(attempt: FundingAttempt | null): boolean {
  return (
    !!attempt && ["requesting", "pending", "unknown"].includes(attempt.status)
  );
}
function transactionHash(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);
}
function rejected(cause: unknown): boolean {
  // Only an explicit EIP-1193 rejection proves that no transaction was submitted.
  const seen = new Set<unknown>();
  while (cause && typeof cause === "object" && !seen.has(cause)) {
    seen.add(cause);
    if ("code" in cause && cause.code === 4001) return true;
    cause = "cause" in cause ? cause.cause : undefined;
  }
  return false;
}

/** One testnet funding transaction at a time; no signing on mount or automatic retry. */
export function createFundingApplication(
  address: string,
  options: {
    storage?: Pick<Storage, "getItem" | "setItem">;
    exclusive?: Exclusive;
    reads?: TestnetReadOptions;
  } = {},
) {
  const owner = getAddress(address);
  const key = `perpl-funding-v1:10143:${owner.toLowerCase()}`;
  const storage = () => options.storage ?? window.localStorage;
  const locked = <T>(work: () => Promise<T>) =>
    (options.exclusive ?? accountLock)(accountLockName(owner), work);
  function read(): FundingAttempt | null {
    const raw = storage().getItem(key);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object")
      throw Error(
        "Funding record is invalid. Resolve it before sending again.",
      );
    const a = value as Partial<FundingAttempt>;
    if (
      a.version !== 1 ||
      a.owner !== owner ||
      typeof a.revision !== "string" ||
      !a.revision ||
      typeof a.amount !== "string" ||
      !(["claim-test-ausd", "enable-forwarding"].includes(a.kind ?? "")
        ? a.amount === "0"
        : /^[1-9]\d{0,25}$/.test(a.amount)) ||
      !Number.isSafeInteger(a.nonce) ||
      a.nonce! < 0 ||
      ![
        "reset-allowance",
        "approve",
        "create-account",
        "deposit",
        "claim-test-ausd",
        "withdraw",
        "enable-forwarding",
      ].includes(a.kind ?? "") ||
      ![
        "requesting",
        "pending",
        "unknown",
        "confirmed",
        "reverted",
        "rejected",
        "replaced",
      ].includes(a.status ?? "") ||
      (a.hash !== undefined && !transactionHash(a.hash)) ||
      (["pending", "confirmed", "reverted", "replaced"].includes(
        a.status ?? "",
      ) &&
        !a.hash)
    )
      throw Error(
        "Funding record is invalid. Resolve it before sending again.",
      );
    return a as FundingAttempt;
  }
  function save(attempt: FundingAttempt): FundingAttempt {
    const next = { ...attempt, revision: crypto.randomUUID() };
    const raw = JSON.stringify(next);
    storage().setItem(key, raw);
    if (storage().getItem(key) !== raw)
      throw Error(
        "Funding record could not be saved. Do not retry the transaction.",
      );
    return next;
  }
  async function submit(
    review: FundingReview,
    revision: string | null,
    wallet: FundingWallet,
    signal?: AbortSignal,
  ) {
    return locked(async () => {
      assertNoUnresolvedOrders(storage(), owner);
      const previous = read();
      if (unresolved(previous))
        throw Error(
          "Resolve the previous wallet request before sending another.",
        );
      if ((previous?.revision ?? null) !== revision)
        throw Error("Funding activity changed. Check funding again.");
      const estimate = review.nextStepEstimate;
      if (
        review.snapshot.owner !== owner ||
        review.snapshot.chainId !== 10143 ||
        review.expiresAt <= Date.now() ||
        review.blockers.length ||
        !estimate
      )
        throw Error("Check funding again before confirming a transaction.");
      signal?.throwIfAborted();
      const identity = await wallet.prepare();
      if (getAddress(identity.address) !== owner || identity.chainId !== 10143)
        throw Error("The selected wallet must be connected to Monad testnet.");
      const reads = { ...options.reads, signal };
      const fresh =
        review.steps[0]?.kind === "claim-test-ausd"
          ? await reviewTestAusd(owner, reads)
          : review.steps[0]?.kind === "enable-forwarding"
            ? await reviewOrderForwarding(owner, reads)
            : await reviewFunding(
                owner,
                formatUnits(review.amount, 6),
                reads,
                review.steps[0]?.kind === "withdraw" ? "withdraw" : "deposit",
              );
      const next = fresh.steps[0];
      if (
        fresh.blockers.length ||
        fresh.amount !== review.amount ||
        !fresh.nextStepEstimate ||
        next.kind !== review.steps[0]?.kind ||
        next.data !== review.steps[0]?.data ||
        next.to !== review.steps[0]?.to ||
        fresh.nextStepEstimate.gas > estimate.gas ||
        fresh.nextStepEstimate.maxFeePerGas > estimate.maxFeePerGas ||
        fresh.snapshot.walletMon < estimate.feeCeiling
      )
        throw Error(
          "Funding requirements or fees changed. Check funding again.",
        );
      if (estimate.feeCeiling > testnetLimits.maxGasPerTransaction)
        throw Error("This transaction could cost more than 0.05 MON in gas.");
      const client = testnetClient(reads);
      const [nonce, finalizedNonce] = await Promise.all([
        client.getTransactionCount({ address: owner, blockTag: "pending" }),
        client.getTransactionCount({ address: owner, blockTag: "finalized" }),
      ]);
      if (nonce !== finalizedNonce)
        throw Error(
          "This wallet has another pending transaction. Wait for finality and check again.",
        );
      signal?.throwIfAborted();
      if (Date.now() >= review.expiresAt || Date.now() >= fresh.expiresAt)
        throw Error("Funding review expired. Check again.");
      let attempt = save({
        version: 1,
        revision: "",
        owner,
        amount: review.amount.toString(),
        nonce,
        kind: next.kind,
        status: "requesting",
      });
      let hash: Hex;
      try {
        const amount = `${formatUnits(review.amount, 6)} test AUSD`;
        const description = {
          "enable-forwarding":
            "Allow the Perpl Exchange administrator to forward orders for this testnet account. This permission persists beyond API-session expiry. No order is placed by this approval.",
          "claim-test-ausd":
            "Claim test AUSD from Agora into this wallet. This does not deposit into Perpl.",
          "reset-allowance":
            "Reset the Perpl Exchange token allowance to zero.",
          approve: `Allow the Perpl Exchange to spend exactly ${amount}. This does not deposit funds.`,
          "create-account": `Create your Perpl account and deposit ${amount}.`,
          deposit: `Deposit ${amount} into your existing Perpl account.`,
          withdraw: `Withdraw ${amount} from your Perpl account to this wallet.`,
        }[next.kind];
        hash = await wallet.send(
          {
            ...next,
            from: owner,
            chainId: 10143,
            nonce,
            gasLimit: estimate.gas,
            maxFeePerGas: estimate.maxFeePerGas,
            maxPriorityFeePerGas: estimate.maxPriorityFeePerGas,
          },
          description,
        );
        if (!transactionHash(hash))
          throw Error("Wallet did not return a transaction hash.");
      } catch (cause) {
        attempt = save({
          ...attempt,
          status: rejected(cause) ? "rejected" : "unknown",
        });
        return attempt;
      }
      // A storage failure after broadcast must retain the unresolved record, never trigger a resend.
      try {
        return save({ ...attempt, hash, status: "pending" });
      } catch {
        throw Error(
          `Transaction submitted: ${hash}. Its status could not be saved. Keep this hash and use Check transaction; do not resend.`,
        );
      }
    });
  }
  async function reconcile(recoveryHash?: string) {
    return locked(async () => {
      const attempt = read();
      if (!attempt || !unresolved(attempt)) return attempt;
      const candidate = recoveryHash?.trim() || attempt.hash;
      if (!candidate) return attempt;
      if (!transactionHash(candidate))
        throw Error("Enter a valid transaction hash.");
      const hash = candidate.toLowerCase() as Hex;
      const client = testnetClient(options.reads);
      if ((await client.getChainId()) !== 10143)
        throw Error("RPC is not Monad testnet.");
      const receipt = await client
        .getTransactionReceipt({ hash })
        .catch((cause: unknown) => {
          if (cause instanceof TransactionReceiptNotFoundError) return null;
          throw cause;
        });
      if (!receipt) return attempt;
      const transaction = await client.getTransaction({ hash });
      if (
        transaction.chainId !== 10143 ||
        getAddress(transaction.from) !== owner ||
        transaction.nonce !== attempt.nonce ||
        receipt.transactionHash !== hash ||
        receipt.blockHash !== transaction.blockHash ||
        receipt.blockNumber !== transaction.blockNumber
      )
        throw Error(
          "This transaction does not match the recorded wallet request.",
        );
      const finalized = await client.getBlock({ blockTag: "finalized" });
      if (finalized.number === null || receipt.blockNumber > finalized.number)
        return attempt.hash === hash
          ? attempt
          : save({ ...attempt, hash, status: "pending" });
      const canonical = await client.getBlock({
        blockNumber: receipt.blockNumber,
      });
      if (canonical.hash !== receipt.blockHash)
        throw Error("Transaction is not in the finalized chain. Check again.");
      const expected = fundingStep(attempt.kind, BigInt(attempt.amount), owner);
      const matches =
        transaction.to?.toLowerCase() === expected.to.toLowerCase() &&
        transaction.input === expected.data &&
        transaction.value === 0n;
      if (receipt.status !== "success" && receipt.status !== "reverted")
        throw Error("Transaction result is unavailable.");
      return save({
        ...attempt,
        hash,
        status: !matches
          ? "replaced"
          : receipt.status === "success"
            ? "confirmed"
            : "reverted",
      });
    });
  }
  return { read, submit, reconcile };
}
