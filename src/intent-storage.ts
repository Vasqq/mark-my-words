import type { Intent } from "./financial-model";

export const draftKey = "metropolis-draft";
function parseDraftFields(raw: string): import("./public-draft").PublicDraft {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(
      "The saved sentence is invalid. Edit it in the composer first.",
    );
  const data = value as Record<string, unknown>;
  const amount = (key: string) => {
    const value = data[key];
    if (typeof value !== "string" || !/^\d{1,16}$/.test(value))
      throw Error("The saved sentence contains an invalid amount.");
    const result = BigInt(value);
    if (result <= 0n || result > 9_000_000_000_000_000n)
      throw Error("The saved sentence contains an unsupported amount.");
    return result;
  };
  if (
    (data.market !== "ETH" && data.market !== "BTC") ||
    (data.side !== "long" && data.side !== "short") ||
    typeof data.revision !== "number" ||
    !Number.isSafeInteger(data.revision) ||
    data.revision < 0
  )
    throw Error(
      "The saved sentence has an invalid market, direction or revision.",
    );
  return {
    market: data.market,
    side: data.side,
    revision: data.revision,
    goal: amount("goal"),
    target: amount("target"),
    stop: amount("stop"),
    leverage: amount("leverage"),
  };
}

export function parseIntent(raw: string): Intent {
  const draft = parseDraftFields(raw);
  const data = JSON.parse(raw) as Record<string, unknown>;
  if (typeof data.budget !== "string" || !/^\d{1,16}$/.test(data.budget))
    throw Error("The saved sentence contains an invalid amount.");
  const budget = BigInt(data.budget);
  if (budget <= 0n || budget > 9_000_000_000_000_000n)
    throw Error("The saved sentence contains an unsupported amount.");
  return { ...draft, budget };
}

export function readSavedIntent(
  storage: Pick<Storage, "getItem"> = localStorage,
): Intent {
  const raw = storage.getItem(draftKey);
  if (!raw)
    throw Error(
      "Create a sentence in the composer before reviewing a testnet trade.",
    );
  return parseIntent(raw);
}

/** Independent versioned public draft; legacy positive-budget records remain untouched. */
export const publicDraftKey = "perpl-public-draft-v1";
export function parsePublicDraft(
  raw: string,
): import("./public-draft").PublicDraft {
  return parseDraftFields(raw);
}
export function readPublicDraft(
  storage: Pick<Storage, "getItem"> = localStorage,
): import("./public-draft").PublicDraft | undefined {
  const current = storage.getItem(publicDraftKey);
  if (current !== null) return parsePublicDraft(current);
  const legacy = storage.getItem(draftKey);
  return legacy === null ? undefined : parsePublicDraft(legacy);
}
export function savePublicDraft(
  draft: import("./public-draft").PublicDraft,
  storage: Pick<Storage, "setItem"> = localStorage,
) {
  const raw = JSON.stringify(draft, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  parsePublicDraft(raw);
  storage.setItem(publicDraftKey, raw);
}
