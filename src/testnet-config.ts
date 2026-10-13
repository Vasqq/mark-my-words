import { monadTestnet } from "viem/chains";
import { createPublicClient, http, type Transport } from "viem";

export const testnet = {
  chain: monadTestnet,
  rpc: "https://testnet-rpc.monad.xyz",
  exchange: "0x1964C32f0bE608E7D29302AFF5E61268E72080cc",
  ausdFaucet: "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C",
  collateral: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC",
} as const;

export interface TestnetReadOptions {
  signal?: AbortSignal;
  transport?: Transport;
}

export function testnetClient(options: TestnetReadOptions = {}) {
  return createPublicClient({
    chain: testnet.chain,
    batch: { multicall: { wait: 10 } },
    transport:
      options.transport ??
      http(testnet.rpc, {
        retryCount: 1,
        retryDelay: 1000,
        timeout: 8000,
        fetchOptions: { signal: options.signal, credentials: "omit" },
      }),
  });
}
