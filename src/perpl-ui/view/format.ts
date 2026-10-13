import type { Market } from "../engine/types";
export function fmtUsd(x: number | null | undefined, dp = 2, sign = false) {
  if (x == null || !isFinite(x)) return "—";
  const a = Math.abs(x);
  let s;
  if (a > 0 && a < 0.01 && dp >= 2) s = "<$0.01";
  else
    s =
      "$" +
      a.toLocaleString("en-US", {
        minimumFractionDigits: dp,
        maximumFractionDigits: dp,
      });
  if (x < 0 && s !== "<$0.01") return "−" + s;
  if (sign && x > 0) return "+" + s;
  return s;
}
export const fmtShort = (x: number) =>
  Number.isInteger(Math.round(x * 100) / 100) &&
  Math.abs(x - Math.round(x)) < 1e-9
    ? "$" + Math.round(x).toLocaleString("en-US")
    : fmtUsd(x);
export function fmtP(
  p: number | null | undefined,
  m: Pick<Market, "dp" | "qdp">,
) {
  if (p == null || !isFinite(p)) return "—";
  return (
    "$" +
    (+p).toLocaleString("en-US", {
      minimumFractionDigits: m.dp,
      maximumFractionDigits: m.dp,
    })
  );
}
export const fmtQ = (
  q: number | null | undefined,
  m: Pick<Market, "dp" | "qdp">,
) => (q == null || !isFinite(q) ? "—" : q.toFixed(m.qdp));
export const fmtPct = (x: number) =>
  !Number.isFinite(x)
    ? "—"
    : (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(1) + "%";
export function parseNum(s: string) {
  const t = String(s).replace(/[$,\s]/g, "");
  if (t === "" || !/^\d*\.?\d*$/.test(t) || t === ".") return null;
  const v = parseFloat(t);
  return isFinite(v) ? v : null;
}
