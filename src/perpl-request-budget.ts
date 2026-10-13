import type { AccountStorage, AccountLock } from "./account-coordination";
export type RequestPriority = "observation" | "recovery" | "write";
const key = "perpl-handler-budget-v2";
// Mirrors server/account-api.mjs: order writes, then recovery, go before background reads.
const ceilings = { write: 110, recovery: 104, observation: 96 } as const;
/** The order provably never reached Perpl, or Perpl refused the HTTP request. Safe to treat as not placed. */
export class OrderNotSent extends Error {}
export class RequestDeferred extends Error {
  constructor(public readonly retryAt: number) {
    super("Too many account requests this minute. Retrying shortly.");
  }
}
/** Non-secret, handler-wide sliding minute shared by all accounts and tabs. */
export function createRequestBudget(
  storage: AccountStorage = localStorage,
  lock: AccountLock = async (name, work) => {
    if (!navigator.locks)
      throw Error("This browser cannot safely coordinate account requests.");
    return navigator.locks.request(name, work);
  },
  now = Date.now,
) {
  const read = () => {
    const raw = storage.getItem(key);
    const value: unknown = raw === null ? [] : JSON.parse(raw);
    if (
      !Array.isArray(value) ||
      value.length > ceilings.write ||
      value.some((v) => !Number.isSafeInteger(v) || v > now() + 2000)
    )
      throw Error("Account request budget could not be verified.");
    return (value as number[]).filter((at) => now() - at < 60000);
  };
  return {
    async take(count: number, priority: RequestPriority = "observation") {
      if (!Number.isInteger(count) || count < 1 || count > ceilings.write)
        throw Error("Invalid account sequence budget.");
      return lock("perpl-handler-budget:10143", async () => {
        const used = read();
        if (used.length + count > ceilings[priority])
          throw new RequestDeferred((used[0] ?? now()) + 60001);
        const encoded = JSON.stringify([
          ...used,
          ...Array.from({ length: count }, () => now()),
        ]);
        storage.setItem(key, encoded);
        if (storage.getItem(key) !== encoded)
          throw Error("Account sequence budget could not be saved.");
      });
    },
    available: () => ceilings.write - read().length,
  };
}
