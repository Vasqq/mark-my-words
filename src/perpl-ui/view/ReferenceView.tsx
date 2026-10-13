import { AccountSurface } from "./AccountSurface";
import { presentCalculation } from "./plan";
import { TF } from "./chart-ranges";
import { fmtUsd, fmtShort, fmtP, fmtQ, fmtPct, parseNum } from "./format";
import { useEngine, EngineProvider } from "../engine/context";
import type {
  PerplEngine,
  CompleteCalculation,
  Draft,
  Position,
  SignRequest,
  ChartProps,
  ChartCurrent,
  ChartState,
  SliderProps,
  EditorProps,
  OverlayProps,
  PerplStyle,
} from "../engine/types";
type Gate = (req: SignRequest, need?: number) => Promise<boolean>;
import React, {
  useState,
  useEffect,
  useRef,
  useLayoutEffect,
  useId,
} from "react";
import * as ReactDOM from "react-dom";
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const DAY = {
  font: "Inter Tight",
  mono: "JetBrains Mono",
  grid: "rgba(20,18,16,.06)",
  axis: "rgba(20,18,16,.45)",
  zoneGain: "rgba(58,165,119,.09)",
  zoneLoss: "rgba(224,119,90,.10)",
  hatch: "rgba(212,81,58,.14)",
  area: "rgba(20,18,16,.07)",
  line: "#141210",
  now: "rgba(20,18,16,.25)",
  pulse: "#141210",
  entry: "rgba(20,18,16,.55)",
  target: "#3aa577",
  stop: "#e0775a",
  loss: "#d4513a",
  gain: "#1f9d63",
  cross: "rgba(20,18,16,.3)",
  tipBg: "#141210",
  tipFg: "#fff",
};
const NIGHT = {
  font: "Inter Tight",
  mono: "JetBrains Mono",
  grid: "rgba(255,255,255,.05)",
  axis: "rgba(255,255,255,.38)",
  zoneGain: "rgba(111,220,170,.08)",
  zoneLoss: "rgba(255,155,128,.08)",
  hatch: "rgba(255,122,98,.16)",
  area: "rgba(255,255,255,.09)",
  line: "#f3f1ee",
  now: "rgba(255,255,255,.2)",
  pulse: "#ffffff",
  entry: "rgba(207,203,198,.8)",
  target: "#6fdcaa",
  stop: "#ff9b80",
  loss: "#ff7a62",
  gain: "#6fdcaa",
  cross: "rgba(255,255,255,.35)",
  tipBg: "rgba(0,0,0,.85)",
  tipFg: "#fff",
};
const LAYOUT = (W: number, _H: number) => {
  const mob = W < 700;
  const hw = mob ? 120 : 186;
  const xR = W - hw - 12;
  return {
    padT: mob ? 84 : 60,
    padB: 34,
    xR,
    nowX: xR * (mob ? 0.38 : 0.55),
  };
};

/* ================= Fixtures (simulated) ================= */

/* ================= Small components ================= */
const DIG = "0123456789".split("");
export function Odo({ text }: { text: string }) {
  const ch = [...text];
  return (
    <span className={"odo"} aria-label={text} role={"text"}>
      {ch.map((c, i) => {
        const k = ch.length - i;
        return /\d/.test(c) ? (
          <span className={"odo-c"} key={"d" + k} aria-hidden={"true"}>
            <span
              className={"odo-s"}
              style={{
                transform: `translateY(${-+c * 1.08}em)`,
              }}
            >
              {DIG.map((d) => (
                <span key={d}>{d}</span>
              ))}
            </span>
          </span>
        ) : (
          <span className={"odo-x"} key={"x" + k + c} aria-hidden={"true"}>
            {c}
          </span>
        );
      })}
    </span>
  );
}
export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
  color,
  badge,
  label,
  valuetext,
  disabled,
  marks = [],
}: SliderProps) {
  const ref = useRef<HTMLDivElement>(null!);
  const st = useRef<{
    start: number | null;
    drag: boolean;
  }>({
    start: null,
    drag: false,
  });
  const [drag, setDrag] = useState(false);
  const span = max - min || 1;
  const pct = clamp((value - min) / span, 0, 1) * 100;
  const fromX = (x: number) => {
    const r = ref.current.getBoundingClientRect();
    let v = min + clamp((x - r.left) / r.width, 0, 1) * span;
    v = Math.round((v - min) / step) * step + min;
    return clamp(+v.toFixed(6), min, max);
  };
  const down = (e: React.PointerEvent<HTMLElement>) => {
    if (disabled || !e.isPrimary) return;
    e.preventDefault();
    ref.current.focus({
      preventScroll: true,
    });
    st.current = {
      start: value,
      drag: true,
    };
    setDrag(true);
    ref.current.setPointerCapture && ref.current.setPointerCapture(e.pointerId);
    onChange(fromX(e.clientX));
  };
  const move = (e: React.PointerEvent<HTMLElement>) => {
    if (st.current.drag && e.isPrimary) onChange(fromX(e.clientX));
  };
  const up = () => {
    if (!st.current.drag) return;
    st.current.drag = false;
    setDrag(false);
    onCommit && onCommit();
  };
  const cancel = () => {
    if (!st.current.drag) return;
    st.current.drag = false;
    setDrag(false);
    onChange(st.current.start ?? value);
  };
  const key = (e: React.KeyboardEvent<HTMLElement>) => {
    const keys: Record<string, number> = {
      ArrowRight: step,
      ArrowUp: step,
      ArrowLeft: -step,
      ArrowDown: -step,
      PageUp: step * 10,
      PageDown: -step * 10,
    };
    const k = keys[e.key];
    if (k != null) {
      e.preventDefault();
      onChange(clamp(+(value + k).toFixed(6), min, max));
    } else if (e.key === "Home") {
      e.preventDefault();
      onChange(min);
    } else if (e.key === "End") {
      e.preventDefault();
      onChange(max);
    }
  };
  return (
    <div
      className={"sl" + (drag ? " drag" : "")}
      ref={ref}
      role={"slider"}
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valuetext}
      aria-disabled={!!disabled}
      style={
        {
          "--c": color,
        } as PerplStyle
      }
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      onKeyDown={key}
      onKeyUp={(e) => {
        if (/Arrow|Page|Home|End/.test(e.key)) onCommit && onCommit();
      }}
    >
      <div className={"sl-track"}>
        <div
          className={"sl-fill"}
          style={{
            width: `calc(${pct}% + ${12 - pct * 0.24}px)`,
          }}
        />
        {marks.map((mk, i) => (
          <span
            key={i}
            className={"sl-mark"}
            style={{
              left: clamp((mk - min) / span, 0, 1) * 100 + "%",
            }}
          />
        ))}
      </div>
      <div
        className={"sl-thumb"}
        style={{
          left: `calc(${pct}% + ${12 - pct * 0.24}px)`,
        }}
      >
        {badge && <span className={"sl-badge"}>{badge}</span>}
      </div>
    </div>
  );
}

/* ================= Shared hooks: simulated marks + simulator ================= */

/* ================= LiveChart: 60fps canvas chart with draggable target/stop handles =================
   Canvas draws history, zones and lines every frame; the price eases toward each new tick and the
   series scrolls continuously between ticks. Handles are DOM (focusable, draggable) positioned per frame. */
function tfTime(tf: string, ago: number, base: number | undefined) {
  if (tf === "live") return ago < 1 ? "now" : `${Math.round(ago / 1000)}s ago`;
  const d = new Date((base || Date.now()) - ago);
  if (tf === "1W")
    return d.toLocaleString([], {
      weekday: "short",
      hour: "numeric",
    });
  return d.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
function LiveChart({
  market,
  mark,
  lv,
  pos,
  T: theme,
  onTarget,
  onStop,
  onAmend,
  layout,
  pnlAxis,
  tf = "live",
}: ChartProps) {
  const engine = useEngine();
  const { markets: MK, seedLive, genRange, roundTick, fixP } = engine;

  const m = MK[market];
  const wrap = useRef<HTMLDivElement>(null!);
  const cv = useRef<HTMLCanvasElement>(null!);
  const hT = useRef<HTMLButtonElement>(null!);
  const hS = useRef<HTMLButtonElement>(null!);
  const pT = useRef<HTMLDivElement>(null!);
  const pS = useRef<HTMLDivElement>(null!);
  const mk = useRef<HTMLDivElement>(null!);
  const st = useRef<ChartState>({
    rng: {},
    hx: null,
    hist: {
      ETH: seedLive("ETH"),
      BTC: seedLive("BTC"),
    },
    disp: mark,
    last: performance.now(),
    dom: null,
    drag: null,
    hover: null,
    W: 800,
    H: 500,
    Y: (_v: number) => NaN,
    pOf: (_y: number) => NaN,
    t0: performance.now(),
  });
  const observedSeries =
    tf === "live"
      ? engine.chartHistory?.[market]
      : engine.chartRanges?.[market + tf];
  useEffect(() => {
    engine.loadChartRange?.(market, tf);
  }, [market, tf, engine.markets[market].tick]);
  useEffect(() => {
    if (engine.kind !== "live") return;
    const samples =
      observedSeries?.state === "observed" ? observedSeries.value : [];
    if (tf === "live") {
      // The engine hands over one seed per market; after that the chart appends each
      // tick itself, exactly as it does for the reference data.
      if (st.current.seed?.[market] !== samples && samples.length) {
        st.current.seed = { ...st.current.seed, [market]: samples };
        st.current.hist[market] = samples.map((sample) => sample.price);
      }
    } else {
      st.current.rng[market + tf] = samples.map((sample) => sample.price);
      st.current.rngT = {
        ...st.current.rngT,
        [market + tf]:
          observedSeries?.state === "observed"
            ? (observedSeries.range?.to ?? samples.at(-1)?.time ?? Date.now())
            : Date.now(),
      };
    }
    st.current.times = {
      ...st.current.times,
      [market]: samples.map((sample) => sample.time),
    };
    if (Number.isFinite(mark) && !Number.isFinite(st.current.disp))
      st.current.disp = mark;
  }, [observedSeries, mark, market, tf]);
  const { T, S, E, liq, q } = lv;
  const d = lv.side === "long" ? 1 : -1;
  const P = useRef<ChartCurrent>({
    market,
    mark,
    T,
    S,
    E,
    liq,
    q,
    d,
    pos,
    onTarget,
    onStop,
    onAmend,
    layout,
    m,
    pnlAxis,
    tf,
    theme: theme,
  });
  P.current = {
    market,
    mark,
    T,
    S,
    E,
    liq,
    q,
    d,
    pos,
    onTarget,
    onStop,
    onAmend,
    theme,
    layout,
    m,
    pnlAxis,
    tf,
  };
  // append each new tick
  useEffect(() => {
    const s = st.current;
    const h = s.hist[market];
    // A live engine paces the line with markTick, so a flat stretch still scrolls.
    if (
      Number.isFinite(mark) &&
      (engine.kind === "demo" || engine.markTick !== undefined)
    ) {
      h.push(mark);
      if (!Number.isFinite(s.disp)) s.disp = mark;
    }
    if (h.length > 160) h.shift();
    s.last = performance.now();
  }, [mark, market, engine.markTick]);
  useEffect(() => {
    st.current.disp = mark;
    st.current.dom = null;
  }, [market]);
  useEffect(() => {
    st.current.dom = null;
  }, [tf]);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => {
      const s = st.current;
      s.W = e.contentRect.width;
      s.H = e.contentRect.height;
      const dpr = Math.min(2, devicePixelRatio || 1);
      cv.current.width = s.W * dpr;
      cv.current.height = s.H * dpr;
      cv.current.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    let raf: number;
    const g = cv.current.getContext("2d");
    if (!g) return;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const s = st.current;
      const p = P.current;
      const th = p.theme;
      if (!Number.isFinite(p.mark)) {
        g.clearRect(0, 0, s.W, s.H);
        return;
      }
      const L = p.layout(s.W, s.H);
      const W = s.W,
        H = s.H;
      s.disp += (p.mark - s.disp) * (reduce ? 1 : 0.12);
      const live = p.tf === "live";
      const TICK = 600;
      let h, frac;
      if (live) {
        h = s.hist[p.market];
        frac = reduce ? 0 : Math.min(1, (now - s.last) / TICK);
      } else {
        const key = p.market + p.tf;
        const base = s.rng[key] || (s.rng[key] = genRange(p.market, p.tf));
        const k = s.disp / base[base.length - 1];
        h = engine.kind === "demo" ? base.map((v) => v * k) : base;
        frac = 0;
      }
      const n = h.length;
      // domain
      const recent = live ? h.slice(-120) : h;
      const vals = [s.disp, p.T, p.S, p.E, ...recent].filter(
        (x) => x > 0 && isFinite(x),
      );
      let lo = Math.min(...vals),
        hi = Math.max(...vals);
      const pad = (hi - lo) * 0.1 || p.mark * 0.02;
      lo -= pad;
      hi += pad;
      if (!s.dom) s.dom = [lo, hi];
      if (!s.drag) {
        s.dom[0] += (lo - s.dom[0]) * 0.1;
        s.dom[1] += (hi - s.dom[1]) * 0.1;
      }
      if (wrap.current) {
        wrap.current.style.setProperty("--xr", L.xR + "px");
        wrap.current.style.setProperty("--nowx", L.nowX + "px");
      }
      const [y0, y1] = s.dom;
      const Y = (v: number) =>
        L.padT + (1 - (v - y0) / (y1 - y0)) * (H - L.padT - L.padB);
      s.Y = Y;
      s.pOf = (y) =>
        y0 + (1 - (y - L.padT) / (H - L.padT - L.padB)) * (y1 - y0);
      s.L = L;
      g.clearRect(0, 0, W, H);
      // grid + axis
      const span = y1 - y0,
        raw = span / 6,
        mag = Math.pow(10, Math.floor(Math.log10(raw))),
        stp =
          [1, 2, 2.5, 5, 10].map((x) => x * mag).find((x) => x >= raw) ??
          mag * 10;
      g.font = `500 10.5px ${th.mono}`;
      g.textAlign = "right";
      for (let v = Math.ceil(y0 / stp) * stp; v < y1; v += stp) {
        const y = Math.round(Y(v)) + 0.5;
        g.strokeStyle = th.grid;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(L.xR, y);
        g.stroke();
        g.fillStyle = th.axis;
        g.fillText(
          "$" +
            v.toLocaleString("en-US", {
              maximumFractionDigits: 0,
            }),
          L.xR - 6,
          y - 5,
        );
        if (p.pnlAxis && p.q) {
          const pl = p.d * p.q * (v - p.E);
          g.textAlign = "left";
          g.fillStyle = pl >= 0 ? th.gain : th.loss;
          g.fillText(
            // A small position moves by cents per gridline, so whole dollars would all read $0.
            (pl >= 0 ? "+" : "−") +
              "$" +
              Math.abs(pl).toFixed(p.q * stp < 1 ? 2 : 0),
            6,
            y - 5,
          );
          g.textAlign = "right";
        }
      }
      // zones
      const xL = L.nowX,
        xR = L.xR;
      g.fillStyle = th.zoneGain;
      g.fillRect(
        xL,
        Math.min(Y(p.T), Y(p.E)),
        xR - xL,
        Math.abs(Y(p.T) - Y(p.E)),
      );
      g.fillStyle = th.zoneLoss;
      g.fillRect(
        xL,
        Math.min(Y(p.S), Y(p.E)),
        xR - xL,
        Math.abs(Y(p.S) - Y(p.E)),
      );
      if (p.liq > 0) {
        const yl = Y(p.liq);
        g.save();
        g.beginPath();
        if (p.d > 0) g.rect(xL, yl, xR - xL, H - yl);
        else g.rect(xL, 0, xR - xL, yl);
        g.clip();
        g.strokeStyle = th.hatch;
        g.lineWidth = 2;
        for (let x = xL - H; x < xR; x += 9) {
          g.beginPath();
          g.moveTo(x, H);
          g.lineTo(x + H, 0);
          g.stroke();
        }
        g.restore();
      }
      // The Live tab always uses the reference scroll geometry. A live engine's ranges are
      // placed by their real timestamps instead.
      const dx = live
        ? L.nowX / Math.max(1, n - 2)
        : L.nowX / Math.max(1, n - 1);
      const pts: [number, number][] = [];
      if (engine.kind === "demo" || (live && n > 1)) {
        // history (scrolls continuously between ticks)
        const demoDx = dx;

        for (let i = 0; i < n; i++) {
          const x = live ? (i - 1 - frac) * demoDx : i * demoDx;
          const v = i === n - 1 ? s.disp : h[i];
          pts.push([x, Y(v)]);
        }
        pts[n - 1][0] = L.nowX;
        const grad = g.createLinearGradient(0, L.padT, 0, H);
        grad.addColorStop(0, th.area);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < n; i++) {
          const [a, b] = pts[i - 1],
            [c, e] = pts[i];
          g.quadraticCurveTo(a, b, (a + c) / 2, (b + e) / 2);
        }
        g.lineTo(pts[n - 1][0], pts[n - 1][1]);
        g.save();
        g.lineTo(L.nowX, H);
        g.lineTo(pts[0][0], H);
        g.closePath();
        g.fillStyle = grad;
        g.fill();
        g.restore();
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < n; i++) {
          const [a, b] = pts[i - 1],
            [c, e] = pts[i];
          g.quadraticCurveTo(a, b, (a + c) / 2, (b + e) / 2);
        }
        g.lineTo(pts[n - 1][0], pts[n - 1][1]);
        g.strokeStyle = th.line;
        g.lineWidth = 2;
        g.lineJoin = "round";
        g.stroke();
      } else {
        const times = s.times?.[p.market] ?? [];
        for (let i = 0; i < h.length; i++) {
          const time = times[i];
          if (!Number.isFinite(time) || !Number.isFinite(h[i])) continue;
          const end = live
            ? Date.now()
            : (s.rngT?.[p.market + p.tf] ?? times.at(-1)!);
          const span = live ? 90000 : TF[p.tf].n * TF[p.tf].ms;
          pts.push([L.nowX - ((end - time) / span) * L.nowX, Y(h[i])]);
        }
        if (pts.length >= 2) {
          g.beginPath();
          g.moveTo(pts[0][0], pts[0][1]);
          for (const point of pts.slice(1)) g.lineTo(point[0], point[1]);
          g.strokeStyle = th.line;
          g.lineWidth = 2;
          g.stroke();
        }
      }
      // now line + pulse
      g.setLineDash([3, 4]);
      g.strokeStyle = th.now;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(L.nowX + 0.5, L.padT - 30);
      g.lineTo(L.nowX + 0.5, H - L.padB + 24);
      g.stroke();
      g.setLineDash([]);
      const ym = Y(s.disp);
      const pr = (((now - s.t0) / 1000) % 2) / 2;
      g.fillStyle = th.pulse;
      g.globalAlpha = (1 - pr) * 0.35;
      g.beginPath();
      g.arc(L.nowX, ym, 4 + pr * 12, 0, 7);
      g.fill();
      g.globalAlpha = 1;
      g.fillStyle = th.line;
      g.beginPath();
      g.arc(L.nowX, ym, 4, 0, 7);
      g.fill();
      g.font = `500 10.5px ${th.mono}`;
      g.fillStyle = th.axis;
      g.textAlign = "left";
      g.fillText("now", L.nowX + 6, H - L.padB + 20);
      // time labels along the bottom of the history side
      g.font = `500 10.5px ${th.mono}`;
      g.fillStyle = th.axis;
      g.textAlign = "center";
      const tcfg = TF[p.tf];
      {
        const narrow = L.nowX < 420;
        const tick = (x: number, lab: string) => {
          if (x < 28 || x > L.nowX - 36) return;
          g.globalAlpha = 0.6;
          g.strokeStyle = th.grid;
          g.beginPath();
          g.moveTo(x + 0.5, L.padT);
          g.lineTo(x + 0.5, H - L.padB + 6);
          g.stroke();
          g.globalAlpha = 1;
          g.fillText(lab, x, H - L.padB + 20);
        };
        if (live) {
          // relative labels: "30s ago" is always the same distance from now, so they never move
          for (const sec of narrow ? [60] : [30, 60, 90])
            tick(L.nowX - ((sec * 1000) / tcfg.ms) * dx, `${sec}s ago`);
        } else if (!live && engine.kind === "demo") {
          // the range series is static, so its clock labels are pinned to when the range was opened
          const key = p.market + p.tf;
          s.rngT = s.rngT || {};
          const nowT = s.rngT[key] || (s.rngT[key] = Date.now());
          const span = (n - 1) * tcfg.ms;
          const step =
            {
              "1H": narrow ? 30 * 60e3 : 15 * 60e3,
              "1D": narrow ? 12 * 3600e3 : 6 * 3600e3,
              "1W": narrow ? 2 * 864e5 : 864e5,
            }[p.tf] ?? 1;
          const off = p.tf === "1H" ? 0 : new Date().getTimezoneOffset() * 60e3;
          for (
            let t = Math.ceil((nowT - span - off) / step) * step + off;
            t < nowT;
            t += step
          ) {
            const i = n - 1 - (nowT - t) / tcfg.ms;
            const d = new Date(t);
            tick(
              i * dx,
              p.tf === "1H"
                ? d.toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })
                : p.tf === "1D"
                  ? d.toLocaleTimeString([], {
                      hour: "numeric",
                    })
                  : d.toLocaleDateString([], {
                      weekday: "short",
                    }),
            );
          }
        } else if (engine.kind === "live") {
          const end = live ? Date.now() : s.rngT?.[p.market + p.tf];
          if (end && pts.length) {
            const span = live ? 90000 : TF[p.tf].n * TF[p.tf].ms;
            const step = live
              ? 30000
              : p.tf === "1H"
                ? narrow
                  ? 1800000
                  : 900000
                : p.tf === "1D"
                  ? narrow
                    ? 43200000
                    : 21600000
                  : narrow
                    ? 172800000
                    : 86400000;
            for (
              let time = Math.ceil((end - span) / step) * step;
              time < end;
              time += step
            )
              tick(
                L.nowX - ((end - time) / span) * L.nowX,
                live
                  ? `${Math.round((end - time) / 1000)}s ago`
                  : p.tf === "1W"
                    ? new Date(time).toLocaleDateString([], {
                        weekday: "short",
                      })
                    : new Date(time).toLocaleTimeString([], {
                        hour: "numeric",
                        minute: p.tf === "1H" ? "2-digit" : undefined,
                      }),
              );
          }
        }
      }
      // high / low of the visible range
      if (pts.length >= 2) {
        let hi = 0,
          lo = 0;
        const from = live ? 1 : 0;
        for (let i = from; i < n; i++) {
          if (h[i] > h[hi] || hi < from) hi = i;
          if (h[i] < h[lo] || lo < from) lo = i;
        }
        g.font = `600 10.5px ${th.mono}`;
        g.fillStyle = th.axis;
        const lab = (i: number, up: boolean) => {
          const [x, y] = pts[i];
          if (x < 64 || x > L.nowX - 50) return;
          g.textAlign = "center";
          g.fillText(
            (up ? "H " : "L ") + fmtP(h[i], p.m),
            x,
            up ? y - 9 : y + 17,
          );
          g.beginPath();
          g.arc(x, y, 2.4, 0, 7);
          g.fill();
        };
        lab(hi, true);
        lab(lo, false);
      }
      // history hover: time and price
      if (s.hx != null && !s.drag && pts.length >= 2) {
        const i =
          engine.kind === "demo"
            ? Math.max(
                live ? 1 : 0,
                Math.min(
                  n - 1,
                  Math.round(live ? s.hx / dx + 1 + frac : s.hx / dx),
                ),
              )
            : pts.reduce(
                (best, point, index) =>
                  Math.abs(point[0] - s.hx!) < Math.abs(pts[best][0] - s.hx!)
                    ? index
                    : best,
                0,
              );
        const [x, y] = pts[i];
        const v = engine.kind === "demo" && i === n - 1 ? s.disp : h[i];
        g.strokeStyle = th.cross;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x + 0.5, L.padT - 6);
        g.lineTo(x + 0.5, H - L.padB + 6);
        g.stroke();
        g.fillStyle = th.line;
        g.beginPath();
        g.arc(x, y, 4, 0, 7);
        g.fill();
        const ch = (s.disp / v - 1) * 100;
        const txt = `${engine.kind === "demo" || p.tf === "live" ? tfTime(p.tf, (n - 1 - i) * tcfg.ms, s.rngT && s.rngT[p.market + p.tf]) : s.times?.[p.market]?.[i] ? new Date(s.times[p.market][i]).toLocaleTimeString() : "Observed mark"} · ${fmtP(v, p.m)} · ${ch >= 0 ? "+" : "−"}${Math.abs(ch).toFixed(2)}% since`;
        g.font = `600 12px ${th.font}`;
        const tw = g.measureText(txt).width + 18;
        const tx = Math.max(6, Math.min(L.nowX - tw - 6, x - tw / 2)),
          ty = Math.max(4, y - 38);
        g.fillStyle = th.tipBg;
        g.beginPath();
        g.roundRect ? g.roundRect(tx, ty, tw, 24, 8) : g.rect(tx, ty, tw, 24);
        g.fill();
        g.fillStyle = th.tipFg;
        g.textAlign = "left";
        g.fillText(txt, tx + 9, ty + 16);
      }
      // level lines
      const lvl = (
        v: number,
        c: string,
        w: number,
        dash?: number[] | undefined,
        full?: boolean | undefined,
      ) => {
        const y = Y(v);
        g.strokeStyle = c;
        g.lineWidth = w;
        g.setLineDash(dash || []);
        g.globalAlpha = 0.25;
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(W, y);
        g.stroke();
        g.globalAlpha = 1;
        g.beginPath();
        g.moveTo(xL, y);
        g.lineTo(full ? W : xR, y);
        g.stroke();
        g.setLineDash([]);
      };
      lvl(p.E, th.entry, 1.2, [4, 4]);
      if (p.liq > 0) lvl(p.liq, th.loss, 1, [2, 4]);
      lvl(p.T, th.target, s.drag && s.drag.k === "T" ? 2.6 : 1.8);
      lvl(p.S, th.stop, s.drag && s.drag.k === "S" ? 2.6 : 1.8);
      g.font = `500 11px ${th.mono}`;
      g.textAlign = "left";
      g.fillStyle = th.entry;
      g.fillText(
        (p.pos ? "entry " : "entry ≈ ") + fmtP(p.E, p.m),
        xL + 12,
        Y(p.E) + 16,
      );
      if (p.liq > 0 && Y(p.liq) < H - 8 && Y(p.liq) > 8) {
        g.fillStyle = th.loss;
        g.fillText("liq. ≈ " + fmtP(p.liq, p.m), xL + 12, Y(p.liq) + 16);
      }
      // hover readout
      if (s.hover != null && !s.drag && p.q) {
        const v = s.pOf(s.hover);
        const pl = p.d * p.q * (v - p.E);
        g.strokeStyle = th.cross;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(xL, s.hover + 0.5);
        g.lineTo(xR, s.hover + 0.5);
        g.stroke();
        const txt = `${p.m.id} at ${fmtP(v, p.m)} → ${pl >= 0 ? "+" : "−"}$${Math.abs(pl).toFixed(2)}`;
        g.font = `600 12px ${th.font}`;
        const tw = g.measureText(txt).width + 18;
        g.fillStyle = th.tipBg;
        const tx = xR - tw - 8,
          ty = s.hover - 30;
        g.beginPath();
        g.roundRect ? g.roundRect(tx, ty, tw, 24, 8) : g.rect(tx, ty, tw, 24);
        g.fill();
        g.fillStyle = th.tipFg;
        g.textAlign = "left";
        g.fillText(txt, tx + 9, ty + 16);
      }
      // DOM handles
      const place = (el: HTMLElement | null, v: number) => {
        if (!el) return;
        // An exit that has not been read has no place on the chart.
        el.style.visibility = Number.isFinite(v) ? "" : "hidden";
        el.style.transform = `translate3d(0,${Y(v).toFixed(1)}px,0)`;
      };
      place(hT.current, p.T);
      place(hS.current, p.S);
      place(mk.current, s.disp);
      if (pT.current) {
        pT.current.style.visibility = Number.isFinite(p.T) ? "" : "hidden";
        pT.current.style.transform = `translate3d(${xL + 14}px,${(Y(p.T) - 24).toFixed(1)}px,0)`;
      }
      if (pS.current) {
        pS.current.style.visibility = Number.isFinite(p.S) ? "" : "hidden";
        pS.current.style.transform = `translate3d(${xL + 14}px,${(Y(p.S) + (p.d > 0 ? 6 : -24)).toFixed(1)}px,0)`;
      }
      if (mk.current)
        mk.current.firstElementChild!.textContent = fmtP(s.disp, p.m);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
  const down = (k: string) => (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture &&
      e.currentTarget.setPointerCapture(e.pointerId);
    const p = P.current;
    st.current.drag = {
      k,
      start: k === "T" ? p.T : p.S,
      v: k === "T" ? p.T : p.S,
    };
  };
  const move = (e: React.PointerEvent<HTMLElement>) => {
    const s = st.current;
    const r = wrap.current.getBoundingClientRect();
    const y = e.clientY - r.top,
      x = e.clientX - r.left;
    const p = P.current;
    if (s.drag) {
      const v = fixP(roundTick(Math.max(p.m.tick, s.pOf(y)), p.m), p.m);
      s.drag.v = v;
      if (p.pos) s.drag.k === "T" ? p.onTarget(v, true) : p.onStop(v, true);
      else s.drag.k === "T" ? p.onTarget(v) : p.onStop(v);
      return;
    }
    const L = s.L;
    const inY = L && y > L.padT - 10 && y < s.H - L.padB + 10;
    s.hover = inY && x > L.nowX && x < L.xR ? y : null;
    s.hx = inY && x > 0 && x < L.nowX ? x : null;
  };
  const up = () => {
    const s = st.current;
    const g = s.drag;
    s.drag = null;
    const p = P.current;
    if (g && p.pos && g.v !== g.start)
      p.onAmend(
        g.k === "T" ? "tp" : "sl",
        g.v,
        s.Y(g.v) + wrap.current.getBoundingClientRect().top,
      );
  };
  const key = (k: string) => (e: React.KeyboardEvent<HTMLElement>) => {
    const p = P.current;
    const stp = p.mark * 0.001 * (e.shiftKey ? 10 : 1);
    const cur = k === "T" ? p.T : p.S;
    let v = null;
    if (e.key === "ArrowUp") v = cur + stp;
    if (e.key === "ArrowDown") v = cur - stp;
    if (v != null) {
      e.preventDefault();
      v = fixP(roundTick(v, p.m), p.m);
      if (p.pos)
        p.onAmend(
          k === "T" ? "tp" : "sl",
          v,
          st.current.Y(v) + wrap.current.getBoundingClientRect().top,
        );
      else k === "T" ? p.onTarget(v) : p.onStop(v);
    }
  };
  const pl = (x: number) =>
    Number.isFinite(q) && q ? fmtUsd(d * q * (x - E), 2, true) : "";
  return (
    <div
      className={"live"}
      ref={wrap}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={() => {
        st.current.hover = null;
        st.current.hx = null;
      }}
    >
      <canvas ref={cv} aria-hidden={"true"} />
      {engine.kind === "live" && (
        <span
          role="status"
          style={{
            position: "absolute",
            left: 16,
            top: 48,
            fontSize: 11,
            color: "var(--sub)",
            pointerEvents: "none",
          }}
        >
          {observedSeries?.state === "observed"
            ? ""
            : (observedSeries?.reason ??
              (tf === "live" ? "" : `Reading ${tf} history…`))}
        </span>
      )}
      <div className={"lv-pl t"} ref={pT}>
        {pl(T)}
        {pos ? "" : " at target"}
      </div>
      <div className={"lv-pl s"} ref={pS}>
        {pl(S)}
        {pos ? "" : " at stop"}
      </div>
      <div className={"lv-mark"} ref={mk}>
        <span>{fmtP(mark, m)}</span>
      </div>
      <button
        className={"lv-h t"}
        ref={hT}
        onPointerDown={down("T")}
        onKeyDown={key("T")}
        aria-label={`${pos ? "Take profit" : "Target"} ${fmtP(T, m)}. Drag, or use arrow keys.`}
      >
        <span>
          {pos ? "Take profit " : ""}
          {fmtP(T, m).replace(/\.0+$/, "")}
        </span>
        {!pos && <em>{fmtPct((T / mark - 1) * 100)}</em>}
        <i aria-hidden={"true"}>{"\u22EE"}</i>
      </button>
      <button
        className={"lv-h s"}
        ref={hS}
        onPointerDown={down("S")}
        onKeyDown={key("S")}
        aria-label={`Stop ${fmtP(S, m)}. Drag, or use arrow keys.`}
      >
        <span>
          {"Stop "}
          {fmtP(S, m).replace(/\.0+$/, "")}
        </span>
        {!pos && <em>{fmtPct((S / mark - 1) * 100)}</em>}
        <i aria-hidden={"true"}>{"\u22EE"}</i>
      </button>
    </div>
  );
}

/* ================= Privy (simulated) =================
   Mirrors the real integration:
   - PrivyProvider { loginMethods:['email','google','twitter','wallet'], appearance:{theme: day|night},
       embeddedWallets:{ ethereum:{ createOnLogin:'users-without-wallets' } }, defaultChain: monad }
   - useLogin().login()            -> lazy: only when the user takes an onchain action
   - useDepositFunds().depositFunds -> card / crypto transfer into the Privy wallet on Monad
   - useSendTransaction(tx,{uiOptions}) -> Privy confirmation modal, gas sponsored
   - signers (session signer + policy) -> "one-tap trading": no modal for in-policy actions
*/
export const Bolt = (
  <svg viewBox={"0 0 16 16"} width={"13"} height={"13"} aria-hidden={"true"}>
    <path d={"M9.2 1L3 9.2h4.3L6.6 15 13 6.6H8.6z"} fill={"currentColor"} />
  </svg>
);
export function NumIn({
  value,
  rawValue,
  onRawCommit,
  onRawPreview,
  onCommit,
  onPreview,
  prefix = "$",
  label,
  dp = 2,
  focus = true,
}: EditorProps) {
  const [raw, setRaw] = useState(rawValue ?? String(value));
  const ed = useRef(false);
  const ref = useRef<HTMLInputElement>(null!);
  useEffect(() => {
    if (!ed.current)
      setRaw(rawValue ?? (+value).toFixed(dp).replace(/\.0+$/, ""));
  }, [value, rawValue]);
  useEffect(() => {
    if (focus && ref.current) {
      ref.current.focus({
        preventScroll: true,
      });
      ref.current.select();
    }
  }, []);
  const commit = () => {
    ed.current = false;
    const v = parseNum(raw);
    if (v != null && v >= 0) {
      if (onRawCommit) onRawCommit(raw);
      else onCommit(v);
    }
  };
  return (
    <label className={"numin"}>
      <span>{prefix}</span>
      <input
        ref={ref}
        inputMode={"decimal"}
        aria-label={label}
        value={raw}
        onFocus={() => {
          ed.current = true;
        }}
        onInput={(e) => {
          ed.current = true;
          setRaw(e.currentTarget.value);
          const v = parseNum(e.currentTarget.value);
          if (v != null && v >= 0) {
            if (onRawPreview) onRawPreview(e.currentTarget.value);
            else onPreview?.(v);
          }
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
      <em>{"type or drag"}</em>
    </label>
  );
}
function EditPop({
  anchor,
  onClose,
  label,
  children,
  width = 300,
}: OverlayProps & {
  anchor: HTMLElement;
  onClose: () => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null!);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    ox: number;
  } | null>(null);
  const mob = innerWidth < 640;
  useLayoutEffect(() => {
    if (mob) return;
    const r = anchor.getBoundingClientRect();
    const h = ref.current.offsetHeight;
    let top = r.bottom + 10;
    if (top + h > innerHeight - 12) top = Math.max(12, r.top - h - 10);
    const left = clamp(r.left, 12, innerWidth - width - 12);
    setPos({
      left,
      top,
      ox: clamp(r.left + r.width / 2 - left, 20, width - 20),
    });
  }, []);
  useEffect(() => {
    const dn = (e: PointerEvent) => {
      if (
        ref.current &&
        e.target instanceof Node &&
        !ref.current.contains(e.target) &&
        !anchor.contains(e.target)
      )
        onClose();
    };
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        anchor.focus();
      }
    };
    document.addEventListener("pointerdown", dn, true);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("pointerdown", dn, true);
      document.removeEventListener("keydown", k);
    };
  }, []);
  return ReactDOM.createPortal(
    <React.Fragment>
      {mob && <div className={"ep-bg"} onClick={onClose} />}
      <div
        className={"ep" + (mob ? " sheet" : "")}
        ref={ref}
        role={"dialog"}
        aria-label={label}
        style={
          (mob
            ? {}
            : {
                left: (pos ? pos.left : -9999) + "px",
                top: (pos ? pos.top : 0) + "px",
                width: width + "px",
                "--ox": (pos ? pos.ox : 20) + "px",
              }) as PerplStyle
        }
      >
        {mob && (
          <button className={"ep-x"} onClick={onClose}>
            {"Done"}
          </button>
        )}
        {children}
      </div>
    </React.Fragment>,
    document.body,
  );
}
export function Sheet({
  title,
  onClose,
  wide,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children?: React.ReactNode;
}) {
  const headingId = useId();
  const ref = useRef<HTMLDivElement>(null!);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const h = ref.current && ref.current.querySelector("h2");
    h && h.focus();
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", k);
    return () => {
      removeEventListener("keydown", k);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, []);
  return ReactDOM.createPortal(
    <div
      className={"sh-bg"}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={wide ? "sh wide" : "sh"}
        ref={ref}
        role={"dialog"}
        aria-modal={"true"}
        aria-labelledby={headingId}
      >
        <div className={"sh-h"}>
          <h2 id={headingId} tabIndex={-1}>
            {title}
          </h2>
          <button className={"ghost"} onClick={onClose}>
            {"Close"}
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
function Tip({ children, text }: { children?: React.ReactNode; text: string }) {
  return (
    <span className={"tip"} tabIndex={0}>
      {children}
      <span className={"tip-i"} aria-hidden={"true"}>
        {"?"}
      </span>
      <span className={"tip-b"} role={"tooltip"}>
        {text}
      </span>
    </span>
  );
}
const GLOSS = {
  collateral:
    "The money set aside for this trade. Each position has its own, so one can’t drain another.",
  liq: "If the price reaches this level, Perpl closes the position automatically. Adding collateral moves it further away.",
  funding:
    "A small fee between buyers and sellers, about every hour. Depending on the market, you either pay it or receive it.",
  lev: "How much bigger your position is than your collateral. Higher leverage needs less money but puts liquidation closer.",
};

/* ================= Multi-position simulator (one isolated position per market) ================= */

/* ================= Sheets ================= */
function CollateralSheet({
  p,
  M,
  free,
  onDo,
  onClose,
}: {
  p: Position;
  M: number;
  free: number;
  onDo: (v: number) => void;
  onClose: () => void;
}) {
  const engine = useEngine();
  if (engine.kind === "live")
    return <LiveCollateralSheet p={p} onClose={onClose} />;
  const { markets: MK, collateralPreview } = engine;

  const m = MK[p.market];
  const [amt, setAmt] = useState(Math.min(100, Math.floor(free)));
  const max = Math.floor(free);
  const a = clamp(amt, 0, max);
  const preview = collateralPreview(p, a);
  const nC = preview.collateral ?? NaN;
  const liq0 = collateralPreview(p, a).before ?? NaN,
    liq1 = collateralPreview(p, a).after ?? NaN;
  return (
    <Sheet title={`Add collateral to ${m.id}`} onClose={onClose}>
      <NumIn
        value={a}
        label={"Amount"}
        focus={false}
        onPreview={setAmt}
        onCommit={(v) => setAmt(Math.min(v, max))}
      />
      {max >= 1 ? (
        <Slider
          value={clamp(Math.round(a), 0, max)}
          min={0}
          max={max}
          step={1}
          color={"var(--mint)"}
          label={"Amount"}
          valuetext={fmtUsd(a)}
          onChange={setAmt}
        />
      ) : (
        <p className={"ep-note"}>
          {"You have no free money to add. Add funds from your account first."}
        </p>
      )}
      <div className={"rows"}>
        <div className={"r"}>
          <span className={"k"}>{"Collateral"}</span>
          <span className={"v"}>
            {fmtUsd(p.C)}
            {" \u2192 "}
            <b>{fmtUsd(nC)}</b>
          </span>
        </div>
        <div className={"r"}>
          <span className={"k"}>{"Liquidation"}</span>
          <span className={"v"}>
            {fmtP(liq0, m)}
            {" \u2192 "}
            <b className={"g"}>{fmtP(liq1, m)}</b>
            <small>
              {Math.abs((liq1 / M - 1) * 100).toFixed(0)}
              {"% away"}
            </small>
          </span>
        </div>
        <div className={"r"}>
          <span className={"k"}>{"Leverage"}</span>
          <span className={"v"}>
            {(preview.leverageBefore ?? NaN).toFixed(1)}
            {"x \u2192 "}
            <b>
              {(preview.leverageAfter ?? NaN).toFixed(1)}
              {"x"}
            </b>
          </span>
        </div>
        <div className={"r"}>
          <span className={"k"}>{"Left to trade"}</span>
          <span className={"v"}>{fmtUsd(preview.remaining)}</span>
        </div>
      </div>
      <button
        className={"big"}
        aria-disabled={a <= 0 || a > max}
        onClick={() => {
          if (a > 0 && a <= max) {
            onDo(a);
            onClose();
          }
        }}
      >
        {"Add "}
        {fmtUsd(a)}
      </button>
    </Sheet>
  );
}
/** Live: the rows follow the amount as it is typed; the send runs a signed review first. */
function LiveCollateralSheet({
  p,
  onClose,
}: {
  p: Position;
  onClose: () => void;
}) {
  const engine = useEngine();
  const m = engine.markets[p.market];
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<string>();
  const amount = parseNum(raw);
  const valid = amount != null && amount > 0;
  const preview = engine.collateralPreview(p, valid ? amount : 0);
  const mark = engine.marks[p.market];
  const away =
    preview.after && Number.isFinite(mark) && mark > 0
      ? Math.abs((preview.after / mark - 1) * 100).toFixed(0) + "% away"
      : undefined;
  const tooMuch = valid && preview.remaining === undefined;
  return (
    <Sheet title={`Add collateral to ${p.market}`} onClose={onClose}>
      <label className={"numin"}>
        <span>{"$"}</span>
        <input
          inputMode={"decimal"}
          aria-label={"Amount"}
          value={raw}
          disabled={busy}
          onChange={(e) => {
            setRaw(e.currentTarget.value);
            setReason(undefined);
          }}
        />
      </label>
      <div className={"rows"}>
        <div className={"r"}>
          <span className={"k"}>{"Collateral"}</span>
          <span className={"v"}>
            {fmtUsd(p.C)}
            {" \u2192 "}
            <b>{fmtUsd(preview.collateral)}</b>
          </span>
        </div>
        <div className={"r"}>
          <span className={"k"}>{"Liquidation"}</span>
          <span className={"v"}>
            {fmtP(preview.before ?? NaN, m)}
            {" \u2192 "}
            <b className={"g"}>
              {/* Fully backed: no price can liquidate it. */}
              {preview.after === 0 ? "None" : fmtP(preview.after ?? NaN, m)}
            </b>
            {away && <small>{away}</small>}
          </span>
        </div>
        <div className={"r"}>
          <span className={"k"}>{"Leverage"}</span>
          <span className={"v"}>
            {preview.leverageBefore?.toFixed(1) ?? "—"}
            {"x \u2192 "}
            <b>
              {preview.leverageAfter?.toFixed(1) ?? "—"}
              {"x"}
            </b>
          </span>
        </div>
        <div className={"r"}>
          <span className={"k"}>{"Left to trade"}</span>
          <span className={"v"}>{fmtUsd(preview.remaining)}</span>
        </div>
      </div>
      <p className={"ep-note"}>
        {
          "Your profit and loss don\u2019t change. This only moves liquidation further away."
        }
      </p>
      {(reason ??
        (tooMuch ? "That is more than your free balance." : undefined)) && (
        <p role="status" className="ep-note">
          {reason ?? "That is more than your free balance."}
        </p>
      )}
      <button
        className={"big"}
        aria-disabled={busy || !valid || tooMuch || !engine.executionAvailable}
        onClick={async () => {
          if (busy || !valid || tooMuch || !engine.executionAvailable) return;
          setBusy(true);
          setReason(undefined);
          // One press: a fresh signed review of exactly this text, then the send.
          const id = await engine.reviewCollateral?.(p.market, raw);
          const result = id ? await engine.confirmCollateral?.(id) : undefined;
          setBusy(false);
          if (result?.state === "pending") onClose();
          else
            setReason(
              result?.reason ??
                "The amount could not be checked. Nothing was sent.",
            );
        }}
      >
        {busy ? "Adding…" : valid ? "Add " + fmtUsd(amount) : "Enter an amount"}
      </button>
    </Sheet>
  );
}
function CloseSheet({
  p,
  M,
  onDo,
  onClose,
}: {
  p: Position;
  M: number;
  onDo: (v: number) => void;
  onClose: () => void;
}) {
  const engine = useEngine();
  if (engine.kind === "live") return <LiveCloseSheet p={p} onClose={onClose} />;
  const { markets: MK, closePreview } = engine;

  const m = MK[p.market];
  const [pct, setPct] = useState(100);
  const {
    n = NaN,
    q = NaN,
    entry: exit = NaN,
    net = NaN,
    back = NaN,
    fees = NaN,
  } = closePreview(p, M, pct);
  return (
    <Sheet title={`Close ${m.id} ${p.side}`} onClose={onClose}>
      <div className={"segd"} role={"group"} aria-label={"How much to close"}>
        {[25, 50, 100].map((x) => (
          <button key={x} aria-pressed={pct === x} onClick={() => setPct(x)}>
            {x}
            {"%"}
          </button>
        ))}
      </div>
      <div className={"kv one"}>
        <div>
          <small>{"You get back about"}</small>
          <b>{fmtUsd(Math.max(0, back))}</b>
        </div>
      </div>
      <div className={"rows"}>
        <div className={"r"}>
          <span className={"k"}>{"Profit or loss"}</span>
          <span className={"v " + (net >= 0 ? "g" : "r")}>
            {fmtUsd(net, 2, true)}
            <small>
              {"after "}
              {fmtUsd(fees)}
              {" in fees"}
            </small>
          </span>
        </div>
        <div className={"r"}>
          <span className={"k"}>{"Amount"}</span>
          <span className={"v"}>
            {fmtQ(q, m)}
            {" of "}
            {fmtQ(p.q, m)} {m.id}
          </span>
        </div>
        <div className={"r"}>
          <span className={"k"}>{"Exit price"}</span>
          <span className={"v"}>
            {"about "}
            {fmtP(exit, m)}
          </span>
        </div>
        <div className={"r"}>
          <span className={"k"}>{"Funding so far"}</span>
          <span className={"v " + (p.F >= 0 ? "g" : "r")}>
            {fmtUsd(p.F, 2, true)}
          </span>
        </div>
      </div>
      <p
        className={"ep-note"}
        style={{
          margin: 0,
        }}
      >
        {pct === 100
          ? "Your take profit and stop will be removed."
          : `Your take profit and stop will cover the remaining ${fmtQ(p.q - q, m)} ${m.id}.`}
      </p>
      <button
        className={"big red"}
        aria-disabled={!n}
        onClick={() => {
          if (n) {
            onDo(pct / 100);
            onClose();
          }
        }}
      >
        {"Close "}
        {fmtQ(q, m)} {m.id}
      </button>
    </Sheet>
  );
}
function LiveCloseSheet({ p, onClose }: { p: Position; onClose: () => void }) {
  const engine = useEngine();
  const m = engine.markets[p.market];
  const [pct, setPct] = useState<25 | 50 | 100>(100);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<string>();
  const review =
    engine.closeReview?.market === p.market ? engine.closeReview : undefined;
  const read = async (percent: 25 | 50 | 100) => {
    setBusy(true);
    setReason(undefined);
    await engine.reviewClose?.(p.market, percent);
    setBusy(false);
  };
  useEffect(() => {
    void read(100);
  }, [p.market]);
  const expired = !review || Date.now() >= review.expiresAt;
  // Until the signed review arrives, show what is already known on screen, so the sheet
  // never opens blank. Only the signed review enables the Close button.
  const mark = engine.marks[p.market];
  const metrics = engine.positionMetrics(p, mark);
  const fraction = pct / 100;
  const estimate =
    metrics.net !== undefined &&
    metrics.gross !== undefined &&
    Number.isFinite(mark) &&
    Number.isFinite(p.C)
      ? {
          q: Math.floor((p.q * fraction) / m.lot + 1e-9) * m.lot,
          net: metrics.net * fraction,
          fees: (metrics.gross - metrics.net) * fraction,
          back: Math.max(0, (p.C + metrics.net + (p.entryFee ?? 0)) * fraction),
          entry: mark,
          bound: mark * (p.side === "long" ? 0.995 : 1.005),
        }
      : undefined;
  const shown = review ?? estimate;
  return (
    <Sheet title={`Close ${p.market} ${p.side}`} onClose={onClose}>
      <div className="segd" role="group" aria-label="How much to close">
        {([25, 50, 100] as const).map((x) => (
          <button
            key={x}
            aria-pressed={pct === x}
            disabled={busy}
            onClick={() => {
              setPct(x);
              void read(x);
            }}
          >
            {x}%
          </button>
        ))}
      </div>
      <div className="kv one">
        <div>
          <small>You get back about</small>
          <b>{fmtUsd(shown?.back)}</b>
        </div>
      </div>
      <div className="rows">
        <div className="r">
          <span className="k">Profit or loss</span>
          <span className="v">
            {fmtUsd(shown?.net, 2, true)}
            <small>after {fmtUsd(shown?.fees)} in fees</small>
          </span>
        </div>
        <div className="r">
          <span className="k">Amount</span>
          <span className="v">
            {fmtQ(shown?.q, m)} of {fmtQ(p.q, m)} {m.id}
          </span>
        </div>
        <div className="r">
          <span className="k">Exit price</span>
          <span className="v">
            about {fmtP(shown?.entry, m)}
            <small>
              Order {p.side === "long" ? "floor" : "ceiling"}{" "}
              {fmtP(shown?.bound, m)}
            </small>
          </span>
        </div>
        <div className="r">
          <span className="k">Funding so far</span>
          <span className="v">{fmtUsd(p.F, 2, true)}</span>
        </div>
      </div>
      <p className="ep-note">
        Reduce-only IOC · fills may differ or fail. Remaining exposure and each
        exit must be read back; closing this sheet cannot undo a submitted
        order.
      </p>
      {(reason ?? review?.reason ?? engine.liveStatus) && (
        <p role="status" className="ep-note">
          {reason ?? review?.reason ?? engine.liveStatus}
        </p>
      )}
      <button
        className="big red"
        aria-disabled={busy || (!expired && !engine.executionAvailable)}
        onClick={async () => {
          if (busy) return;
          if (expired) {
            await read(pct);
            return;
          }
          if (!review) return;
          setBusy(true);
          const result = await engine.confirmClose?.(review.id);
          setReason(result?.reason);
          setBusy(false);
          if (result?.state === "pending") onClose();
        }}
      >
        {busy
          ? "Checking close…"
          : expired
            ? "Prices moved · Refresh"
            : "Close " + fmtQ(review?.q, m) + " " + m.id}
      </button>
    </Sheet>
  );
}
/* ================= App ================= */
const Sun = (
  <svg viewBox={"0 0 20 20"} width={"16"} height={"16"} aria-hidden={"true"}>
    <circle cx={"10"} cy={"10"} r={"3.6"} fill={"currentColor"} />
    <g stroke={"currentColor"} strokeWidth={"1.6"} strokeLinecap={"round"}>
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
        <line
          key={a}
          x1={10 + Math.cos((a * Math.PI) / 180) * 6.2}
          y1={10 + Math.sin((a * Math.PI) / 180) * 6.2}
          x2={10 + Math.cos((a * Math.PI) / 180) * 8.2}
          y2={10 + Math.sin((a * Math.PI) / 180) * 8.2}
        />
      ))}
    </g>
  </svg>
);
const Moon = (
  <svg viewBox={"0 0 20 20"} width={"16"} height={"16"} aria-hidden={"true"}>
    <path
      d={"M15.5 12.6A6.5 6.5 0 0 1 7.4 4.5a6.5 6.5 0 1 0 8.1 8.1z"}
      fill={"currentColor"}
    />
  </svg>
);

function App({ engine }: { engine: PerplEngine }) {
  const { marks, bk, px, markets: MK, roundTick, fixP, tfChange } = engine;
  const QUOTE_LIFE = 10;
  const positionMetrics = (p: Position, mark: number) => {
    const observed = engine.positionMetrics(p, mark);
    return {
      gross: observed.gross ?? NaN,
      net: observed.net ?? NaN,
      liquidation: observed.liquidation ?? NaN,
      netAfterFunding: observed.netAfterFunding ?? NaN,
      effectiveLeverage: observed.effectiveLeverage ?? NaN,
    };
  };
  const stopBuffer = (market: (typeof engine.markets)[string], mark: number) =>
    engine.stopBuffer(market, mark) ?? NaN;

  const positionReadings =
    engine.positions.state === "observed" ? engine.positions.value : [];
  const book: Record<string, Position & { key: string }> = Object.fromEntries(
    positionReadings.map((p) => [
      p.key,
      {
        ...p,
        goal: p.goal ?? NaN,
        entryFee: p.entryFee ?? NaN,
        F: p.F ?? NaN,
        lev: p.lev ?? NaN,
        E: p.E ?? NaN,
        C: p.C ?? NaN,
        tp: { ...p.tp, price: p.tp.price ?? NaN },
        sl: { ...p.sl, price: p.sl.price ?? NaN },
      },
    ]),
  );
  const balance =
    engine.balances.state === "observed"
      ? engine.balances.value
      : { wallet: NaN, free: NaN, locked: NaN };

  const [tapOffer, setTapOffer] = useState(false);
  const [tapBanner, setTapBanner] = useState(false);
  const gate: Gate = (req, need) =>
    engine.gate(req, need, () => setTapBanner(true));
  const [mode, setMode] = useState(() => {
    try {
      return localStorage.getItem("perpl-mode") || "day";
    } catch (e) {
      return "day";
    }
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    try {
      localStorage.setItem("perpl-mode", mode);
    } catch (e) {}
  }, [mode]);
  const TH = mode === "night" ? NIGHT : DAY;
  const [draft, setDraft] = useState<Draft>(
    engine.initialDraft ?? {
      market: "ETH",
      side: "long",
      goal: 500,
      target: 3100,
      stop: 2404.05,
      lev: 3,
      rev: 1,
    },
  );
  const set = (pa: Partial<Draft>) => {
    if (
      Object.values(pa).some(
        (value) => typeof value === "number" && !Number.isFinite(value),
      )
    )
      return;
    const next = engine.editDraft?.(draft, pa) ?? {
      ...draft,
      ...pa,
      rev: draft.rev + 1,
    };
    setDraft(next);
  };
  const [sel, setSel] = useState<string>("new");
  const [demo, setDemo] = useState(() => innerWidth > 640);
  const [tf, setTf] = useState<string>("live");
  const [open, setOpen] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [frozen, setFrozen] = useState<{
    M: number;
    E: number;
    sLo: number;
    sHi: number;
  } | null>(null);
  const [review, setReview] = useState<
    | (CompleteCalculation & {
        draft: Draft;
        liveId?: string;
      })
    | null
  >(null);
  const [qAt, setQAt] = useState(0);
  const [ack, setAck] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [amend, setAmend] = useState<{
    k: "tp" | "sl";
    mk: string;
    v: number;
    y: number;
  } | null>(null);
  const [busyOpen, setBusyOpen] = useState(false);
  const [dragV, setDragV] = useState<{
    k: string;
    v: number;
  } | null>(null);
  const [sheet, setSheet] = useState<{
    k: string;
    market?: string;
  } | null>(null);
  const [triggerRaw, setTriggerRaw] = useState<string>();
  const [immediateAck, setImmediateAck] = useState(false);
  // The acknowledgment belongs to one review; it never carries over to the next.
  useEffect(() => setImmediateAck(false), [engine.protectionReview?.id]);
  const [moving, setMoving] = useState(false);
  const [stage, setStage] = useState<Partial<Record<"tp" | "sl", number>>>({});
  const drawerH = useRef<HTMLHeadingElement>(null!);
  const headEl = useRef<HTMLDivElement>(null!);
  const sentRef = useRef<HTMLParagraphElement>(null!);
  const [vw, setVw] = useState(innerWidth);
  useEffect(() => {
    const h = () => setVw(innerWidth);
    addEventListener("resize", h);
    return () => removeEventListener("resize", h);
  }, []);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    setAck(false);
  }, [draft.rev]);
  useEffect(() => {
    const r = bk.result;
    if (
      !r ||
      engine.kind !== "demo" ||
      r.E === undefined ||
      r.tp === undefined ||
      r.sl === undefined
    )
      return;
    const { E: resultEntry, tp: resultTarget, sl: resultStop } = r;
    const rm = MK[r.market];
    const M2 = marks[r.market];
    setDraft((dr) =>
      dr.market !== r.market
        ? dr
        : {
            ...dr,
            side: r.side,
            target: fixP(roundTick(M2 * (resultTarget / resultEntry), rm), rm),
            stop: fixP(roundTick(M2 * (resultStop / resultEntry), rm), rm),
            rev: dr.rev + 1,
          },
    );
  }, [bk.result && bk.result.at]);
  // The result card is a notice like the others: it leaves on its own after 8 s.
  const resultShown = !!bk.result && !book[bk.result.market];
  useEffect(() => {
    if (!resultShown) return;
    const timer = setTimeout(() => bk.clearResult(), 8000);
    return () => clearTimeout(timer);
  }, [resultShown, bk.result && bk.result.at]);
  useEffect(() => {
    if (!review) return;
    const previousFocus = document.activeElement;
    drawerH.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, [!!review]);
  // follow positions: if the selected one closes, fall back to another or to a new trade
  useEffect(() => {
    if (sel !== "new" && !book[sel]) {
      const k = Object.keys(book)[0];
      setSel(k || "new");
    }
  }, [book, sel]);
  const pos = sel !== "new" ? book[sel] : null;
  const ex = Object.values(book).find((p) => p.market === draft.market);
  const conflict = !pos && ex && ex.side !== draft.side;
  const adding = !pos && ex && ex.side === draft.side;
  const free = balance.free;
  const authed = !!px.user;
  const planObservation = engine.calculate(draft);
  const publicReason =
    planObservation.public.state !== "observed"
      ? planObservation.public.reason
      : undefined;
  const calc = presentCalculation(engine, draft);
  const m = MK[draft.market];
  const M = marks[draft.market];
  const d = draft.side === "long" ? 1 : -1;
  // Once, at the first live price: a first visit, or a saved target the entry bound no
  // longer allows, lands at the engine's default distances. Later edits are never moved.
  const landed = useRef(false);
  useEffect(() => {
    const land = engine.landing;
    if (landed.current || !land || !Number.isFinite(calc.tLim)) return;
    landed.current = true;
    const inside = d > 0 ? draft.target < calc.tLim : draft.target > calc.tLim;
    if (!land.fresh && !(land.repair && inside)) return;
    set({
      target: fixP(roundTick(calc.M * (1 + d * land.target), m), m),
      stop: fixP(roundTick(calc.M * (1 - d * land.stop), m), m),
    });
  }, [calc.tLim]);
  const tkEls = useRef<Record<string, HTMLElement | null>>({});
  const openPop = (
    k: string,
    el: HTMLElement,
    staged?: { which: "tp" | "sl"; v: number },
  ) => {
    setAnchor(el);
    setFrozen({
      M,
      E: calc.E || M,
      sLo: calc.sLo,
      sHi: calc.sHi,
    });
    if (pos)
      setStage({
        tp: pos.tp.price,
        sl: pos.sl.price,
        ...(staged ? { [staged.which]: staged.v } : {}),
      });
    setTriggerRaw(staged ? String(staged.v) : undefined);
    setOpen(k);
  };
  const tog = (k: string, e: React.MouseEvent<HTMLElement>) => {
    if (open === k) {
      setOpen(null);
      return;
    }
    openPop(k, e.currentTarget);
  };
  const flip = () => {
    if (!engine.canEditMarket(draft.market)) return;
    const tp = draft.target / M - 1,
      sp = draft.stop / M - 1;
    set({
      side: d > 0 ? "short" : "long",
      target: fixP(roundTick(M * (1 - tp), m), m),
      stop: fixP(roundTick(M * (1 - sp), m), m),
    });
  };
  const pick = (id: string) => {
    setOpen(null);
    if (
      id === draft.market ||
      !engine.canEditMarket(id) ||
      !engine.canEditMarket(draft.market)
    )
      return;
    const nm = MK[id],
      nM = marks[id];
    set({
      market: id,
      target: fixP(roundTick(nM * (draft.target / M), nm), nm),
      stop: fixP(roundTick(nM * (draft.stop / M), nm), nm),
    });
  };
  // plain-language versions of the calculator's errors
  const E = calc.errors;
  const needsFunds =
    !E.target &&
    !E.goal &&
    !E.stop &&
    !E.lev &&
    (E.budget || calc.shortfall > 0);
  const err =
    engine.kind === "live" && E.goal
      ? E.goal
      : conflict
        ? `You’re already ${ex.side} ${m.id}. Close it before going ${draft.side}.`
        : E.target
          ? d > 0
            ? `Pick a target above today’s price (${fmtP(M, m)}).`
            : `Pick a target below today’s price (${fmtP(M, m)}).`
          : E.goal
            ? draft.goal < 0.01
              ? "Enter a goal of at least $0.01."
              : "That goal is too big for this target. Lower the goal or move the target further."
            : E.stop
              ? calc.sLo > calc.sHi
                ? "There’s no safe stop at this leverage. Lower the leverage."
                : `Set the stop between ${fmtP(calc.sLo, m)} and ${fmtP(calc.sHi, m)}.`
              : E.lev
                ? E.lev
                : needsFunds
                  ? `This needs ${fmtUsd(calc.required)} to open. Lower the goal or add funds.`
                  : null;
  const fix = conflict
    ? {
        t: `Show my ${m.id} position`,
        f: () => setSel(ex.key),
      }
    : E.target
      ? {
          t: `Switch to ${d > 0 ? "falls" : "rises"}`,
          f: flip,
        }
      : E.stop && calc.sLo <= calc.sHi
        ? {
            t: "Fix the stop",
            f: () =>
              set({
                stop: fixP(
                  roundTick(clamp(draft.stop, calc.sLo, calc.sHi), m),
                  m,
                ),
              }),
          }
        : needsFunds
          ? {
              t: "Add funds",
              f: () => px.fund(calc.required - free),
            }
          : null;
  const canReview =
    !(engine.kind === "live" && ex) &&
    (engine.kind === "live"
      ? planObservation.public.state === "observed" &&
        planObservation.public.value.ok
      : calc.ok) &&
    !conflict &&
    (engine.kind === "live" || !authed || calc.shortfall <= 0);
  const startReview = async () => {
    if (!canReview) return;
    setOpen(null);
    setReview({
      ...calc,
      draft: {
        ...draft,
      },
    });
    setQAt(Date.now());
    setAck(false);
    if (
      engine.kind === "live" &&
      authed &&
      engine.sessionStatus?.state === "active"
    ) {
      setBusyOpen(true);
      const fresh = await engine.prepareReview?.(draft);
      if (fresh) {
        setReview({
          ...calc,
          ...fresh.calculation,
          draft: { ...draft },
          liveId: fresh.id,
        });
        setQAt(fresh.expiresAt - QUOTE_LIFE * 1000);
      }
      setBusyOpen(false);
    }
  };
  useEffect(() => {
    if (engine.kind === "live") {
      setAck(false);
      setReview((previous) =>
        previous?.liveId ? { ...previous, liveId: undefined } : previous,
      );
      setQAt(0);
    }
  }, [engine.authorityRevision, engine.px.user?.addr]);
  const age = busyOpen && engine.kind === "demo" ? 0 : (now - qAt) / 1000;
  const stale =
    review && !(busyOpen && engine.kind === "demo") && age >= QUOTE_LIFE;
  useEffect(() => {
    if (stale) setAck(false);
  }, [stale]);
  const market = pos ? pos.market : draft.market;
  const pm = MK[market];
  const pM = marks[market];
  const live = pos
    ? positionMetrics(pos, pM)
    : {
        gross: NaN,
        net: NaN,
        netAfterFunding: NaN,
        effectiveLeverage: NaN,
      };
  const pliq = pos ? positionMetrics(pos, pM).liquidation : NaN;
  // Profit or loss at an exit price, before fees: the same figure the chart prints on that line.
  const exitPnl = (price: number) =>
    pos ? (pos.side === "long" ? 1 : -1) * pos.q * (price - pos.E) : NaN;
  // A position read from the chain alone: its exit orders are only readable with account access.
  const exitsLocked =
    engine.kind === "live" && !!pos && pos.sl.status.startsWith("restore");
  // Live: a dragged line stays where it was dropped while its Save prompt is open.
  const held = (k: "tp" | "sl") =>
    engine.kind === "live" && amend?.k === k ? amend.v : undefined;
  const lv = pos
    ? {
        side: pos.side,
        T:
          dragV && dragV.k === "T"
            ? dragV.v
            : held("tp") !== undefined
              ? held("tp")!
              : pos.tp.status === "changing"
                ? (pos.tp.next ?? NaN)
                : pos.tp.price,
        S:
          dragV && dragV.k === "S"
            ? dragV.v
            : held("sl") !== undefined
              ? held("sl")!
              : pos.sl.status === "changing"
                ? (pos.sl.next ?? NaN)
                : pos.sl.price,
        E: pos.E,
        liq: pliq,
        q: pos.q,
      }
    : {
        side: draft.side,
        T: draft.target,
        S: draft.stop,
        E: calc.E || M,
        liq: calc.liq,
        q: calc.q || 0,
      };
  const F = frozen || {
    M,
    E: calc.E || M,
    sLo: calc.sLo,
    sHi: calc.sHi,
  };
  // Where the engine knows the nearest target it can place, the controls stop there.
  const tLim = Number.isFinite(calc.tLim) ? calc.tLim : undefined;
  const nearT = (v: number) =>
    tLim === undefined ? v : d > 0 ? Math.max(v, tLim) : Math.min(v, tLim);
  const tDom =
    d > 0
      ? {
          lo: +(
            ((tLim ?? Math.max(F.E, F.M) + m.tick) / F.M - 1) *
            100
          ).toFixed(1),
          hi: 100,
        }
      : {
          lo: -90,
          hi: +(
            ((tLim ?? Math.min(F.E, F.M) - m.tick) / F.M - 1) *
            100
          ).toFixed(1),
        };
  const tPct = +((draft.target / F.M - 1) * 100).toFixed(1);
  const sOK = F.sLo != null && F.sHi != null && F.sLo <= F.sHi;
  const sDom = sOK
    ? {
        lo: +(((F.sLo ?? NaN) / F.M - 1) * 100).toFixed(1),
        hi: +(((F.sHi ?? NaN) / F.M - 1) * 100).toFixed(1),
      }
    : {
        lo: NaN,
        hi: NaN,
      };
  const tk = (
    k: string,
    cls: string,
    label: string,
    content: React.ReactNode,
    extra?: string | undefined,
  ) => (
    <button
      className={"tk " + cls + (open === k ? " on" : "") + (extra || "")}
      aria-expanded={open === k}
      aria-haspopup={"dialog"}
      ref={(el) => {
        tkEls.current[k] = el;
      }}
      onClick={(e) => tog(k, e)}
      aria-label={label}
    >
      {content}
      <svg className={"chev"} viewBox={"0 0 10 6"} aria-hidden={"true"}>
        <path
          d={"M1 1l4 4 4-4"}
          fill={"none"}
          stroke={"currentColor"}
          strokeWidth={"1.8"}
          strokeLinecap={"round"}
        />
      </svg>
    </button>
  );
  const headH = useRef(200);
  useLayoutEffect(() => {
    if (headEl.current)
      headH.current = headEl.current.getBoundingClientRect().bottom;
  });
  const positions = Object.values(book);
  const totalNet = engine.totalPositionNet ?? NaN;
  const amendReq = (p: Position, which: "tp" | "sl", v: number) => ({
    title: `Move ${which === "tp" ? "take profit" : "stop"} on ${p.market}`,
    fn: "amendOrder",
    tap: true,
    rows: [
      [
        which === "tp" ? "Take profit" : "Stop",
        `${fmtP(p[which].price, MK[p.market])} → ${fmtP(v, MK[p.market])}`,
      ],
      ["Position", `${fmtQ(p.q, MK[p.market])} ${p.market} ${p.side}`],
    ],
  });
  // one-line sentence on wide screens: shrink the type until it fits (only re-measured when the words change)
  const fitKey = (
    pos
      ? ["p", pos.market, pos.side, pos.q, pos.goal, pos.tp.price, pos.sl.price]
      : ["c", draft.goal, draft.market, draft.side, draft.target, draft.stop]
  ).join("|");
  useLayoutEffect(() => {
    const el = sentRef.current;
    if (!el) return;
    if (vw < 1360) {
      el.style.fontSize = "";
      return;
    }
    const rg = document.createRange();
    rg.selectNodeContents(el);
    const fits = () =>
      rg.getBoundingClientRect().width <= el.clientWidth * 0.96;
    el.style.fontSize = "40px";
    if (fits()) return;
    let lo = 22,
      hi = 40;
    while (hi - lo > 0.5) {
      const mid = (lo + hi) / 2;
      el.style.fontSize = mid + "px";
      if (fits()) lo = mid;
      else hi = mid;
    }
    el.style.fontSize = lo + "px";
  }, [fitKey, vw]);
  // staged order edits for an open position (sentence route)
  const posPop = (which: "tp" | "sl") => {
    const p = pos;
    if (!p || !anchor) return null;
    const cur = p[which].price;
    const v = stage[which] ?? cur;
    const dd = p.side === "long" ? 1 : -1;
    const lo = which === "tp" ? (dd > 0 ? 0 : -60) : dd > 0 ? -40 : 0,
      hi = which === "tp" ? (dd > 0 ? 100 : 0) : dd > 0 ? 0 : 40;
    const val = clamp(+((v / pM - 1) * 100).toFixed(1), lo, hi);
    const amendment = engine.amendPreview(p, which, v, pM);
    const immediate = amendment.immediate;
    const liqBad = amendment.badStop;
    return (
      <EditPop
        anchor={anchor}
        onClose={() => {
          setOpen(null);
          setStage({});
        }}
        label={which === "tp" ? "Change take profit" : "Change stop"}
      >
        <h4>
          {which === "tp" ? "Take profit" : "Stop"}
          {" \xB7 current "}
          {fmtP(cur, pm)}
        </h4>
        <NumIn
          value={v}
          rawValue={
            engine.kind === "live"
              ? (triggerRaw ?? (Number.isFinite(v) ? String(v) : ""))
              : undefined
          }
          onRawPreview={
            engine.kind === "live"
              ? (raw) => {
                  setTriggerRaw(raw);
                  engine.invalidateReviews?.();
                  setImmediateAck(false);
                }
              : undefined
          }
          onRawCommit={
            engine.kind === "live"
              ? (raw) => {
                  // Leaving the field with the reviewed price untouched keeps its review.
                  if (Number(raw) === Number(triggerRaw ?? v)) return;
                  setTriggerRaw(raw);
                  engine.invalidateReviews?.();
                }
              : undefined
          }
          label={"Trigger price"}
          dp={pm.dp}
          onPreview={(x) =>
            setStage((s) => ({
              ...s,
              [which]: x,
            }))
          }
          onCommit={(x) =>
            setStage((s) => ({
              ...s,
              [which]: fixP(roundTick(x, pm), pm),
            }))
          }
        />
        <Slider
          value={val}
          min={lo}
          max={hi}
          step={0.1}
          color={which === "tp" ? "var(--mint)" : "var(--coral)"}
          label={"Distance from today\u2019s price"}
          valuetext={fmtPct(val)}
          badge={fmtPct(val)}
          onChange={(x) =>
            setStage((s) => ({
              ...s,
              [which]: fixP(roundTick(pM * (1 + x / 100), pm), pm),
            }))
          }
        />
        <div className={"ep-foot"}>
          <span>
            <b>
              {fmtQ(p.q, pm)} {pm.id}
            </b>
            {"position size"}
          </span>
          <span>
            <b className={(amendment.gross ?? NaN) >= 0 ? "g" : "r"}>
              {fmtUsd(amendment.gross, 2, true)}
            </b>
            {(amendment.gross ?? NaN) >= 0 ? "you’d make" : "you’d lose"}
          </span>
          <span>
            <b>{fmtP(pliq, pm)}</b>
            {"liquidation"}
          </span>
        </div>
        {immediate && (
          <p
            className={"ep-note"}
            style={
              {
                color: "var(--warn)",
              } as PerplStyle
            }
          >
            {pm.id}
            {" is already past this price, so it would close right away."}
          </p>
        )}
        {liqBad && (
          <p
            className={"ep-note"}
            style={
              {
                color: "var(--loss)",
              } as PerplStyle
            }
          >
            {"Too close to liquidation. Keep the stop at least "}
            {fmtUsd(stopBuffer(pm, pM))}
            {" away, or add collateral."}
          </p>
        )}
        <button
          className={"big"}
          style={{
            marginTop: "10px",
          }}
          aria-disabled={
            engine.kind === "live"
              ? engine.protectionReview
                ? !engine.executionAvailable
                : moving || Number(triggerRaw ?? v) === cur
              : v === cur || liqBad
          }
          onClick={async () => {
            if (engine.kind === "live") {
              if (engine.protectionReview) {
                await engine.confirmProtection?.(
                  engine.protectionReview.id,
                  immediateAck,
                );
              } else if (!moving && Number(triggerRaw ?? v) !== cur) {
                setMoving(true);
                try {
                  const outcome = await engine.moveProtection?.(
                    p.market,
                    which,
                    triggerRaw ?? String(v),
                  );
                  if (outcome?.state === "pending") {
                    setOpen(null);
                    setStage({});
                  }
                } finally {
                  setMoving(false);
                }
              }
              return;
            }
            if (v !== cur && !liqBad) {
              setOpen(null);
              setStage({});
              if (engine.kind === "demo" && (await gate(amendReq(p, which, v))))
                bk.amend(p.market, which, v);
            }
          }}
        >
          {engine.kind === "live"
            ? engine.protectionReview
              ? "Confirm reviewed change"
              : "Save change"
            : "Save change"}
        </button>
        {engine.kind === "live" && engine.protectionReview?.immediate && (
          <label className="ep-note">
            <input
              type="checkbox"
              checked={immediateAck}
              onChange={(e) => setImmediateAck(e.target.checked)}
            />
            May trigger immediately. I acknowledge this condition is already
            satisfied.
          </label>
        )}
        {engine.kind === "live" && engine.liveStatus && (
          <p role="status" className="ep-note">
            {engine.liveStatus}
          </p>
        )}
      </EditPop>
    );
  };
  return (
    <div className={"app"}>
      <header className={"top"}>
        <span className={"brand"}>
          <img
            className={"day"}
            src={"/mark-my-words-logo-day.svg"}
            alt={"Mark My Words"}
          />
          <img
            className={"night"}
            src={"/mark-my-words-logo-night.svg"}
            alt={""}
          />
        </span>
        <span className={"topr"}>
          <button
            className={"modebtn"}
            onClick={() => setMode(mode === "day" ? "night" : "day")}
            aria-label={mode === "day" ? "Switch to night" : "Switch to day"}
          >
            {mode === "day" ? Moon : Sun}
          </button>
          {authed ? (
            <button
              className={"bal"}
              onClick={() =>
                setSheet({
                  k: "account",
                })
              }
              aria-label={"Account"}
            >
              {px.tapOn() && (
                <span className={"zap"} title={"One-tap trading on"}>
                  {Bolt}
                </span>
              )}
              <Odo text={fmtUsd(balance.free)} />
              <small>{"AUSD"}</small>
              <span className={"av"} aria-hidden={"true"}>
                {(px.user?.label || "?")[0].toUpperCase()}
              </span>
            </button>
          ) : (
            <button className={"login"} onClick={() => px.login()}>
              {"Log in"}
            </button>
          )}
        </span>
      </header>
      <div className={"head"} data-testid={"sentence-area"} ref={headEl}>
        {pos ? (
          <>
            <p className={"sentence"} ref={sentRef} aria-live={"polite"}>
              {"You\u2019re "}
              {<span className={"tk coral static"}>{pos.side}</span>}{" "}
              {fmtQ(pos.q, pm)} <span className={"tk lav static"}>{pm.id}</span>
              {", "}
              {Number.isFinite(live.gross)
                ? live.gross >= 0
                  ? "up"
                  : "down"
                : "profit or loss"}{" "}
              <span
                className={"tk static " + (live.gross >= 0 ? "mint" : "coral")}
              >
                <Odo text={fmtUsd(Math.abs(live.gross))} />
              </span>
              {Number.isFinite(pos.goal) && (
                <>
                  {" on a "}
                  <span className={"tk gold static"}>{fmtShort(pos.goal)}</span>
                  {" goal"}
                </>
              )}
              {exitsLocked ? (
                "."
              ) : (
                <>
                  {".\n          Take profit at "}
                  {tk(
                    "tp",
                    "mint",
                    "Take profit " + fmtP(lv.T, pm),
                    <>
                      {fmtP(lv.T, pm).replace(/\.0+$/, "")}
                      {pos.tp.status === "changing" ? (
                        <em className={"pc"}>{"saving\u2026"}</em>
                      ) : (
                        ""
                      )}
                    </>,
                  )}
                  <span className={"tail"}>{", stop at "}</span>
                  {tk(
                    "sl",
                    "stop",
                    "Stop " + fmtP(lv.S, pm),
                    <>
                      {fmtP(lv.S, pm).replace(/\.0+$/, "")}
                      {pos.sl.status === "changing" ? (
                        <em className={"pc"}>{"saving\u2026"}</em>
                      ) : (
                        ""
                      )}
                    </>,
                  )}
                  {"."}
                </>
              )}
            </p>
            <p className={"sub"}>
              {pos.status === "closing"
                ? "Closing…"
                : pos.status === "margin"
                  ? "Updating collateral…"
                  : pos.merged
                    ? "Trades on the same market combine into one position. "
                    : ""}
              {exitsLocked ? (
                <>
                  <button
                    className={"back"}
                    onClick={() => engine.command("enroll")}
                  >
                    {"Enable account access"}
                  </button>
                  {" to see and change your take profit and stop. "}
                </>
              ) : engine.kind === "live" ? (
                `Take profit · ${pos.tp.status}. Stop · ${pos.sl.status}. `
              ) : (
                (engine.detailsReason ??
                "Tap a price or drag its line to change it. ")
              )}
              <button
                className={"back"}
                onClick={() => {
                  setSel("new");
                  setOpen(null);
                }}
              >
                {"Back to new trade"}
              </button>
            </p>
          </>
        ) : (
          <>
            <p className={"sentence"} ref={sentRef}>
              {"I want to make "}
              {tk(
                "goal",
                "gold",
                "Profit goal " + fmtShort(draft.goal),
                <Odo text={fmtShort(draft.goal)} />,
                calc.errors.goal ? " bad" : "",
              )}
              {" if "}
              {tk("market", "lav", "Market " + m.name, m.id)}
              <button
                className={"tk coral"}
                onClick={flip}
                aria-label={
                  "Direction " +
                  (d > 0 ? "long, change to short" : "short, change to long")
                }
              >
                <svg
                  className={"ar"}
                  viewBox={"0 0 12 12"}
                  aria-hidden={"true"}
                >
                  {d > 0 ? (
                    <path
                      d={"M2 9.5L9.5 2M4 2h5.5v5.5"}
                      fill={"none"}
                      stroke={"currentColor"}
                      strokeWidth={"2"}
                      strokeLinecap={"round"}
                      strokeLinejoin={"round"}
                    />
                  ) : (
                    <path
                      d={"M2 2.5L9.5 10M4 10h5.5V4.5"}
                      fill={"none"}
                      stroke={"currentColor"}
                      strokeWidth={"2"}
                      strokeLinecap={"round"}
                      strokeLinejoin={"round"}
                    />
                  )}
                </svg>
                {d > 0 ? "rises" : "falls"}
                {" to"}
              </button>
              {tk(
                "target",
                "mint",
                "Target " + fmtP(draft.target, m),
                <>
                  {fmtP(draft.target, m).replace(/\.0+$/, "")}
                  <em className={"pc"}>
                    {fmtPct((draft.target / M - 1) * 100)}
                  </em>
                </>,
                calc.errors.target ? " bad" : "",
              )}
              <span className={"tail"}>{", stop at "}</span>
              {tk(
                "stop",
                "stop",
                "Stop " + fmtP(draft.stop, m),
                fmtP(draft.stop, m).replace(/\.0+$/, ""),
                calc.errors.stop ? " bad" : "",
              )}
              {"."}
            </p>
            {err ? (
              <div className={"msg"} role={"status"}>
                <span>{err}</span>
                {fix && <button onClick={fix.f}>{fix.t}</button>}
              </div>
            ) : adding ? (
              <p className={"sub add"}>
                {"You already hold "}
                {fmtQ(ex.q, m)} {m.id} {ex.side}
                {engine.kind === "live"
                  ? ". Increasing this position is unavailable."
                  : ". This adds to it."}
              </p>
            ) : (
              <p className={"sub"}>
                {engine.publicReason ??
                  publicReason ??
                  engine.detailsReason ??
                  "Tap any word to change it. Amounts are before fees."}
              </p>
            )}
          </>
        )}
      </div>
      {
        <div
          className={"rail"}
          data-testid={"positions-row"}
          role={"tablist"}
          aria-label={"Your positions"}
        >
          {positions.map((p) => {
            const x = positionMetrics(p, marks[p.market]);
            const mm = MK[p.market];
            const L = p.side === "long" ? p.sl.price : p.tp.price,
              R = p.side === "long" ? p.tp.price : p.sl.price;
            const at = clamp((marks[p.market] - L) / (R - L), 0, 1);
            return (
              <button
                key={p.key}
                role={"tab"}
                aria-selected={sel === p.key}
                className={"pchip"}
                onClick={() => {
                  setSel(sel === p.key ? "new" : p.key);
                  setOpen(null);
                  setReview(null);
                }}
              >
                <span className={"pc-t"}>
                  <b>{mm.id}</b>
                  <span className={"side " + p.side}>
                    {p.side === "long" ? "↗ long" : "↘ short"}
                  </span>
                </span>
                <span className={"pc-v " + (x.gross >= 0 ? "g" : "r")}>
                  <Odo text={fmtUsd(x.gross, 2, true)} />
                </span>
                <span className={"pc-bar"} aria-hidden={"true"}>
                  <i
                    style={{
                      left: at * 100 + "%",
                    }}
                  />
                </span>
                {(engine.kind === "live"
                  ? p.sl.status !== "waiting"
                  : p.sl.status !== "registered" && p.status === "active") && (
                  <span className={"pc-warn"}>
                    {engine.kind !== "live"
                      ? "protecting\u2026"
                      : p.sl.status === "changing"
                        ? "Moving stop\u2026"
                        : p.sl.status === "missing"
                          ? "No stop set"
                          : p.sl.status.startsWith("restore")
                            ? "Enable access to see exits"
                            : "Checking exits\u2026"}
                  </span>
                )}
              </button>
            );
          })}
          {bk.result &&
            !book[bk.result.market] &&
            (() => {
              const r = bk.result;
              const rm = MK[r.market];
              const title = {
                tp: "Take profit hit",
                sl: "Stop hit",
                liq: "Liquidated",
                manual: "Position closed",
              }[r.reason];
              const sub =
                r.reason === "liq"
                  ? `${fmtUsd(r.ret)} returned to you`
                  : r.exit === undefined
                    ? `${r.market} ${r.side} closed · after fees`
                    : `${r.market} ${r.side} closed at ${fmtP(r.exit, rm).replace(/\.0+$/, "")} · after fees`;
              return (
                <div
                  className={"pchip result " + (r.net >= 0 ? "win" : "loss")}
                  role={"status"}
                >
                  <span className={"rs-t"}>
                    <b>{title}</b>
                    <span>{sub}</span>
                  </span>
                  <span className={"rs-v " + (r.net >= 0 ? "g" : "r")}>
                    {fmtUsd(r.net, 2, true)}
                  </span>
                  <span className={"rs-a"}>
                    <button
                      onClick={() =>
                        setSheet({
                          k: "account",
                        })
                      }
                    >
                      {"History"}
                    </button>
                    <button aria-label={"Dismiss"} onClick={bk.clearResult}>
                      {"\xD7"}
                    </button>
                  </span>
                </div>
              );
            })()}
          {/* Notices sit here, right of the open positions, and leave on their own. */}
          {bk.toasts.map((t) => (
            <div
              key={t.id}
              className={
                "pchip result note" +
                (t.kind === "g" ? " win" : t.kind === "r" ? " loss" : "")
              }
              role={"status"}
            >
              <span className={"rs-t"}>{t.t}</span>
            </div>
          ))}
          {positions.length === 0 &&
            !bk.result &&
            !bk.toasts.length &&
            (authed ? (
              <span className={"rail-empty"}>
                {engine.positions.state === "observed"
                  ? engine.positions.stale
                    ? "Position details are stale. Restore access and refresh."
                    : "No active positions. Your positions will sit here."
                  : engine.positions.reason}
              </span>
            ) : (
              <button
                className={"rail-empty login-hint"}
                onClick={() => px.login()}
              >
                {"Log in to view your active positions"}
              </button>
            ))}
          {positions.length > 0 && (
            <span className={"rail-sum"}>
              {positions.length}
              {" open \xB7 "}
              <b className={totalNet >= 0 ? "g" : "r"}>
                {fmtUsd(totalNet, 2, true)}
              </b>
            </span>
          )}
        </div>
      }
      <div className={"chartbox"} data-testid={"chart"}>
        <div className={"ctools"}>
          <div className={"tfs"} role={"group"} aria-label={"Chart range"}>
            {Object.keys(TF).map((k) => (
              <button
                key={k}
                aria-pressed={tf === k}
                onClick={() => {
                  setTf(k);
                  engine.loadChartRange?.(market, k);
                }}
              >
                {k === "live" ? (
                  <>
                    <i className={"dot"} />
                    {"Live"}
                  </>
                ) : (
                  TF[k].label
                )}
              </button>
            ))}
          </div>
          {tf !== "live" && (
            <span
              className={"tfchg " + (tfChange(market, tf) >= 0 ? "g" : "r")}
            >
              {pm.id}{" "}
              {engine.kind === "live"
                ? engine.chartRanges?.[market + tf]?.state === "observed"
                  ? fmtPct(tfChange(market, tf))
                  : "Historical range unavailable"
                : fmtPct(tfChange(market, tf))}{" "}
              <small>
                {tf === "1H" ? "past hour" : tf === "1D" ? "24h" : "7 days"}
              </small>
            </span>
          )}
          {pos && engine.demoNudge && (
            <div
              className={"simdock" + (demo ? " open" : "")}
              aria-label={"Demo: move the price"}
            >
              <button
                className={"dtog"}
                aria-expanded={demo}
                onClick={() => setDemo(!demo)}
              >
                {"Demo"}
                <span>{": move price"}</span>
              </button>
              <span className={"dbtns"}>
                <button onClick={() => engine.demoNudge?.(market, -0.01)}>
                  {"\u22121%"}
                </button>
                <button onClick={() => engine.demoNudge?.(market, 0.01)}>
                  {"+1%"}
                </button>
                <button onClick={() => engine.demoNudge?.(market, "tp")}>
                  {"Hit take profit"}
                </button>
                <button onClick={() => engine.demoNudge?.(market, "sl")}>
                  {"Hit stop"}
                </button>
              </span>
            </div>
          )}
        </div>
        <LiveChart
          tf={tf}
          market={market}
          mark={pM}
          lv={lv}
          pos={pos}
          T={TH}
          layout={(W, H) => LAYOUT(W, H)}
          pnlAxis
          onTarget={(v, drag) =>
            drag
              ? setDragV({
                  k: "T",
                  v,
                })
              : set({
                  target: nearT(v),
                })
          }
          onStop={(v, drag) =>
            drag
              ? setDragV({
                  k: "S",
                  v,
                })
              : set({
                  stop: v,
                })
          }
          onAmend={(k, v, y) => {
            setDragV(null);
            setAmend({
              k,
              v,
              y,
              mk: market,
            });
          }}
        />
      </div>
      {!pos && open === "goal" && anchor && (
        <EditPop
          anchor={anchor}
          onClose={() => setOpen(null)}
          label={"Profit goal"}
        >
          <h4>{"How much do you want to make?"}</h4>
          <NumIn
            value={draft.goal}
            rawValue={engine.draftValue?.(draft, "goal")}
            onRawPreview={
              engine.editRawDraft
                ? (raw) =>
                    setDraft(engine.editRawDraft!(draft, "goal", raw, false))
                : undefined
            }
            onRawCommit={
              engine.editRawDraft
                ? (raw) =>
                    setDraft(engine.editRawDraft!(draft, "goal", raw, true))
                : undefined
            }
            label={"Profit goal"}
            onPreview={(v) =>
              set({
                goal: Math.round(v * 100) / 100,
              })
            }
            onCommit={(v) =>
              set({
                goal: Math.max(1, Math.round(v * 100) / 100),
              })
            }
          />
          <Slider
            value={clamp(
              Math.round(draft.goal),
              1,
              Math.max(2, Math.floor(calc.gMax || 1)),
            )}
            min={1}
            max={Math.max(2, Math.floor(calc.gMax || 1))}
            step={1}
            color={"var(--gold)"}
            label={"Profit goal"}
            disabled={!Number.isFinite(calc.gMax)}
            valuetext={fmtShort(draft.goal)}
            onChange={(v) =>
              set({
                goal: v,
              })
            }
          />
          <div className={"ep-foot"}>
            <span>
              <b>{"$1"}</b>
              {"min"}
            </span>
            <span>
              <b>{calc.required != null ? fmtUsd(calc.required) : "—"}</b>
              {"collateral"}
            </span>
            <span>
              {authed ? (
                <>
                  <b>
                    {Number.isFinite(calc.gMax)
                      ? fmtShort(Math.floor(calc.gMax))
                      : "—"}
                  </b>
                  {"most with your funds"}
                </>
              ) : (
                ""
              )}
            </span>
          </div>
        </EditPop>
      )}
      {!pos && open === "market" && anchor && (
        <EditPop anchor={anchor} onClose={() => setOpen(null)} label={"Market"}>
          <h4 style={{ display: "flex", justifyContent: "space-between" }}>
            <span>{"Choose a market"}</span>
            <span>{"24h change"}</span>
          </h4>
          {["ETH", "BTC"].map((id) => (
            <button
              key={id}
              className={"mrow"}
              role={"option"}
              aria-selected={draft.market === id}
              onClick={() => pick(id)}
            >
              <b>{id}</b>
              <span>
                {fmtP(marks[id], MK[id])}
                {book[id] ? (
                  <>
                    {" \xB7 "}
                    <em>
                      {"you\u2019re "}
                      {book[id].side}
                    </em>
                  </>
                ) : (
                  ""
                )}
              </span>
              <span className={MK[id].chg >= 0 ? "g" : "r"}>
                {fmtPct(MK[id].chg)}
              </span>
            </button>
          ))}
        </EditPop>
      )}
      {!pos && open === "target" && anchor && (
        <EditPop
          anchor={anchor}
          onClose={() => {
            setOpen(null);
            setFrozen(null);
          }}
          label={"Target price"}
        >
          <h4>
            {m.id}
            {" is "}
            {fmtP(F.M, m)}
            {" now"}
          </h4>
          <NumIn
            value={draft.target}
            rawValue={engine.draftValue?.(draft, "target")}
            onRawPreview={
              engine.editRawDraft
                ? (raw) =>
                    setDraft(engine.editRawDraft!(draft, "target", raw, false))
                : undefined
            }
            onRawCommit={
              engine.editRawDraft
                ? (raw) =>
                    setDraft(engine.editRawDraft!(draft, "target", raw, true))
                : undefined
            }
            label={"Target price"}
            dp={m.dp}
            onPreview={(v) =>
              set({
                target: v,
              })
            }
            onCommit={(v) =>
              set({
                target: fixP(roundTick(v, m), m),
              })
            }
          />
          <Slider
            value={clamp(tPct, tDom.lo, Math.max(tDom.hi, tPct))}
            min={tDom.lo}
            max={Math.max(tDom.hi, tPct)}
            step={0.1}
            color={"var(--mint)"}
            label={"Distance from today\u2019s price"}
            valuetext={fmtPct(tPct)}
            badge={fmtPct(tPct)}
            onChange={(v) =>
              set({
                target: nearT(fixP(roundTick(F.M * (1 + v / 100), m), m)),
              })
            }
          />
          <div className={"ep-foot"}>
            <span>
              <b>{fmtPct(tDom.lo)}</b>
              {"lowest"}
            </span>
            <span>
              <b className={"g"}>{calc.q ? fmtUsd(calc.netT, 2, true) : "—"}</b>
              {"you\u2019d make, after fees"}
            </span>
            <span>
              <b>{fmtPct(Math.max(tDom.hi, tPct))}</b>
              {"highest"}
            </span>
          </div>
        </EditPop>
      )}
      {!pos && open === "stop" && anchor && (
        <EditPop
          anchor={anchor}
          onClose={() => {
            setOpen(null);
            setFrozen(null);
          }}
          label={"Stop price"}
        >
          <h4>{"Stop loss"}</h4>
          <NumIn
            value={draft.stop}
            rawValue={engine.draftValue?.(draft, "stop")}
            onRawPreview={
              engine.editRawDraft
                ? (raw) =>
                    setDraft(engine.editRawDraft!(draft, "stop", raw, false))
                : undefined
            }
            onRawCommit={
              engine.editRawDraft
                ? (raw) =>
                    setDraft(engine.editRawDraft!(draft, "stop", raw, true))
                : undefined
            }
            label={"Stop price"}
            dp={m.dp}
            onPreview={(v) =>
              set({
                stop: v,
              })
            }
            onCommit={(v) =>
              set({
                stop: fixP(roundTick(v, m), m),
              })
            }
          />
          {sOK ? (
            <Slider
              value={clamp(
                +((draft.stop / F.M - 1) * 100).toFixed(1),
                sDom.lo,
                sDom.hi,
              )}
              min={sDom.lo}
              max={sDom.hi}
              step={0.1}
              color={"var(--coral)"}
              label={"Distance from today\u2019s price"}
              valuetext={fmtPct((draft.stop / F.M - 1) * 100)}
              badge={fmtPct((draft.stop / F.M - 1) * 100)}
              onChange={(v) =>
                set({
                  stop: fixP(roundTick(F.M * (1 + v / 100), m), m),
                })
              }
            />
          ) : (
            <p className={"ep-note"}>
              {engine.detailsReason ??
                "There\u2019s no safe stop at this leverage. Lower the leverage."}
            </p>
          )}
          <div className={"ep-foot"}>
            <span>
              <b>{sOK ? fmtP(F.sLo, m) : "—"}</b>
              {d > 0 ? "lowest safe stop" : "closest"}
            </span>
            <span>
              <b className={"r"}>
                {calc.netS != null ? fmtUsd(calc.netS) : "—"}
              </b>
              {"you\u2019d lose"}
            </span>
            <span>
              <b>{sOK ? fmtP(F.sHi, m) : "—"}</b>
              {d > 0 ? "closest" : "highest safe stop"}
            </span>
          </div>
          <p className={"ep-note"}>
            {"Closes at market when "}
            {m.id}
            {" hits this price. The fill can be a little "}
            {d > 0 ? "lower" : "higher"}
            {"."}
          </p>
        </EditPop>
      )}
      {pos && (open === "tp" || open === "sl") && anchor && posPop(open)}
      <div
        className={"bar"}
        data-testid={"bottom-bar"}
        role={"toolbar"}
        aria-label={pos ? "Position controls" : "Trade summary"}
      >
        {pos ? (
          <>
            <div className={"seg"}>
              <small>{"Position"}</small>
              <b>
                {fmtQ(pos.q, pm)} {pm.id}
              </b>
              <small>
                {pos.side === "long" ? "bought" : "sold"}
                {" at "}
                {fmtP(pos.E, pm)}
              </small>
            </div>
            <span className={"vsep"} />
            <button
              className={"seg act"}
              onClick={() =>
                setSheet({
                  k: "margin",
                })
              }
              aria-label={"Add collateral"}
            >
              <small>
                <Tip text={GLOSS.collateral}>{"Collateral"}</Tip>
              </small>
              <b>
                {fmtUsd(pos.C)} <span className={"mini"}>{"\xB1"}</span>
              </b>
              <small>
                {Number.isFinite(pos.E) && Number.isFinite(pos.C)
                  ? live.effectiveLeverage.toFixed(1)
                  : "—"}
                {"x leverage"}
              </small>
            </button>
            <span className={"vsep"} />
            <div className={"seg"}>
              <small>
                <Tip text={GLOSS.liq}>{"Liquidation"}</Tip>
              </small>
              <b>{fmtP(pliq, pm)}</b>
              <small>
                {Number.isFinite(pliq)
                  ? Math.abs((pliq / pM - 1) * 100).toFixed(0)
                  : "—"}
                {"% away"}
              </small>
            </div>
            {(Number.isFinite(lv.T) || Number.isFinite(lv.S)) && (
              <>
                <span className={"vsep hide-m"} />
                <div className={"seg hide-m"}>
                  <small>{"If target hits"}</small>
                  <b className={exitPnl(lv.T) >= 0 ? "g" : "r"}>
                    {fmtUsd(exitPnl(lv.T), 2, true)}
                  </b>
                  <small>
                    {"at "}
                    {fmtP(lv.T, pm).replace(/\.0+$/, "")}
                  </small>
                </div>
                <span className={"vsep hide-m"} />
                <div className={"seg hide-m"}>
                  <small>{"If stopped"}</small>
                  <b className={exitPnl(lv.S) >= 0 ? "g" : "r"}>
                    {fmtUsd(exitPnl(lv.S), 2, true)}
                  </b>
                  <small>
                    {"at "}
                    {fmtP(lv.S, pm).replace(/\.0+$/, "")}
                  </small>
                </div>
              </>
            )}
            <span className={"vsep hide-m"} />
            <div className={"seg hide-m"}>
              <small>{"If you close now"}</small>
              <b className={live.netAfterFunding >= 0 ? "g" : "r"}>
                <Odo text={fmtUsd(live.netAfterFunding, 2, true)} />
              </b>
              <small>{"after fees"}</small>
            </div>
            <button
              className={"cta red"}
              onClick={() =>
                setSheet({
                  k: "close",
                })
              }
              aria-disabled={pos.status !== "active"}
            >
              {"Close"}
            </button>
          </>
        ) : (
          <>
            <div className={"seg"}>
              <small>{d > 0 ? "Long" : "Short"}</small>
              <b>{calc.q ? fmtQ(calc.q, m) + " " + m.id : "—"}</b>
            </div>
            <span className={"vsep"} />
            <div className={"seg"}>
              <small>
                <Tip text={GLOSS.collateral}>{"Collateral"}</Tip>
              </small>
              <b>
                <Odo
                  text={calc.required != null ? fmtUsd(calc.required) : "—"}
                />
              </b>
            </div>
            <span className={"vsep"} />
            <div className={"seg"}>
              <small>
                <Tip text={GLOSS.lev}>{"Leverage"}</Tip>
              </small>
              <span className={"step"}>
                <button
                  aria-label={"Lower leverage"}
                  onClick={() =>
                    set({
                      lev: Math.max(1, +(draft.lev - 0.5).toFixed(2)),
                    })
                  }
                >
                  {"\u2212"}
                </button>
                <b
                  style={{
                    minWidth: "44px",
                    textAlign: "center",
                  }}
                >
                  {draft.lev.toFixed(1)}
                  {"x"}
                </b>
                <button
                  aria-label={"Raise leverage"}
                  onClick={() =>
                    set({
                      lev: Math.min(
                        engine.kind === "live"
                          ? draft.market === "BTC"
                            ? 15
                            : 12
                          : 5,
                        +(draft.lev + 0.5).toFixed(2),
                      ),
                    })
                  }
                >
                  {"+"}
                </button>
              </span>
            </div>
            <span className={"vsep hide-m"} />
            <div className={"seg hide-m"}>
              <small>
                <Tip text={GLOSS.liq}>{"Liquidation"}</Tip>
              </small>
              <b>{calc.liq ? fmtP(calc.liq, m) : "—"}</b>
            </div>
            <span className={"vsep hide-m"} />
            <div className={"seg hide-m"}>
              <small>{"If stopped"}</small>
              <b className={"r"}>
                {calc.netS != null ? fmtUsd(calc.netS) : "—"}
              </b>
            </div>
            <button
              className={"cta"}
              aria-disabled={!canReview}
              onClick={startReview}
            >
              {adding ? "Review add" : "Review"}
            </button>
          </>
        )}
      </div>
      {amend && pos && (
        <div
          className={"confirm"}
          style={{
            top: clamp(amend.y, 80, innerHeight - 80) + "px",
          }}
          role={"dialog"}
          aria-label={"Confirm order change"}
        >
          {"Move "}
          {amend.k === "tp" ? "take profit" : "stop"}
          {" to "}
          <b>{fmtP(amend.v, pm)}</b>
          {"?"}
          <button
            className={"ghost solid"}
            onClick={async () => {
              const a = amend;
              setAmend(null);
              if (engine.kind === "live") {
                const outcome = await engine.moveProtection?.(
                  a.mk,
                  a.k,
                  String(a.v),
                );
                // Already past this price: the popover holds the acknowledgment.
                const chip = tkEls.current[a.k];
                if (outcome?.state === "acknowledge" && chip)
                  openPop(a.k, chip, { which: a.k, v: a.v });
              } else if (await gate(amendReq(pos, a.k, a.v)))
                bk.amend(a.mk, a.k, a.v);
            }}
          >
            {"Save"}
          </button>
          <button className={"ghost"} onClick={() => setAmend(null)}>
            {"Cancel"}
          </button>
        </div>
      )}
      {review && (
        <aside
          className={"drawer"}
          role={"dialog"}
          aria-modal={"true"}
          aria-labelledby={"rv-h"}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !bk.steps) setReview(null);
          }}
        >
          <div className={"dh"}>
            <h2 id={"rv-h"} tabIndex={-1} ref={drawerH}>
              {adding ? "Add to your position" : "Your trade plan"}
            </h2>
            {stale ? (
              <button className={"ghost"} onClick={startReview}>
                {"Prices moved \xB7 Refresh"}
              </button>
            ) : (
              <span className={"fresh"}>
                <svg viewBox={"0 0 20 20"}>
                  <circle className={"t"} cx={"10"} cy={"10"} r={"8"} />
                  <circle
                    className={"p"}
                    cx={"10"}
                    cy={"10"}
                    r={"8"}
                    strokeDasharray={"50.27"}
                    strokeDashoffset={50.27 * (age / QUOTE_LIFE)}
                  />
                </svg>
                {Math.max(0, Math.ceil(QUOTE_LIFE - age))}
                {"s"}
              </span>
            )}
          </div>
          <p className={"re"}>
            {"Make "}
            <span className={"c-gold"}>{fmtShort(review.draft.goal)}</span>
            {" if "}
            <span className={"c-lav"}>{m.id}</span> {d > 0 ? "rises" : "falls"}
            {" to "}
            <span className={"c-mint"}>{fmtP(review.draft.target, m)}</span>
            {", stop at "}
            <span className={"c-coral"}>{fmtP(review.draft.stop, m)}</span>
            {"."}
          </p>
          {adding && (
            <p
              className={"ep-note"}
              style={{
                margin: 0,
              }}
            >
              {"Perpl combines this with your "}
              {fmtQ(ex.q, m)} {m.id} {ex.side}
              {". The new take profit and stop apply to the whole position."}
            </p>
          )}
          <div className={"rows"}>
            <div className={"r"}>
              <span className={"k"}>{d > 0 ? "You buy" : "You sell"}</span>
              <span className={"v"}>
                {fmtQ(review.q, m)} {m.id}
                <small>
                  {"at about "}
                  {fmtP(review.E, m)}
                </small>
              </span>
            </div>
            <div className={"r"}>
              <span className={"k"}>{"Collateral"}</span>
              <span className={"v"}>
                {fmtUsd(review.required)}
                <small>
                  {review.draft.lev.toFixed(1)}
                  {"x leverage"}
                </small>
              </span>
            </div>
            <div className={"r"}>
              <span className={"k"}>
                {"If "}
                {m.id}
                {" hits "}
                {fmtP(review.draft.target, m).replace(/\.0+$/, "")}
              </span>
              <span className={"v g"}>
                {fmtUsd(review.netT, 2, true)}
                <small>{"after fees"}</small>
              </span>
            </div>
            <div className={"r"}>
              <span className={"k"}>{"If stopped"}</span>
              <span className={"v r"}>
                {fmtUsd(review.netS)}
                <small>{"can be a bit worse in fast markets"}</small>
              </span>
            </div>
            <div className={"r"}>
              <span className={"k"}>{"Liquidation"}</span>
              <span className={"v"}>
                {fmtP(review.liq, m)}
                <small>
                  {Number.isFinite(review.liq)
                    ? Math.abs((review.liq / review.M - 1) * 100).toFixed(0)
                    : "—"}
                  {"% "}
                  {d > 0 ? "below" : "above"}
                  {" today\u2019s price"}
                </small>
              </span>
            </div>
          </div>
          <details className={"more"}>
            <summary>{"Details"}</summary>
            <div className={"rows"}>
              <div className={"r"}>
                <span className={"k"}>{"Position size"}</span>
                <span className={"v"}>{fmtUsd(review.notional)}</span>
              </div>
              <div className={"r"}>
                <span className={"k"}>{"Worst entry price"}</span>
                <span className={"v"}>
                  {fmtP(review.bound, m)}
                  <small>{"the order won\u2019t fill beyond this"}</small>
                </span>
              </div>
              <div className={"r"}>
                <span className={"k"}>{"Fee to open"}</span>
                <span className={"v"}>{fmtUsd(review.entryFee)}</span>
              </div>
              <div className={"r"}>
                <span className={"k"}>{"Funding"}</span>
                <span className={"v"}>
                  {engine.fundingLabel(
                    draft.side,
                    draft.market,
                    review.M,
                    review.q,
                  )}
                </span>
              </div>
            </div>
          </details>
          {bk.steps ? (
            <div className={"steps"} role={"status"}>
              {bk.steps.map((s, i) => (
                <div key={i} className={"st " + s.st}>
                  <i>{s.st === "done" ? "✓" : ""}</i>
                  {s.label}
                </div>
              ))}
            </div>
          ) : (
            <>
              <label className={"ack"}>
                <input
                  type={"checkbox"}
                  checked={ack}
                  onChange={(e) => setAck(e.currentTarget.checked)}
                />
                <span className={"box"}>
                  <svg viewBox={"0 0 12 10"}>
                    <path
                      d={"M1 5l3.5 3.5L11 1"}
                      fill={"none"}
                      stroke={"currentColor"}
                      strokeWidth={"2"}
                      strokeLinecap={"round"}
                      strokeLinejoin={"round"}
                    />
                  </svg>
                </span>
                <span>{"I understand I could lose up to my collateral."}</span>
              </label>
              <button
                className={"big"}
                aria-disabled={
                  engine.kind === "live"
                    ? !!review.liveId &&
                      (!ack || stale || busyOpen || !engine.executionAvailable)
                    : !ack || stale || busyOpen
                }
                onClick={async () => {
                  if (engine.kind === "live") {
                    if (!authed) {
                      await px.login();
                      return;
                    }
                    if (engine.sessionStatus?.state !== "active") {
                      await engine.command("enroll");
                      return;
                    }
                    if (!review.liveId) {
                      await startReview();
                      return;
                    }
                    if (!ack || stale || busyOpen) return;
                    setBusyOpen(true);
                    const sent = await engine.confirmReview?.(
                      review.liveId,
                      review.draft,
                    );
                    setBusyOpen(false);
                    // A sent order returns to the chart, where the position appears once it is read back.
                    if (sent?.state === "pending") {
                      setSel(review.draft.market);
                      setReview(null);
                    }
                    return;
                  }
                  if (!ack || stale || busyOpen) return;
                  const rv = review;
                  const mk = rv.draft.market;
                  setBusyOpen(true);
                  const ok = await gate(
                    {
                      title: `${adding ? "Add to" : "Open"} ${mk} ${rv.draft.side}`,
                      desc: `Make ${fmtShort(rv.draft.goal)} if ${mk} ${rv.draft.side === "long" ? "rises" : "falls"} to ${fmtP(rv.draft.target, MK[mk])}.`,
                      fn: "execOrder + TP/SL",
                      tap: true,
                      amt: rv.required,
                      rows: [
                        ["Size", `${fmtQ(rv.q, MK[mk])} ${mk}`],
                        ["Collateral", fmtUsd(rv.required)],
                        [
                          "Take profit · stop",
                          `${fmtP(rv.draft.target, MK[mk])} · ${fmtP(rv.draft.stop, MK[mk])}`,
                        ],
                      ],
                    },
                    engine.reviewDebit(rv),
                  );
                  setBusyOpen(false);
                  setQAt(Date.now());
                  if (!ok) return;
                  await bk.open(rv.draft, rv);
                  setReview(null);
                  setSel(mk);
                }}
              >
                {engine.kind === "live"
                  ? authed
                    ? engine.sessionStatus?.state !== "active"
                      ? "Enable account access"
                      : !review.liveId
                        ? "Refresh account review"
                        : engine.executionAvailable
                          ? "Open position"
                          : "Trading unavailable"
                    : "Log in to open position"
                  : !authed
                    ? "Log in and open"
                    : adding
                      ? "Add to position"
                      : "Open position"}
              </button>
              {!authed && (
                <p
                  className={"ep-note"}
                  style={{
                    margin: 0,
                    textAlign: "center",
                  }}
                >
                  {engine.kind === "live"
                    ? "Account access is required before trading."
                    : "Log in with email, Google or a wallet. New accounts get a Monad wallet automatically."}
                </p>
              )}
              <button className={"ghost"} onClick={() => setReview(null)}>
                {"Back to the chart"}
              </button>
            </>
          )}
        </aside>
      )}
      {sheet && sheet.k === "margin" && pos && (
        <CollateralSheet
          p={pos}
          M={pM}
          free={balance.free}
          onDo={async (a) => {
            const p = pos;
            if (
              await gate({
                title: `${a >= 0 ? "Add" : "Remove"} ${fmtUsd(Math.abs(a))} collateral`,
                desc: `${p.market} ${p.side}`,
                fn:
                  a >= 0
                    ? "increasePositionCollateral"
                    : "decreasePositionCollateral",
                tap: true,
                amt: Math.max(0, a),
                rows: [
                  [
                    "Collateral",
                    `${fmtUsd(p.C)} → ${fmtUsd(engine.collateralPreview(p, a).collateral)}`,
                  ],
                ],
              })
            )
              bk.margin(p.market, a);
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet && sheet.k === "close" && pos && (
        <CloseSheet
          p={pos}
          M={pM}
          onDo={async (f) => {
            const p = pos;
            if (
              await gate({
                title: `Close ${f >= 1 ? "" : Math.round(f * 100) + "% of "}${p.market} ${p.side}`,
                desc: "Closes at the current market price.",
                fn: "execOrder (reduce-only)",
                tap: true,
                rows: [
                  [
                    "Quantity",
                    `${fmtQ(f >= 1 ? p.q : p.q * f, MK[p.market])} ${p.market}`,
                  ],
                ],
              })
            )
              bk.close(p.market, f);
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet && sheet.k === "account" && authed && (
        <AccountSurface
          gate={gate}
          openTap={() => {
            setSheet(null);
            setTapOffer(true);
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {tapOffer && engine.oneTapSheet(() => setTapOffer(false))}
      {tapBanner &&
        !tapOffer &&
        !sheet &&
        !review &&
        !px.modal &&
        !px.tapOn() && (
          <div className={"tapban"} role={"status"}>
            <span className={"bolt"}>{Bolt}</span>
            <span>
              {"Trade without the pop-up for 24 hours?"}
              <small>{"Only on Perpl, up to $1,000 per trade."}</small>
            </span>
            <button
              className={"ghost solid"}
              onClick={() => {
                setTapBanner(false);
                setTapOffer(true);
              }}
            >
              {"Turn on"}
            </button>
            <button
              className={"x"}
              aria-label={"Not now"}
              onClick={() => setTapBanner(false)}
            >
              {"\xD7"}
            </button>
          </div>
        )}
      {engine.authLayer}
      {engine.liveControls}
    </div>
  );
}
export default function ReferenceView({ engine }: { engine: PerplEngine }) {
  return (
    <EngineProvider value={engine}>
      <App engine={engine} />
    </EngineProvider>
  );
}
