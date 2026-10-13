import { PrivyLayer, OneTapSheet } from "./auth";
import { seedLive, genRange, tfChange } from "./history";
import { stopBuffer, pnlNow } from "./core";
import React, { useState, useEffect, useRef } from "react";
import type {
  Draft,
  Marks,
  MarksSetter,
  RunTo,
  User,
  OneTap,
  Modal,
  Answer,
  SignRequest,
  Position,
  HistoryEntry,
  Result,
  Toast,
  Step,
  ExitReason,
  CompleteCalculation,
  PerplEngine,
} from "../types";
import {
  rng,
  MK,
  roundTick,
  fixP,
  vwapFor,
  topup,
  liqPrice,
  fmtUsd,
  fmtP,
  fmtQ,
  completeCalculation,
} from "./core";
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
export /* ================= Shared hooks: simulated marks + simulator ================= */
function useMarks(): [Marks, MarksSetter, RunTo] {
  const [marks, setMarks] = useState<Marks>({
    ETH: MK.ETH.mark0,
    BTC: MK.BTC.mark0,
  });
  const runTo = useRef<{
    market: string;
    price: number;
  } | null>(null);
  useEffect(() => {
    const r = rng(7);
    const id = setInterval(
      () => {
        // Draw once per tick: StrictMode may invoke the updater twice.
        const draws: Marks = { ETH: r(), BTC: r() };
        setMarks((mk) => {
          const out = {
            ...mk,
          };
          for (const k of ["ETH", "BTC"]) {
            const m = MK[k];
            let next = mk[k] * (1 + (draws[k] - 0.5) * 0.0006);
            if (runTo.current && runTo.current.market === k) {
              const g = runTo.current.price;
              next = mk[k] + (g - mk[k]) * 0.35;
              if (Math.abs(g - next) < Math.max(m.tick * 3, g * 0.0005))
                next = g;
            }
            out[k] = fixP(roundTick(next, m), m);
          }
          return out;
        });
      },
      reduce ? 1200 : 600,
    );
    return () => clearInterval(id);
  }, []);
  return [marks, setMarks, runTo];
}
export function usePrivy() {
  const [user, setUser] = useState<User | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [oneTap, setOneTap] = useState<OneTap | null>(null);
  const uref = useRef<User | null>(null);
  uref.current = user;
  const oref = useRef<OneTap | null>(null);
  oref.current = oneTap;
  const ask = (k: string, extra: Partial<Omit<Modal, "k" | "resolve">> = {}) =>
    new Promise<Answer>((res) =>
      setModal({
        k,
        ...extra,
        resolve: (v) => {
          setModal(null);
          res(v);
        },
      }),
    );
  const login = () => (uref.current ? Promise.resolve(true) : ask("login"));
  const fund = (need: number) =>
    ask("fund", {
      need,
    });
  const tapOn = () => {
    const o = oref.current;
    return !!(o && o.until > Date.now());
  };
  const sign = (req: SignRequest) => {
    if (
      req.tap &&
      tapOn() &&
      (req.amt || 0) <= (oref.current?.cap ?? 0) &&
      uref.current &&
      uref.current.embedded
    )
      return Promise.resolve<Answer>("tap");
    return ask("sign", {
      req,
    });
  };
  const logout = () => {
    setUser(null);
    setOneTap(null);
  };
  return {
    user,
    setUser,
    uref,
    modal,
    ask,
    login,
    fund,
    sign,
    oneTap,
    setOneTap,
    tapOn,
    logout,
  };
}
export /* ================= Multi-position simulator (one isolated position per market) ================= */
function useBook(marks: Marks, setMarks: MarksSetter, runTo: RunTo) {
  const [ledger, setLedger] = useState({
    wallet: 0,
    free: 0,
    locked: 0,
  });
  const [book, setBook] = useState<Record<string, Position>>({});
  const [hist, setHist] = useState<HistoryEntry[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const ref = useRef(book);
  ref.current = book;
  const mref = useRef(marks);
  mref.current = marks;
  const toast = (t: React.ReactNode, kind = "") => {
    const id = Math.random();
    setToasts((x) => [
      ...x.slice(-2),
      {
        id,
        t,
        kind,
      },
    ]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 8000);
  };
  const T = (ms: number) => new Promise((r) => setTimeout(r, reduce ? 60 : ms));
  const settle = (mk: string, exit: number, reason: ExitReason, frac = 1) => {
    const p = ref.current[mk];
    if (!p) return;
    if (runTo.current && runTo.current.market === mk) runTo.current = null;
    const m = MK[mk];
    const d = p.side === "long" ? 1 : -1;
    const qx = frac >= 1 ? p.q : Math.round((p.q * frac) / m.lot) * m.lot;
    const f = qx / p.q;
    const Cx = p.C * f,
      Fx = p.F * f,
      efx = p.entryFee * f;
    const gross = d * qx * (exit - p.E);
    const fee = reason === "liq" ? 0 : exit * qx * m.taker;
    const ret =
      reason === "liq"
        ? Math.max(0, Cx + gross + Fx) * 0.8
        : Cx + gross - fee + Fx;
    setLedger((l) => ({
      ...l,
      locked: Math.max(0, l.locked - Cx),
      free: l.free + ret,
    }));
    const net = reason === "liq" ? ret - Cx - efx : gross - fee - efx + Fx;
    setHist((h) =>
      [
        {
          market: mk,
          side: p.side,
          q: qx,
          E: p.E,
          exit,
          gross,
          net,
          reason,
          at: Date.now(),
        },
        ...h,
      ].slice(0, 20),
    );
    setBook((b) => {
      const n = {
        ...b,
      };
      if (f >= 0.9999) delete n[mk];
      else
        n[mk] = {
          ...p,
          q: p.q - qx,
          C: p.C - Cx,
          F: p.F - Fx,
          entryFee: p.entryFee - efx,
          status: "active",
        };
      return n;
    });
    const label = {
      tp: `Take profit hit on ${mk}`,
      sl: `Stop hit on ${mk}`,
      liq: `${mk} position liquidated`,
      manual:
        f >= 0.9999
          ? `Closed your ${mk} position`
          : `Closed ${fmtQ(qx, m)} ${mk}`,
    }[reason];
    if (f >= 0.9999)
      setResult({
        market: mk,
        side: p.side,
        reason,
        exit,
        net,
        ret,
        E: p.E,
        tp: p.tp.price,
        sl: p.sl.price,
        at: Date.now(),
      });
    else
      toast(
        <>
          <b>{label}</b> {fmtUsd(net, 2, true)}
          {" after fees"}
        </>,
        net >= 0 ? "g" : "r",
      );
  };
  useEffect(() => {
    for (const mk of Object.keys(ref.current)) {
      const p = ref.current[mk];
      if (p.status !== "active") continue;
      const m = MK[mk];
      const M = marks[mk];
      const d = p.side === "long" ? 1 : -1;
      if (p.tp.status === "registered" && d * (M - p.tp.price) >= 0) {
        settle(mk, p.tp.price, "tp");
        continue;
      }
      if (p.sl.status === "registered" && d * (M - p.sl.price) <= 0) {
        settle(mk, fixP(roundTick(p.sl.price * (1 - d * 0.0006), m), m), "sl");
        continue;
      }
      const liq = liqPrice(p.side, p.E, p.q, p.C, m.mmr, p.F);
      if (d * (M - liq) <= 0) settle(mk, liq, "liq");
    }
  }, [marks]);
  // funding accrues on every open position (sped up for the simulation)
  useEffect(() => {
    const id = setInterval(() => {
      setBook((b) => {
        const n = {
          ...b,
        };
        for (const mk of Object.keys(n)) {
          const p = n[mk];
          const m = MK[mk];
          const d = p.side === "long" ? 1 : -1;
          n[mk] = {
            ...p,
            F: p.F - d * m.fund * mref.current[mk] * p.q,
            fEv: (p.fEv || 0) + 1,
          };
        }
        return n;
      });
    }, 12000);
    return () => clearInterval(id);
  }, []);
  const open = async (dr: Draft, q: CompleteCalculation) => {
    setResult((r) => (r && r.market === dr.market ? null : r));
    const m = MK[dr.market];
    const ex = ref.current[dr.market];
    const st = [
      {
        label: "Placing your order",
        st: "run",
      },
      {
        label: "Waiting for it to fill",
        st: "wait",
      },
      {
        label: "Filled",
        st: "wait",
      },
      {
        label: "Setting take profit and stop",
        st: "wait",
      },
    ];
    const up = (i: number, s: string, label?: string | undefined) => {
      st[i] = {
        ...st[i],
        st: s,
        label: label || st[i].label,
      };
      setSteps([...st]);
    };
    setSteps([...st]);
    await T(600);
    up(0, "done");
    up(1, "run");
    await T(700);
    up(1, "done");
    const v = vwapFor(m, dr.side, mref.current[dr.market], q.n) || {
      E: q.E,
    };
    const qq = q.n * m.lot;
    const C =
      (v.E * qq) / dr.lev + topup(dr.side, mref.current[dr.market], v.E, qq);
    const fee = v.E * qq * m.taker;
    up(2, "done", `Filled ${fmtQ(qq, m)} ${m.id} at ${fmtP(v.E, m)}`);
    setLedger((l) => ({
      ...l,
      free: l.free - C - fee,
      locked: l.locked + C,
    }));
    setBook((b) => {
      const p = b[dr.market];
      const base: Pick<
        Position,
        "market" | "side" | "tp" | "sl" | "status" | "at"
      > = {
        market: dr.market,
        side: dr.side,
        tp: {
          price: dr.target,
          status: "pending",
        },
        sl: {
          price: dr.stop,
          status: "pending",
        },
        status: "active",
        at: Date.now(),
      };
      if (p && p.side === dr.side) {
        const nq = p.q + qq;
        return {
          ...b,
          [dr.market]: {
            ...p,
            ...base,
            q: nq,
            E: (p.E * p.q + v.E * qq) / nq,
            C: p.C + C,
            entryFee: p.entryFee + fee,
            goal: p.goal + dr.goal,
            lev: dr.lev,
            merged: true,
          },
        };
      }
      return {
        ...b,
        [dr.market]: {
          ...base,
          q: qq,
          E: v.E,
          C,
          entryFee: fee,
          F: 0,
          goal: dr.goal,
          lev: dr.lev,
        },
      };
    });
    up(3, "run");
    await T(800);
    setBook((b) =>
      b[dr.market]
        ? {
            ...b,
            [dr.market]: {
              ...b[dr.market],
              tp: {
                ...b[dr.market].tp,
                status: "registered",
              },
              sl: {
                ...b[dr.market].sl,
                status: "registered",
              },
            },
          }
        : b,
    );
    up(3, "done", "Take profit and stop set");
    await T(500);
    setSteps(null);
    toast(
      <>
        <b>
          {ex
            ? `Added to your ${m.id} position`
            : `You’re in: ${dr.side} ${fmtQ(qq, m)} ${m.id}`}
        </b>
        {" Take profit and stop are set."}
      </>,
      "g",
    );
  };
  const close = async (mk: string, frac: number) => {
    setBook((b) => ({
      ...b,
      [mk]: {
        ...b[mk],
        status: "closing",
      },
    }));
    await T(800);
    const p = ref.current[mk];
    if (!p) return;
    const m = MK[mk];
    const lots = Math.round((p.q * frac) / m.lot);
    const v = vwapFor(
      m,
      p.side === "long" ? "short" : "long",
      mref.current[mk],
      Math.max(1, lots),
    ) || {
      E: mref.current[mk],
    };
    settle(mk, v.E, "manual", frac);
  };
  const margin = async (mk: string, amt: number) => {
    const p = ref.current[mk];
    if (!p) return;
    const m = MK[mk];
    setBook((b) => ({
      ...b,
      [mk]: {
        ...b[mk],
        status: "margin",
      },
    }));
    await T(650);
    setLedger((l) => ({
      ...l,
      free: l.free - amt,
      locked: l.locked + amt,
    }));
    setBook((b) => ({
      ...b,
      [mk]: {
        ...b[mk],
        C: b[mk].C + amt,
        status: "active",
      },
    }));
    const nl = liqPrice(p.side, p.E, p.q, p.C + amt, m.mmr, p.F);
    toast(
      <>
        <b>
          {"Added "}
          {fmtUsd(Math.abs(amt))}
          {" collateral to "}
          {mk}
        </b>
        {" Liquidation moved to "}
        {fmtP(nl, m)}
      </>,
    );
  };
  const amend = async (mk: string, which: "tp" | "sl", price: number) => {
    setBook((b) =>
      b[mk]
        ? {
            ...b,
            [mk]: {
              ...b[mk],
              [which]: {
                ...b[mk][which],
                status: "changing",
                next: price,
              },
            },
          }
        : b,
    );
    await T(950);
    setBook((b) =>
      b[mk]
        ? {
            ...b,
            [mk]: {
              ...b[mk],
              [which]: {
                price: b[mk][which].next,
                status: "registered",
              },
            },
          }
        : b,
    );
    toast(
      <>
        <b>
          {which === "tp" ? "Take profit" : "Stop"}
          {" on "}
          {mk}
          {" moved"}
        </b>
        {" to "}
        {fmtP(price, MK[mk])}
      </>,
    );
  };
  const nudge = (mk: string, a: "tp" | "sl" | number) => {
    const p = ref.current[mk];
    const m = MK[mk];
    if (a === "tp" && p)
      runTo.current = {
        market: mk,
        price: p.tp.price + (p.side === "long" ? m.tick : -m.tick),
      };
    else if (a === "sl" && p)
      runTo.current = {
        market: mk,
        price: p.sl.price - (p.side === "long" ? m.tick * 4 : -m.tick * 4),
      };
    else {
      runTo.current = null;
      setMarks((x) => ({
        ...x,
        [mk]: fixP(
          roundTick(x[mk] * (1 + (typeof a === "number" ? a : 0)), m),
          m,
        ),
      }));
    }
  };
  const move = async (kind: string, amt: number) => {
    await T(500);
    if (kind === "deposit")
      setLedger((l) => ({
        ...l,
        wallet: l.wallet - amt,
        free: l.free + amt,
      }));
    else
      setLedger((l) => ({
        ...l,
        wallet: l.wallet + amt,
        free: l.free - amt,
      }));
    toast(
      <>
        <b>
          {kind === "deposit" ? "Deposited" : "Withdrew"} {fmtUsd(amt)}
        </b>{" "}
        {kind === "deposit" ? "to your trading balance" : "to your wallet"}
      </>,
    );
  };
  const credit = (amt: number) =>
    setLedger((l) => ({
      ...l,
      free: l.free + amt,
    }));
  const reset = () => {
    setLedger({
      wallet: 0,
      free: 0,
      locked: 0,
    });
    setBook({});
    setHist([]);
    setResult(null);
  };
  return {
    ledger,
    book,
    hist,
    toasts,
    steps,
    result,
    clearResult: () => setResult(null),
    open,
    close,
    margin,
    amend,
    nudge,
    move,
    credit,
    reset,
    toast,
  };
}

/* ================= Sheets ================= */
export type DemoBook = ReturnType<typeof useBook>;
export type DemoPrivy = ReturnType<typeof usePrivy>;
export function useDemoEngine(): PerplEngine {
  const [marks, setMarks, runTo] = useMarks();
  const bk = useBook(marks, setMarks, runTo);
  const px = usePrivy();
  const signs = useRef(0);
  const offered = useRef(false);
  const gate = async (req: SignRequest, need = 0, offerTap?: () => void) => {
    if (!px.uref.current && !(await px.login())) return false;
    if (need > 0) {
      const lack = need - bk.ledger.free;
      if (lack > 0.005 && !(await px.fund(lack))) return false;
    }
    const r = await px.sign(req);
    if (r === "tap")
      bk.toast(
        <>
          <b>
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path
                d="M9.2 1L3 9.2h4.3L6.6 15 13 6.6H8.6z"
                fill="currentColor"
              />
            </svg>
            {" Signed instantly"}
          </b>
          {" one-tap trading"}
        </>,
      );
    if (r === true) {
      signs.current++;
      const u = px.uref.current;
      if (
        signs.current >= 2 &&
        !offered.current &&
        u?.embedded &&
        !px.tapOn()
      ) {
        offered.current = true;
        setTimeout(() => offerTap?.(), 1600);
      }
    }
    return !!r;
  };
  return {
    kind: "demo",
    canEditMarket: () => true,
    marks,
    markets: MK,
    bk,
    px,
    demoNudge: bk.nudge,
    balances: {
      state: "observed",
      value: bk.ledger,
      source: "Demo",
      at: Date.now(),
      stale: false,
    },
    refreshAccount: () => {},
    account: { state: "unavailable", reason: "Demo account" },
    history: {
      state: "observed",
      value: bk.hist,
      source: "Demo",
      at: Date.now(),
      stale: false,
    },
    positions: {
      state: "observed",
      value: Object.values(bk.book).map((p) => ({ ...p, key: p.market })),
      source: "Demo",
      at: Date.now(),
      stale: false,
    },
    calculate: (draft) => {
      const value = completeCalculation(
        { ...draft, budget: px.user ? bk.ledger.free : 1e9 },
        marks,
        px.user ? bk.ledger.free : 1e9,
      );
      const observed = {
        state: "observed" as const,
        value,
        source: "Demo",
        at: Date.now(),
        stale: false,
      };
      return { public: observed, details: observed };
    },
    gate,
    command: async () => ({
      state: "unavailable",
      reason: "Use demo commands",
    }),
    roundTick: (p, m) => Math.round(p / m.tick) * m.tick,
    fixP: (p, m) => +p.toFixed(m.dp),
    seedLive,
    genRange,
    tfChange,
    totalPositionNet: Object.values(bk.book).reduce(
      (sum, p) => sum + pnlNow(p, marks[p.market]).net + p.F,
      0,
    ),
    reviewDebit: (review) => review.required + review.entryFee,
    amendPreview: (p, which, price, mark) => {
      const direction = p.side === "long" ? 1 : -1;
      const liq = liqPrice(p.side, p.E, p.q, p.C, MK[p.market].mmr, p.F);
      return {
        gross: direction * p.q * (price - p.E),
        immediate:
          which === "tp"
            ? direction * (price - mark) <= 0
            : direction * (price - mark) >= 0,
        badStop:
          which === "sl" &&
          direction *
            (price - (liq + direction * stopBuffer(MK[p.market], mark))) <
            0,
      };
    },
    positionMetrics: (p, mark) => ({
      netAfterFunding: pnlNow(p, mark).net + p.F,
      effectiveLeverage: (p.E * p.q) / p.C,
      ...pnlNow(p, mark),
      liquidation: liqPrice(p.side, p.E, p.q, p.C, MK[p.market].mmr, p.F),
    }),
    stopBuffer: (m, mark) => stopBuffer(MK[m.id], mark),
    collateralPreview: (p, amount) => ({
      collateral: p.C + amount,
      leverageBefore: (p.E * p.q) / p.C,
      leverageAfter: (p.E * p.q) / (p.C + amount),
      remaining: bk.ledger.free - amount,
      before: liqPrice(p.side, p.E, p.q, p.C, MK[p.market].mmr, p.F),
      after: liqPrice(p.side, p.E, p.q, p.C + amount, MK[p.market].mmr, p.F),
    }),
    closePreview: (p, mark, percent) => {
      const m = MK[p.market];
      const lots = Math.round(p.q / m.lot);
      const n = percent === 100 ? lots : Math.floor((lots * percent) / 100);
      const q = n * m.lot;
      const v = vwapFor(
        m,
        p.side === "long" ? "short" : "long",
        mark,
        Math.max(1, n),
      ) || { E: mark };
      const gross = (p.side === "long" ? 1 : -1) * q * (v.E - p.E);
      const fee = v.E * q * m.taker;
      const fraction = q / p.q;
      const fees = fee + p.entryFee * fraction;
      return {
        n,
        q,
        entry: v.E,
        net: gross - fees + p.F * fraction,
        back: p.C * fraction + gross - fee + p.F * fraction,
        fees,
      };
    },
    fundingLabel: (side, market, mark, quantity) => {
      const funding = MK[market].fund;
      const x = Math.abs(funding) * mark * quantity;
      return (
        (funding > 0 === (side === "long") ? "you pay" : "you get") +
        " " +
        (x < 0.01 ? "under 1¢ an hour" : "about " + fmtUsd(x) + " an hour")
      );
    },
    accountTotals: {
      value:
        bk.ledger.free +
        bk.ledger.locked +
        Object.values(bk.book).reduce(
          (sum, p) => sum + pnlNow(p, marks[p.market]).gross + p.F,
          0,
        ),
      ...bk.ledger,
    },
    transferAccount: async (kind, amount, gate) => {
      const user = px.user;
      if (!user) return { state: "rejected" };
      const ok = await gate({
        title: `Withdraw ${fmtUsd(amount)}`,
        desc: "From your Perpl balance back to your wallet.",
        fn: "withdrawCollateral",
        rows: [
          ["Amount", fmtUsd(amount) + " AUSD"],
          ["To", user.addr.slice(0, 6) + "…" + user.addr.slice(-4)],
        ],
      });
      if (ok) await bk.move(kind, amount);
      return { state: ok ? "accepted" : "rejected" };
    },
    exportWallet: async () => {
      await px.ask("export");
      return { state: "accepted" };
    },
    logout: () => {
      px.logout();
      bk.reset();
    },
    authLayer: <PrivyLayer px={px} onCredit={bk.credit} />,
    oneTapSheet: (close) => (
      <OneTapSheet px={px} toast={bk.toast} onClose={close} />
    ),
  };
}
