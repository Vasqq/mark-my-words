import type { Intent } from "./financial-model";

/** Public sentence in micro-AUSD, with leverage in hundredths. No account allowance. */
export type PublicDraft = Omit<Intent, "budget">;

/** Called only with freshly observed authenticated spendable collateral. */
export function bindAccountAllowance(
  draft: PublicDraft,
  available: bigint,
): Intent {
  if (available < 0n) throw Error("Available collateral cannot be negative.");
  return { ...draft, budget: available };
}
