import { TF } from "../../view/chart-ranges";
import { MK, rng } from "./core";
export function seedLive(id: string) {
  const m = MK[id];
  const r = rng(m.seed * 5 + 3);
  const n = 160;
  const out = [];
  let v = m.mark0 * (1 - (m.chg / 100) * 0.6);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    v +=
      (m.mark0 * (1 - (m.chg / 100) * 0.6 * (1 - t)) - v) * 0.07 +
      (r() - 0.5) * m.mark0 * 0.0028;
    out.push(v);
  }
  out[n - 1] = m.mark0;
  return out;
}
/* time ranges: Live is the scrolling tape; 1H/1D/1W are seeded walks that end at the live mark */
export function tfChange(id: string, tf: string) {
  return tf === "live" ? NaN : MK[id].chg * (TF[tf].k ?? NaN);
}
export function genRange(id: string, tf: string) {
  const m = MK[id],
    t = TF[tf];
  const r = rng(m.seed * 13 + t.n);
  const n = t.n;
  const start = m.mark0 / (1 + (tfChange(id, tf) ?? 0) / 100);
  const w = [0];
  for (let i = 1; i < n; i++) w.push(w[i - 1] + (r() - 0.5) * 2);
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const br = w[i] - u * w[n - 1];
    out.push((start + (m.mark0 - start) * u) * (1 + br * (t.vol ?? NaN)));
  }
  out[n - 1] = m.mark0;
  return out;
}
