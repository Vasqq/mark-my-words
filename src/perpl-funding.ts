import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { readTestnetAccount, type TestnetAccount } from "./perpl-account";
import {
  testnet,
  testnetClient,
  type TestnetReadOptions,
} from "./testnet-config";

// Existing Exchange methods, from official dex-sdk 78ce8a06. No custom contracts.
export const fundingAbi = parseAbi([
  "function createAccount(uint256 amountCNS) returns (uint256 accountId)",
  "function depositCollateral(uint256 amountCNS)",
  "function withdrawCollateral(uint256 amountCNS)",
  "function allowOrderForwarding(bool allow)",
]);

export const faucetAbi = parseAbi([
  "function token() view returns (address)",
  "function requestFunds(address recipient)",
]);

export interface FundingStep {
  kind:
    | "reset-allowance"
    | "approve"
    | "create-account"
    | "deposit"
    | "claim-test-ausd"
    | "withdraw"
    | "enable-forwarding";
  to: Address;
  data: Hex;
  value: 0n;
}

export interface FundingReview {
  snapshot: TestnetAccount;
  amount: bigint;
  steps: FundingStep[];
  blockers: string[];
  expiresAt: number;
  nextStepEstimate?: {
    gas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    feeCeiling: bigint;
  };
}

export function fundingStep(
  kind: FundingStep["kind"],
  amount: bigint,
  owner?: Address,
): FundingStep {
  if (kind === "enable-forwarding") {
    if (amount !== 0n)
      throw Error("Forwarding approval does not transfer collateral.");
    return {
      kind,
      to: testnet.exchange,
      value: 0n,
      data: encodeFunctionData({
        abi: fundingAbi,
        functionName: "allowOrderForwarding",
        args: [true],
      }),
    };
  }
  if (kind === "claim-test-ausd") {
    if (!owner) throw Error("A faucet claim requires its wallet recipient.");
    return {
      kind,
      to: testnet.ausdFaucet,
      value: 0n,
      data: encodeFunctionData({
        abi: faucetAbi,
        functionName: "requestFunds",
        args: [owner],
      }),
    };
  }
  const approval = kind === "approve" || kind === "reset-allowance";
  return {
    kind,
    to: approval ? testnet.collateral : testnet.exchange,
    value: 0n,
    data: approval
      ? encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [testnet.exchange, kind === "reset-allowance" ? 0n : amount],
        })
      : encodeFunctionData({
          abi: fundingAbi,
          functionName:
            kind === "create-account"
              ? "createAccount"
              : kind === "withdraw"
                ? "withdrawCollateral"
                : "depositCollateral",
          args: [amount],
        }),
  };
}

function fundingAmount(input: string): bigint {
  // parseUnits rounds excess precision. Reject it before parsing user money.
  if (!/^\d{1,20}(\.\d{1,6})?$/.test(input.trim()))
    throw Error(
      "Enter a positive AUSD amount with at most six decimal places.",
    );
  const amount = parseUnits(input.trim(), 6);
  if (amount <= 0n) throw Error("Enter an amount greater than zero.");
  return amount;
}

export function fundingPlan(
  snapshot: TestnetAccount,
  input: string,
  action: "deposit" | "withdraw" = "deposit",
): FundingReview {
  const amount = fundingAmount(input);
  const expiresAt = Math.min(
    snapshot.receivedAt + 30000,
    snapshot.blockTime + 60000,
  );
  if (snapshot.chainId !== 10143 || Date.now() >= expiresAt)
    throw Error("Refresh the testnet account before reviewing funding.");
  const blockers: string[] = [];
  if (
    action === "deposit" &&
    !snapshot.exchangeAccount &&
    amount < snapshot.funding.minimumInitialDeposit
  )
    blockers.push(
      `The first deposit must be at least ${formatUnits(snapshot.funding.minimumInitialDeposit, 6)} test AUSD.`,
    );
  if (action === "deposit" && amount > snapshot.walletAusd)
    blockers.push(
      `This wallet needs ${formatUnits(amount - snapshot.walletAusd, 6)} more test AUSD.`,
    );
  if (
    action === "withdraw" &&
    (!snapshot.exchangeAccount || amount > snapshot.exchangeAccount.free)
  )
    blockers.push("Withdrawal exceeds this account's free test AUSD balance.");
  if (snapshot.walletMon === 0n)
    blockers.push("This wallet needs test MON for transaction fees.");
  if (snapshot.funding.halted)
    blockers.push("The Exchange is halted. Funding is unavailable.");
  if (snapshot.funding.addressBlocked || snapshot.exchangeAccount?.frozen)
    blockers.push("This account is restricted by the Exchange.");
  if (snapshot.funding.whitelistEnabled && !snapshot.funding.whitelisted)
    blockers.push("This wallet is not on the Exchange's onchain allowlist.");

  const steps: FundingStep[] = [];
  if (action === "deposit" && snapshot.allowance < amount) {
    if (snapshot.allowance > 0n)
      steps.push(fundingStep("reset-allowance", amount));
    steps.push(fundingStep("approve", amount));
  }
  const existing = snapshot.exchangeAccount !== null;
  steps.push(
    fundingStep(
      action === "withdraw"
        ? "withdraw"
        : existing
          ? "deposit"
          : "create-account",
      amount,
    ),
  );
  return { snapshot, amount, steps, blockers, expiresAt };
}

/** A fresh review and read-only gas simulation, never a signing request. */
export async function reviewFunding(
  address: string,
  input: string,
  options: TestnetReadOptions = {},
  action: "deposit" | "withdraw" = "deposit",
): Promise<FundingReview> {
  fundingAmount(input);
  const snapshot = await readTestnetAccount(address, options);
  return estimateFundingReview(fundingPlan(snapshot, input, action), options);
}

export async function reviewTestAusd(
  address: string,
  options: TestnetReadOptions = {},
): Promise<FundingReview> {
  const snapshot = await readTestnetAccount(address, options);
  const token = await testnetClient(options).readContract({
    address: testnet.ausdFaucet,
    abi: faucetAbi,
    functionName: "token",
    blockNumber: snapshot.block,
  });
  if (getAddress(token) !== getAddress(testnet.collateral))
    throw Error("Faucet token does not match the testnet collateral.");
  return estimateFundingReview(
    {
      snapshot,
      // The contract sets its drip amount. Zero is never interpreted as a deposit.
      amount: 0n,
      steps: [fundingStep("claim-test-ausd", 0n, snapshot.owner)],
      blockers:
        snapshot.walletMon === 0n
          ? ["This wallet needs test MON to claim test AUSD."]
          : [],
      expiresAt: Math.min(
        snapshot.receivedAt + 30000,
        snapshot.blockTime + 60000,
      ),
    },
    options,
  );
}

export async function reviewOrderForwarding(
  address: string,
  options: TestnetReadOptions = {},
): Promise<FundingReview> {
  const snapshot = await readTestnetAccount(address, options);
  const blockers: string[] = [];
  if (!snapshot.exchangeAccount)
    blockers.push("Create a Perpl account before enabling forwarding.");
  if (snapshot.walletMon === 0n)
    blockers.push("This wallet needs test MON for transaction fees.");
  if (
    snapshot.funding.halted ||
    snapshot.funding.addressBlocked ||
    snapshot.exchangeAccount?.frozen
  )
    blockers.push("The Exchange or account is restricted.");
  if (snapshot.funding.whitelistEnabled && !snapshot.funding.whitelisted)
    blockers.push("This wallet is not on the Exchange's onchain allowlist.");
  return estimateFundingReview(
    {
      snapshot,
      amount: 0n,
      steps: [fundingStep("enable-forwarding", 0n)],
      blockers,
      expiresAt: Math.min(
        snapshot.receivedAt + 30000,
        snapshot.blockTime + 60000,
      ),
    },
    options,
  );
}

async function estimateFundingReview(
  review: FundingReview,
  options: TestnetReadOptions,
): Promise<FundingReview> {
  const { snapshot } = review;
  if (review.blockers.length) return review;
  const client = testnetClient(options);
  const next = review.steps[0];
  // Subsequent steps depend on confirmed allowance changes; do not fake them with state overrides.
  const [estimated, fees, simulation] = await Promise.all([
    client.estimateGas({
      account: snapshot.owner,
      to: next.to,
      data: next.data,
      value: 0n,
      blockNumber: snapshot.block,
    }),
    client.estimateFeesPerGas(),
    client.call({
      batch: false,
      account: snapshot.owner,
      to: next.to,
      data: next.data,
      value: 0n,
      blockNumber: snapshot.block,
    }),
  ]);
  options.signal?.throwIfAborted();
  // An exact estimate runs out of gas when state changes before inclusion (a first claim
  // or deposit touches cold storage). Monad charges the limit, so keep the margin modest.
  const gas = (estimated * 3n + 1n) / 2n;
  if (
    (next.kind === "approve" || next.kind === "reset-allowance") &&
    (!simulation.data ||
      !decodeFunctionResult({
        abi: erc20Abi,
        functionName: "approve",
        data: simulation.data,
      }))
  )
    throw Error("Token approval preflight did not return success.");
  if (
    next.kind === "create-account" &&
    (!simulation.data ||
      decodeFunctionResult({
        abi: fundingAbi,
        functionName: "createAccount",
        data: simulation.data,
      }) === 0n)
  )
    throw Error("Account creation preflight did not return an account ID.");
  if (Date.now() >= review.expiresAt)
    throw Error("Funding review expired. Check again.");
  const feeCeiling = gas * fees.maxFeePerGas;
  if (snapshot.walletMon < feeCeiling)
    review.blockers.push(
      "Test MON balance is below the next step's estimated fee ceiling.",
    );
  return {
    ...review,
    nextStepEstimate: {
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      feeCeiling,
    },
  };
}
