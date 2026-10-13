// Source-controlled testnet policy. Never read from environment or client input.
export const executionEnabled = true;
export function validateOrderBody(raw) {
  if (typeof raw !== "string" || raw.length > 4096)
    throw Error("Invalid order body.");
  const body = JSON.parse(raw);
  if (JSON.stringify(body) !== raw)
    throw Error("Use the exact canonical application body.");
  if (
    !body ||
    Object.keys(body).join() !== "d" ||
    !Array.isArray(body.d) ||
    body.d.length !== 1
  )
    throw Error("Exactly one reviewed order is required.");
  const p = body.d[0];
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    // `a` is the only string field: canonical micro-AUSD, and only on a collateral increase.
    Object.entries(p).some(([key, n]) =>
      key === "a" && p.t === 6
        ? typeof n !== "string" || !/^[1-9]\d{0,14}$/.test(n)
        : !Number.isSafeInteger(n) || n < 0,
    )
  )
    throw Error("Orders require exact non-negative integers.");
  const base = ["rq", "acc", "mkt", "t", "s", "lv", "fl", "lb"];
  const fields =
    p.t === 1 || p.t === 2
      ? [...base, "p", "mnp"]
      : p.t === 5
        ? [...base, "oid", "tp", "tpc", "lp"]
        : p.t === 6
          ? [...base, "a", "lp"]
          : [
              ...base,
              "p",
              ...(p.t === 7 ? ["oid"] : ["mnp"]),
              ...(p.tp === undefined ? [] : ["tp", "tpc", "lp"]),
            ];
  if (
    Object.keys(p).sort().join() !== fields.sort().join() ||
    p.rq < 1 ||
    p.acc < 1 ||
    ![16, 32].includes(p.mkt)
  )
    throw Error("Unsupported order fields or identity.");
  if (p.t === 1 || p.t === 2) {
    if (
      p.p < 1 ||
      p.s < 1 ||
      p.lv < 100 ||
      // Perpl's base maximum: BTC (16) 15x, ETH (32) 12x.
      p.lv > (p.mkt === 16 ? 1500 : 1200) ||
      p.fl !== 4 ||
      p.mnp !== 50 ||
      p.lb < 1
    )
      throw Error("Unsupported entry.");
  } else if (p.t === 3 || p.t === 4 || p.t === 7) {
    if (
      p.p < 1 ||
      p.s < 1 ||
      p.lv !== 0 ||
      p.fl !== 4 ||
      (p.t !== 7 && p.mnp !== 0)
    )
      throw Error("Unsupported reduce-only close.");
    if (p.t === 7 && (p.oid < 1 || p.tp === undefined))
      throw Error("Change requires a linked trigger.");
    if (p.tp !== undefined) {
      if (
        p.tp < 1 ||
        p.lp < 1 ||
        ![3, 4].includes(p.tpc) ||
        p.lb !== 0 ||
        !(p.t === 7
          ? child(3, p.p, p.tp) || child(4, p.p, p.tp)
          : child(p.t, p.p, p.tp))
      )
        throw Error("Unbounded protective child.");
    } else if (p.lb < 1) throw Error("Close requires execution expiry.");
  } else if (p.t === 5) {
    if (
      p.oid < 1 ||
      p.s !== 0 ||
      p.lv !== 0 ||
      p.fl !== 4 ||
      p.lb !== 0 ||
      p.tp < 1 ||
      p.lp < 1 ||
      ![3, 4].includes(p.tpc)
    )
      throw Error("Invalid cancellation.");
  } else if (p.t === 6) {
    // IncreasePositionCollateral. Perpl documents `a` and `lp` but gives no worked request,
    // so `s`, `lv`, `fl` and `lb` are unverified. They copy the other order that is not a
    // trade, the linked-exit cancellation: no size, no leverage, fl 4, server-managed expiry.
    if (p.s !== 0 || p.lv !== 0 || p.fl !== 4 || p.lb !== 0 || p.lp < 1)
      throw Error("Invalid collateral increase.");
  } else throw Error("Unsupported order type.");
  return raw; // Preserve the exact signed bytes, including property order.
}

function child(type, price, trigger) {
  return type === 3
    ? price <= trigger && BigInt(price) * 10000n >= BigInt(trigger) * 9950n
    : type === 4 &&
        price >= trigger &&
        BigInt(price) * 10000n <= BigInt(trigger) * 10050n;
}
const open = () =>
  Object.freeze({
    entry: true,
    protection: true,
    management: true,
    recovery: true,
  });
export const executionCapabilities = Object.freeze({
  16: Object.freeze({ Long: open(), Short: open() }),
  32: Object.freeze({ Long: open(), Short: open() }),
});
export function orderCapabilityEnabled(raw) {
  const p = JSON.parse(validateOrderBody(raw)).d[0];
  const market = executionCapabilities[p.mkt];
  if (p.t === 1 || p.t === 2) return market[p.t === 1 ? "Long" : "Short"].entry;
  if (p.t === 3 || p.t === 4)
    return market[p.t === 3 ? "Long" : "Short"][
      p.tp === undefined ? "management" : "protection"
    ];
  // A collateral increase moves no exposure and its wire has no side.
  if (p.t === 6) return market.Long.management && market.Short.management;
  // Change/cancel wire has no side.
  return market.Long.recovery && market.Short.recovery;
}
