import { decimal, exact, nearest } from "../../../financial-model";
import { readPublicDraft, savePublicDraft } from "../../../intent-storage";
import type { PublicDraft } from "../../../public-draft";
import type { Draft } from "../types";

/** Coordinates are a lossy projection; they never replace unchanged exact fields. */
export function displayDraft(draft: PublicDraft): Draft {
  return {
    market: draft.market,
    side: draft.side,
    goal: Number(exact(draft.goal)),
    target: Number(exact(draft.target)),
    stop: Number(exact(draft.stop)),
    lev: Number(exact(draft.leverage, 2)),
    rev: draft.revision,
  };
}
export function publicDraftFromDisplay(draft: Draft): PublicDraft {
  if (draft.market !== "ETH" && draft.market !== "BTC")
    throw Error("Unsupported market.");
  return {
    market: draft.market,
    side: draft.side,
    revision: draft.rev,
    goal: decimal(String(draft.goal)),
    target: decimal(String(draft.target)),
    stop: decimal(String(draft.stop)),
    leverage: decimal(String(draft.lev), 2),
  };
}

/** Canonical sentence survives rendering, account changes and unrelated edit commands. */
export function createPublicDraftController(
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
) {
  let draft = readPublicDraft(storage);
  const editedFields = new Set<"goal" | "target" | "stop">();
  const get = (fallback: Draft) => (draft ??= publicDraftFromDisplay(fallback));
  const persist = (next: PublicDraft) => {
    savePublicDraft(next, storage);
    draft = next;
    return displayDraft(next);
  };
  return {
    raw(current: Draft, field: "goal" | "target" | "stop") {
      // Show "500", not "500.000000". The exact stored amount is unchanged.
      return exact(get(current)[field]).replace(/\.?0+$/, "");
    },
    editRaw(
      current: Draft,
      field: "goal" | "target" | "stop",
      raw: string,
      commit: boolean,
      tick?: bigint,
    ): Draft {
      const previous = get(current);
      const amount = decimal(raw);
      // Preview has already changed the canonical amount; equality is not proof
      // of an untouched editor. A commit must finish an input-driven edit.
      if (!commit) editedFields.add(field);
      if (commit && !editedFields.has(field) && amount === previous[field])
        return persist({ ...previous, revision: current.rev + 1 });
      const rounded =
        field === "goal"
          ? nearest(amount, 10000n)
          : commit && tick
            ? nearest(amount, tick)
            : amount;
      const value =
        field === "goal" && commit && rounded < 1000000n ? 1000000n : rounded;
      const result = persist({
        ...previous,
        [field]: value,
        revision: current.rev + 1,
      });
      if (commit) editedFields.delete(field);
      return result;
    },
    initial: draft ? displayDraft(draft) : undefined,
    get,
    edit(current: Draft, patch: Partial<Draft>): Draft {
      const previous = get(current);
      const coordinates = displayDraft(previous);
      const next = { ...previous, revision: current.rev + 1 };
      if (patch.market !== undefined) {
        if (patch.market !== "ETH" && patch.market !== "BTC")
          throw Error("Unsupported market.");
        next.market = patch.market;
      }
      if (patch.side !== undefined) next.side = patch.side;
      for (const key of ["goal", "target", "stop"] as const) {
        const value = patch[key];
        if (value !== undefined && value !== coordinates[key])
          next[key] = decimal(String(value));
      }
      if (patch.lev !== undefined && patch.lev !== coordinates.lev)
        next.leverage = decimal(String(patch.lev), 2);
      // Persistence validates exact amounts/revision before any financial use of the edit.
      savePublicDraft(next, storage);
      draft = next;
      return displayDraft(next);
    },
  };
}

/** Exact raw AUSD remains the command input; only this bounded coordinate feeds a slider. */
export function accountAmountDisplay(raw: string): {
  coordinate?: number;
  label: string;
} {
  try {
    const value = decimal(raw);
    const [whole, tail = ""] = exact(value).split(".");
    return {
      coordinate: Number(exact(value)),
      label:
        "$" +
        whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
        "." +
        tail.replace(/0+$/, "").padEnd(2, "0"),
    };
  } catch {
    return { label: "—" };
  }
}
