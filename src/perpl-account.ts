import {
  BaseError,
  ContractFunctionRevertedError,
  erc20Abi,
  getAddress,
  parseAbi,
  zeroAddress,
  type Address,
} from "viem";
import {
  testnet,
  testnetClient,
  type TestnetReadOptions,
} from "./testnet-config";

// Read-only subset of the official Exchange ABI, dex-sdk 78ce8a06.
export const accountAbi = parseAbi([
  "struct PositionBitMap { uint256 bank1; uint256 bank2; uint256 bank3; uint256 bank4; }",
  "struct AccountInfo { uint256 accountId; uint256 balanceCNS; uint256 lockedBalanceCNS; uint8 frozen; address accountAddr; PositionBitMap positions; }",
  "function getAccountByAddr(address accountAddress) view returns (AccountInfo accountInfo)",
  "error AccountDoesNotExist(address accountAddress)",
  "function getMinAccountOpenCNS() view returns (uint256)",
  "function getExchangeInfo() view returns (uint256 balanceCNS, uint256 protocolBalanceCNS, uint256 recycleBalanceCNS, uint256 collateralDecimals, address collateralToken, address verifierProxy)",
  "function isHalted() view returns (bool)",
  "function addressBlocked(address) view returns (bool)",
  "function whitelistingEnabled() view returns (bool)",
  "function whitelisted(address) view returns (bool)",
]);
export interface TestnetAccount {
  owner: Address;
  chainId: 10143;
  block: bigint;
  blockHash: `0x${string}`;
  blockTime: number;
  receivedAt: number;
  walletMon: bigint; // Wei; all AUSD amounts below use six decimals (CNS).
  walletAusd: bigint;
  allowance: bigint;
  funding: {
    minimumInitialDeposit: bigint;
    halted: boolean;
    addressBlocked: boolean;
    whitelistEnabled: boolean;
    whitelisted: boolean;
  };
  exchangeAccount: {
    id: bigint;
    balance: bigint;
    free: bigint;
    locked: bigint;
    frozen: number;
    hasPosition: boolean;
  } | null;
}

/** Public chain reads only. All values come from one finalized block. */
export async function readTestnetAccount(
  address: string,
  options: TestnetReadOptions = {},
): Promise<TestnetAccount> {
  options.signal?.throwIfAborted();
  const owner = getAddress(address);
  if (owner === zeroAddress) throw Error("Select a nonzero wallet address.");
  const client = testnetClient(options);
  if ((await client.getChainId()) !== 10143)
    throw Error("RPC is not Monad testnet. Account reads stopped.");
  const block = await client.getBlock({ blockTag: "finalized" });
  if (!block.hash || block.number === null)
    throw Error("Finalized block unavailable.");
  const blockTime = Number(block.timestamp) * 1000;
  if (
    !Number.isSafeInteger(blockTime) ||
    Date.now() - blockTime > 60000 ||
    blockTime > Date.now() + 2000
  )
    throw Error("Finalized chain data is stale or has an invalid timestamp.");
  const blockNumber = block.number;
  const accountRequest = client
    .readContract({
      address: testnet.exchange,
      abi: accountAbi,
      functionName: "getAccountByAddr",
      args: [owner],
      blockNumber,
    })
    .catch((error: unknown) => {
      const reverted =
        error instanceof BaseError
          ? error.walk(
              (cause) => cause instanceof ContractFunctionRevertedError,
            )
          : undefined;
      if (
        reverted instanceof ContractFunctionRevertedError &&
        reverted.data?.errorName === "AccountDoesNotExist" &&
        getAddress(String(reverted.data.args?.[0])) === owner
      )
        return null;
      throw error;
    });
  const [
    account,
    walletMon,
    walletAusd,
    decimals,
    allowance,
    minimumInitialDeposit,
    exchange,
    halted,
    addressBlocked,
    whitelistEnabled,
    whitelisted,
  ] = await Promise.all([
    accountRequest,
    client.getBalance({ address: owner, blockNumber }),
    client.readContract({
      address: testnet.collateral,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
      blockNumber,
    }),
    client.readContract({
      address: testnet.collateral,
      abi: erc20Abi,
      functionName: "decimals",
      blockNumber,
    }),
    client.readContract({
      address: testnet.collateral,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, testnet.exchange],
      blockNumber,
    }),
    client.readContract({
      address: testnet.exchange,
      abi: accountAbi,
      functionName: "getMinAccountOpenCNS",
      blockNumber,
    }),
    client.readContract({
      address: testnet.exchange,
      abi: accountAbi,
      functionName: "getExchangeInfo",
      blockNumber,
    }),
    client.readContract({
      address: testnet.exchange,
      abi: accountAbi,
      functionName: "isHalted",
      blockNumber,
    }),
    client.readContract({
      address: testnet.exchange,
      abi: accountAbi,
      functionName: "addressBlocked",
      args: [owner],
      blockNumber,
    }),
    client.readContract({
      address: testnet.exchange,
      abi: accountAbi,
      functionName: "whitelistingEnabled",
      blockNumber,
    }),
    client.readContract({
      address: testnet.exchange,
      abi: accountAbi,
      functionName: "whitelisted",
      args: [owner],
      blockNumber,
    }),
  ]);
  options.signal?.throwIfAborted();
  if (decimals !== 6 || exchange[3] !== 6n)
    throw Error("Unsupported collateral decimals. Account reads stopped.");
  if (getAddress(exchange[4]) !== getAddress(testnet.collateral))
    throw Error("Exchange collateral token does not match this environment.");
  if (
    account &&
    (account.accountId === 0n || getAddress(account.accountAddr) !== owner)
  )
    throw Error("Exchange account identity does not match this wallet.");
  return {
    owner,
    chainId: 10143,
    block: blockNumber,
    blockHash: block.hash,
    blockTime,
    receivedAt: Date.now(),
    walletMon,
    walletAusd,
    allowance,
    funding: {
      minimumInitialDeposit,
      halted,
      addressBlocked,
      whitelistEnabled,
      whitelisted,
    },
    exchangeAccount: account
      ? {
          id: account.accountId,
          balance: account.balanceCNS,
          free:
            account.balanceCNS > account.lockedBalanceCNS
              ? account.balanceCNS - account.lockedBalanceCNS
              : 0n,
          locked: account.lockedBalanceCNS,
          frozen: account.frozen,
          hasPosition: Object.values(account.positions).some(
            (bank) => bank !== 0n,
          ),
        }
      : null,
  };
}
