import { getAddress } from "viem";

export type AccountStorage = Pick<Storage, "getItem" | "setItem">;
export type AccountLock = <T>(
  name: string,
  work: () => Promise<T>,
) => Promise<T>;

export function accountLockName(owner: string) {
  return `perpl-account-v1:10143:${getAddress(owner).toLowerCase()}`;
}

export const accountLock: AccountLock = async (name, work) => {
  if (!navigator.locks)
    throw Error("This browser cannot safely coordinate account changes.");
  return navigator.locks.request(name, { ifAvailable: true }, (held) => {
    if (!held)
      throw Error(
        "Another tab is handling this wallet. Wait for it to finish.",
      );
    return work();
  });
};
