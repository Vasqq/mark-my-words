import React, { useState, useEffect, useRef, useMemo } from "react";
import * as ReactDOM from "react-dom";
import type { Answer, User, SignRequest } from "../types";
import type { DemoBook as Book, DemoPrivy as Privy } from "./index";
import { fmtUsd, fmtShort } from "../../view/format";
import { Sheet, Bolt } from "../../view/ReferenceView";
const hex = (n: number) =>
  Array.from(
    {
      length: n,
    },
    () => "0123456789abcdef"[(Math.random() * 16) | 0],
  ).join("");
const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);
const PERPL_EX = "0x34b6c1e0f2a9d4c87b1e5f03a6d2c9e17b8f2e20";
const TAP_CAP = 1000,
  TAP_HRS = 24;
const Spin = <span className={"pv-spin"} aria-hidden={"true"} />;
const Check = (
  <svg viewBox={"0 0 24 24"} width={"22"} height={"22"} aria-hidden={"true"}>
    <path
      d={"M5 12.5l4.2 4.2L19 7"}
      fill={"none"}
      stroke={"currentColor"}
      strokeWidth={"2.6"}
      strokeLinecap={"round"}
      strokeLinejoin={"round"}
    />
  </svg>
);
const GIcon = (
  <svg viewBox={"0 0 20 20"} width={"18"} height={"18"} aria-hidden={"true"}>
    <path
      d={
        "M18.2 10.2c0-.6-.1-1.2-.2-1.7H10v3.3h4.6a4 4 0 0 1-1.7 2.6v2.1h2.8c1.6-1.5 2.5-3.7 2.5-6.3z"
      }
      fill={"#4285F4"}
    />
    <path
      d={
        "M10 18.5c2.3 0 4.2-.8 5.7-2.1l-2.8-2.1c-.8.5-1.8.8-2.9.8-2.2 0-4.1-1.5-4.8-3.6H2.3v2.2A8.5 8.5 0 0 0 10 18.5z"
      }
      fill={"#34A853"}
    />
    <path
      d={"M5.2 11.5a5 5 0 0 1 0-3.1V6.2H2.3a8.5 8.5 0 0 0 0 7.6z"}
      fill={"#FBBC05"}
    />
    <path
      d={
        "M10 4.9c1.3 0 2.4.4 3.3 1.3l2.5-2.5A8.5 8.5 0 0 0 2.3 6.2l2.9 2.2C5.9 6.4 7.8 4.9 10 4.9z"
      }
      fill={"#EA4335"}
    />
  </svg>
);
const WALLETS = [
  ["MetaMask", "#f6851b"],
  ["Rabby", "#7084ff"],
  ["Phantom", "#ab9ff2"],
  ["Coinbase Wallet", "#0052ff"],
  ["WalletConnect", "#3b99fc"],
];

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
function PvShell({
  children,
  onClose,
  label,
  back,
}: {
  children?: React.ReactNode;
  onClose?: (() => void) | null;
  label: string;
  back?: (() => void) | null;
}) {
  const ref = useRef<HTMLDivElement>(null!);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const f =
      ref.current &&
      ref.current.querySelector<HTMLElement>("input,button.pv-pri");
    f && f.focus();
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onClose) onClose();
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
      className={"pv-bg"}
      onClick={(e) => {
        if (e.target === e.currentTarget && onClose) onClose();
      }}
    >
      <div
        className={"pv"}
        role={"dialog"}
        aria-modal={"true"}
        aria-label={label}
        ref={ref}
      >
        <div className={"pv-top"}>
          {back ? (
            <button className={"pv-ic"} onClick={back} aria-label={"Back"}>
              {"\u2039"}
            </button>
          ) : (
            <span />
          )}
          {onClose ? (
            <button className={"pv-ic"} onClick={onClose} aria-label={"Close"}>
              {"\xD7"}
            </button>
          ) : (
            <span />
          )}
        </div>
        {children}
        <div className={"pv-foot"}>
          {"Protected by "}
          <b>{"privy"}</b>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ---------- login: email OTP, Google, X, or external wallet; embedded wallet created on first login ---------- */
function PvLogin({ px, done }: { px: Privy; done: (v: Answer) => void }) {
  const [st, setSt] = useState<LoginState>({
    s: "home",
  });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const finish = (u: User) => {
    setSt({
      s: "creating",
      u,
    });
    setTimeout(
      () => {
        setSt({
          s: "ok",
          u,
        });
        setTimeout(
          () => {
            px.setUser(u);
            done(true);
          },
          reduce ? 50 : 900,
        );
      },
      reduce ? 50 : u.embedded ? 1500 : 600,
    );
  };
  const okEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const social = (name: string, label: string) => {
    setSt({
      s: "social",
      name,
    });
    setTimeout(
      () =>
        finish({
          method: name,
          label,
          addr: "0x" + hex(40),
          embedded: true,
        }),
      reduce ? 50 : 1100,
    );
  };
  useEffect(() => {
    if (st.s === "otp" && code.length === 6)
      finish({
        method: "email",
        label: email,
        addr: "0x" + hex(40),
        embedded: true,
      });
  }, [code]);
  const close = st.s === "creating" || st.s === "ok" ? null : () => done(false);
  const back =
    st.s === "otp" || st.s === "wallets"
      ? () => {
          setSt({
            s: "home",
          });
          setCode("");
        }
      : st.s === "wconnect"
        ? () =>
            setSt({
              s: "wallets",
            })
        : null;
  return (
    <PvShell label={"Log in or sign up"} onClose={close} back={back}>
      {st.s === "home" && (
        <>
          <div className={"pv-head"}>
            <span className={"pv-logo"}>
              {"perpl"}
              <b>{"."}</b>
            </span>
            <h3>{"Log in or sign up"}</h3>
            <p>
              {
                "To place trades on Perpl. Looking around never needs an account."
              }
            </p>
          </div>
          <form
            className={"pv-email"}
            onSubmit={(e) => {
              e.preventDefault();
              if (okEmail)
                setSt({
                  s: "otp",
                });
            }}
          >
            <svg
              viewBox={"0 0 20 20"}
              width={"18"}
              height={"18"}
              aria-hidden={"true"}
            >
              <rect
                x={"2.5"}
                y={"4.5"}
                width={"15"}
                height={"11"}
                rx={"2.5"}
                fill={"none"}
                stroke={"currentColor"}
                strokeWidth={"1.6"}
              />
              <path
                d={"M3.5 6l6.5 5 6.5-5"}
                fill={"none"}
                stroke={"currentColor"}
                strokeWidth={"1.6"}
              />
            </svg>
            <input
              type={"email"}
              placeholder={"your@email.com"}
              aria-label={"Email"}
              value={email}
              onInput={(e) => setEmail(e.currentTarget.value)}
            />
            <button type={"submit"} disabled={!okEmail}>
              {"Submit"}
            </button>
          </form>
          <button
            className={"pv-opt"}
            onClick={() => social("google", "Google account")}
          >
            {GIcon}
            <span>{"Google"}</span>
          </button>
          <button
            className={"pv-opt"}
            onClick={() => social("twitter", "X account")}
          >
            <span className={"pv-x"} aria-hidden={"true"}>
              {"\uD835\uDD4F"}
            </span>
            <span>{"X / Twitter"}</span>
          </button>
          <button
            className={"pv-opt"}
            onClick={() =>
              setSt({
                s: "wallets",
              })
            }
          >
            <span className={"pv-wi"} aria-hidden={"true"}>
              <svg viewBox={"0 0 20 20"} width={"16"} height={"16"}>
                <rect
                  x={"2"}
                  y={"5"}
                  width={"16"}
                  height={"11"}
                  rx={"2.5"}
                  fill={"none"}
                  stroke={"currentColor"}
                  strokeWidth={"1.6"}
                />
                <circle cx={"14"} cy={"10.5"} r={"1.3"} fill={"currentColor"} />
              </svg>
            </span>
            <span>{"Continue with a wallet"}</span>
            <em>{"\u203A"}</em>
          </button>
          <p className={"pv-fine"}>
            {
              "New here? Logging in creates a Monad wallet for you. No seed phrase, no extension."
            }
          </p>
        </>
      )}
      {st.s === "otp" && (
        <>
          <div className={"pv-head"}>
            <span className={"pv-badge"}>
              {
                <svg
                  viewBox={"0 0 20 20"}
                  width={"22"}
                  height={"22"}
                  aria-hidden={"true"}
                >
                  <rect
                    x={"2.5"}
                    y={"4.5"}
                    width={"15"}
                    height={"11"}
                    rx={"2.5"}
                    fill={"none"}
                    stroke={"currentColor"}
                    strokeWidth={"1.6"}
                  />
                  <path
                    d={"M3.5 6l6.5 5 6.5-5"}
                    fill={"none"}
                    stroke={"currentColor"}
                    strokeWidth={"1.6"}
                  />
                </svg>
              }
            </span>
            <h3>{"Enter confirmation code"}</h3>
            <p>
              {"Check "}
              <b>{email}</b>
              {" for an email from privy.io and enter the code below."}
            </p>
          </div>
          <label className={"pv-otp"}>
            <input
              inputMode={"numeric"}
              autoComplete={"one-time-code"}
              maxLength={6}
              aria-label={"6 digit code"}
              value={code}
              onInput={(e) =>
                setCode(e.currentTarget.value.replace(/\D/g, "").slice(0, 6))
              }
            />
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <span key={i} className={i === code.length ? "cur" : ""}>
                {code[i] || ""}
              </span>
            ))}
          </label>
          <button className={"pv-link"} onClick={() => setCode("482913")}>
            {"Simulation: fill the code for me"}
          </button>
        </>
      )}
      {st.s === "social" && (
        <div className={"pv-head pv-center"}>
          {Spin}
          <h3>
            {"Signing in with "}
            {st.name === "google" ? "Google" : "X"}
          </h3>
          <p>{"Finishing in the pop-up window\u2026"}</p>
        </div>
      )}
      {st.s === "wallets" && (
        <>
          <div className={"pv-head"}>
            <h3>{"Connect a wallet"}</h3>
            <p>{"Already on Monad? Use the wallet you have."}</p>
          </div>
          {WALLETS.map(([n, c]) => (
            <button
              key={n}
              className={"pv-opt"}
              onClick={() =>
                setSt({
                  s: "wconnect",
                  name: n,
                })
              }
            >
              <span
                className={"pv-wl"}
                style={{
                  background: c,
                }}
                aria-hidden={"true"}
              >
                {n[0]}
              </span>
              <span>{n}</span>
              {n === "MetaMask" ? (
                <em className={"pv-tag"}>{"Detected"}</em>
              ) : (
                ""
              )}
            </button>
          ))}
        </>
      )}
      {st.s === "wconnect" && (
        <>
          <div className={"pv-head pv-center"}>
            <span
              className={"pv-wl big"}
              style={{
                background: (WALLETS.find((w) => w[0] === st.name) || [])[1],
              }}
              aria-hidden={"true"}
            >
              {st.name[0]}
            </span>
            <h3>
              {"Sign in with "}
              {st.name}
            </h3>
            <p>
              {st.name}
              {
                " asks you to sign a message proving you own this address. It costs nothing and moves no funds."
              }
            </p>
          </div>
          <pre className={"pv-msg"}>
            {"perpl.xyz wants you to sign in with your Ethereum account.\n\nChain ID: 143 (Monad)\nNonce: " +
              hex(8)}
          </pre>
          <button
            className={"pv-pri"}
            onClick={() =>
              finish({
                method: "wallet",
                label: st.name,
                addr: "0x" + hex(40),
                embedded: false,
                ext: st.name,
              })
            }
          >
            {"Simulate: sign in "}
            {st.name}
          </button>
        </>
      )}
      {st.s === "creating" && (
        <div className={"pv-head pv-center"}>
          {Spin}
          <h3>
            {st.u.embedded ? "Creating your wallet" : "Verifying signature"}
          </h3>
          <p>
            {st.u.embedded
              ? "A self-custodial wallet on Monad, secured by Privy. Only you can use it."
              : "Linking your wallet to Perpl…"}
          </p>
        </div>
      )}
      {st.s === "ok" && (
        <div className={"pv-head pv-center"}>
          <span className={"pv-badge ok"}>{Check}</span>
          <h3>{"You\u2019re in"}</h3>
          <p>
            {st.u.embedded ? "Your wallet" : st.u.ext}
            {" \xB7 "}
            <b className={"mono"}>{short(st.u.addr)}</b>
          </p>
        </div>
      )}
    </PvShell>
  );
}

/* ---------- funding: card / crypto transfer / faucet into the Privy wallet, then into Perpl ---------- */
function PvFund({
  px,
  need,
  onCredit,
  done,
}: {
  px: Privy;
  need: number;
  onCredit: (v: number) => void;
  done: (v: Answer) => void;
}) {
  const def = need ? Math.max(100, Math.ceil((need + 5) / 100) * 100) : 500;
  const [amt, setAmt] = useState(def);
  const [how, setHow] = useState("card");
  const [st, setSt] = useState("pick");
  const [steps, setSteps] = useState<
    {
      l: string;
      s: string;
    }[]
  >([]);
  const addr = px.user ? px.user.addr : "";
  const run = async () => {
    const lab =
      how === "card"
        ? [
            "Card payment approved",
            "AUSD received in your Privy wallet",
            "Deposited to Perpl · gas sponsored",
          ]
        : how === "crypto"
          ? [
              "Transfer detected",
              "Converted to AUSD on Monad",
              "Deposited to Perpl · gas sponsored",
            ]
          : ["Faucet sent testnet AUSD", "Deposited to Perpl · gas sponsored"];
    setSt("run");
    for (let i = 0; i < lab.length; i++) {
      setSteps(
        lab.map((l, j) => ({
          l,
          s: j < i ? "done" : j === i ? "run" : "wait",
        })),
      );
      await new Promise((r) => setTimeout(r, reduce ? 40 : 700));
    }
    setSteps(
      lab.map((l) => ({
        l,
        s: "done",
      })),
    );
    onCredit(amt);
    await new Promise((r) => setTimeout(r, reduce ? 40 : 600));
    done(amt);
  };
  return (
    <PvShell
      label={"Add funds"}
      onClose={st === "run" ? null : () => done(0)}
      back={st === "pay" || st === "addr" ? () => setSt("pick") : null}
    >
      {st === "pick" && (
        <>
          <div className={"pv-head"}>
            <h3>{"Add funds"}</h3>
            <p>
              {need ? (
                <>
                  {"This trade needs "}
                  <b>{fmtUsd(need)}</b>
                  {" more."}
                </>
              ) : (
                "Fund your trading balance on Perpl."
              )}
            </p>
          </div>
          <div className={"pv-amt"}>
            <span>{"$"}</span>
            <input
              inputMode={"decimal"}
              aria-label={"Amount in dollars"}
              value={amt}
              onInput={(e) =>
                setAmt(
                  Math.max(
                    0,
                    +e.currentTarget.value.replace(/[^\d.]/g, "") || 0,
                  ),
                )
              }
            />
            <small>{"AUSD"}</small>
          </div>
          <div className={"pv-chips"}>
            {[100, 500, 1000].map((v) => (
              <button
                key={v}
                aria-pressed={amt === v}
                onClick={() => setAmt(v)}
              >
                {fmtShort(v)}
              </button>
            ))}
          </div>
          <div
            className={"pv-ways"}
            role={"radiogroup"}
            aria-label={"Funding method"}
          >
            {[
              ["card", "Card or Apple Pay", "Instant"],
              ["crypto", "Transfer crypto", "From any chain or exchange"],
              ["faucet", "Test funds", "Free, for trying Perpl"],
            ].map(([k, t, s]) => (
              <button
                key={k}
                role={"radio"}
                aria-checked={how === k}
                onClick={() => setHow(k)}
              >
                <i />
                <span>
                  <b>{t}</b>
                  <small>{s}</small>
                </span>
              </button>
            ))}
          </div>
          <button
            className={"pv-pri"}
            disabled={amt < (need || 1)}
            onClick={() =>
              how === "card"
                ? setSt("pay")
                : how === "crypto"
                  ? setSt("addr")
                  : run()
            }
          >
            {amt < (need || 1) ? `At least ${fmtUsd(need || 1)}` : "Continue"}
          </button>
        </>
      )}
      {st === "pay" && (
        <>
          <div className={"pv-head"}>
            <h3>
              {"Pay "}
              {fmtUsd(amt)}
            </h3>
            <p>
              {"You receive "}
              <b>
                {fmtUsd(amt)}
                {" AUSD"}
              </b>
              {" on Monad. Card fees are shown before you pay."}
            </p>
          </div>
          <div className={"pv-card"}>
            <span className={"pv-visa"}>{"VISA"}</span>
            <span>{"\u2022\u2022\u2022\u2022 4242"}</span>
            <small>{"Simulated card"}</small>
          </div>
          <button className={"pv-pri"} onClick={run}>
            {"Pay "}
            {fmtUsd(amt)}
          </button>
        </>
      )}
      {st === "addr" && (
        <>
          <div className={"pv-head"}>
            <h3>{"Send to your wallet"}</h3>
            <p>
              {
                "Send USDC or USDT from any chain. It\u2019s converted to AUSD on Monad automatically."
              }
            </p>
          </div>
          <div className={"pv-addr"}>
            <span className={"pv-qr"} aria-hidden={"true"}>
              {Array.from(
                {
                  length: 49,
                },
                (_, i) => (
                  <i
                    key={i}
                    style={{
                      opacity:
                        (i * 7919) % 5 > 1 || [0, 6, 42, 48, 8, 40].includes(i)
                          ? 1
                          : 0,
                    }}
                  />
                ),
              )}
            </span>
            <span>
              <small>{"Your Privy wallet"}</small>
              <b className={"mono"}>{short(addr)}</b>
              <button
                className={"pv-link"}
                onClick={() => {
                  try {
                    navigator.clipboard.writeText(addr);
                  } catch (e) {}
                }}
              >
                {"Copy address"}
              </button>
            </span>
          </div>
          <button className={"pv-pri"} onClick={run}>
            {"Simulate incoming "}
            {fmtUsd(amt)}
          </button>
        </>
      )}
      {st === "run" && (
        <>
          <div className={"pv-head"}>
            <h3>
              {"Adding "}
              {fmtUsd(amt)}
            </h3>
          </div>
          <div className={"steps"}>
            {steps.map((s, i) => (
              <div key={i} className={"st " + s.s}>
                <i>{s.s === "done" ? "✓" : ""}</i>
                {s.l}
              </div>
            ))}
          </div>
        </>
      )}
    </PvShell>
  );
}

/* ---------- transaction confirmation (useSendTransaction uiOptions) ---------- */
function PvSign({
  px,
  req,
  done,
}: {
  px: Privy;
  req: SignRequest;
  done: (v: Answer) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [det, setDet] = useState(false);
  const u = px.user;
  if (!u) return null;
  const ext = u && !u.embedded;
  const go = async () => {
    setBusy(true);
    await new Promise((r) => setTimeout(r, reduce ? 40 : ext ? 1100 : 650));
    done(true);
  };
  return (
    <PvShell label={req.title} onClose={busy ? null : () => done(false)}>
      <div className={"pv-head"}>
        <span className={"pv-app"}>
          {"perpl"}
          <b>{"."}</b> <small>{"is asking you to confirm"}</small>
        </span>
        <h3>{req.title}</h3>
        {req.desc && <p>{req.desc}</p>}
      </div>
      <div className={"pv-rows"}>
        {(req.rows || []).map(([k, v], i) => (
          <div key={i}>
            <span>{k}</span>
            <b>{v}</b>
          </div>
        ))}
        <div>
          <span>{"From"}</span>
          <b className={"mono"}>
            {short(u.addr)} <small>{ext ? u.ext : "Privy wallet"}</small>
          </b>
        </div>
        <div>
          <span>{"Network"}</span>
          <b>{"Monad"}</b>
        </div>
        <div>
          <span>{"Network fee"}</span>
          <b className={"g"}>{ext ? "≈ $0.002 MON" : "Sponsored · $0.00"}</b>
        </div>
      </div>
      <button
        className={"pv-link"}
        onClick={() => setDet(!det)}
        aria-expanded={det}
      >
        {det ? "Hide" : "Show"}
        {" transaction details"}
      </button>
      {det && (
        <pre className={"pv-msg"}>
          {"to:   " +
            (req.to || "Perpl Exchange " + short(PERPL_EX)) +
            "\nfn:   " +
            (req.fn || "execOrder") +
            "\ndata: 0x" +
            hex(64) +
            "…"}
        </pre>
      )}
      {ext ? (
        <button className={"pv-pri"} disabled={busy} onClick={go}>
          {busy ? (
            <>
              {Spin}
              {" Waiting for "}
              {u.ext}
              {"\u2026"}
            </>
          ) : (
            `Simulate: confirm in ${u.ext}`
          )}
        </button>
      ) : (
        <button className={"pv-pri"} disabled={busy} onClick={go}>
          {busy ? (
            <>
              {Spin}
              {" Signing\u2026"}
            </>
          ) : (
            "Approve"
          )}
        </button>
      )}
      <button className={"pv-sec"} disabled={busy} onClick={() => done(false)}>
        {"Cancel"}
      </button>
    </PvShell>
  );
}
function PvExport({ done }: { px: Privy; done: (v: Answer) => void }) {
  const [show, setShow] = useState(false);
  const k = useMemo(() => "0x" + hex(64), []);
  return (
    <PvShell label={"Export wallet"} onClose={() => done(false)}>
      <div className={"pv-head"}>
        <h3>{"Export your wallet"}</h3>
        <p>
          {
            "Privy shows your key inside a secure frame. Perpl never sees it. Anyone with this key controls your funds."
          }
        </p>
      </div>
      <div className={"pv-key" + (show ? " on" : "")}>
        <span className={"mono"}>{k}</span>
      </div>
      <button className={"pv-pri"} onClick={() => setShow(!show)}>
        {show ? "Hide key" : "Reveal key"}
      </button>
      <p className={"pv-fine"}>{"Simulated key. It controls nothing."}</p>
    </PvShell>
  );
}
export function PrivyLayer({
  px,
  onCredit,
}: {
  px: Privy;
  onCredit: (v: number) => void;
}) {
  const m = px.modal;
  if (!m) return null;
  if (m.k === "login") return <PvLogin px={px} done={m.resolve} />;
  if (m.k === "fund")
    return (
      <PvFund px={px} need={m.need ?? 0} onCredit={onCredit} done={m.resolve} />
    );
  if (m.k === "sign" && m.req)
    return <PvSign px={px} req={m.req} done={m.resolve} />;
  if (m.k === "export") return <PvExport px={px} done={m.resolve} />;
  return null;
}

/* ---------- one-tap trading offer (session signer with a policy) ---------- */
export function OneTapSheet({
  px,
  onClose,
  toast,
}: {
  px: Privy;
  onClose: () => void;
  toast: Book["toast"];
}) {
  const on = px.tapOn();
  return (
    <Sheet
      title={on ? "One-tap trading is on" : "Trade in one tap"}
      onClose={onClose}
    >
      <p
        className={"ep-note"}
        style={{
          margin: 0,
          fontSize: "14px",
        }}
      >
        {on
          ? "Trades and edits sign instantly within these limits. Turn it off any time."
          : "Trade without the confirmation pop-up. It only works on Perpl, within the limits below, and you can turn it off any time."}
      </p>
      <div className={"rows"}>
        <div className={"r"}>
          <span className={"k"}>{"Can use"}</span>
          <span className={"v"}>{"Perpl Exchange only"}</span>
        </div>
        <div className={"r"}>
          <span className={"k"}>{"Per action"}</span>
          <span className={"v"}>
            {"Up to "}
            {fmtUsd(TAP_CAP, 0)}
            {" of collateral"}
          </span>
        </div>
        <div className={"r"}>
          <span className={"k"}>{on ? "Ends" : "Lasts"}</span>
          <span className={"v"}>
            {on
              ? new Date(px.oneTap?.until ?? 0).toLocaleString([], {
                  weekday: "short",
                  hour: "numeric",
                  minute: "2-digit",
                })
              : `${TAP_HRS} hours`}
          </span>
        </div>
        <div className={"r"}>
          <span className={"k"}>{"Always asks you"}</span>
          <span className={"v"}>
            {"Withdrawals and anything over the limit"}
          </span>
        </div>
      </div>
      {on ? (
        <button
          className={"big red"}
          onClick={() => {
            px.setOneTap(null);
            toast(
              <>
                <b>{"One-tap trading off"}</b>
                {" Each trade asks to confirm again."}
              </>,
            );
            onClose();
          }}
        >
          {"Turn off and revoke"}
        </button>
      ) : (
        <>
          <button
            className={"big"}
            onClick={async () => {
              onClose();
              const ok = await px.sign({
                title: "Enable one-tap trading",
                desc: "Adds a session signer to your Privy wallet with this policy.",
                fn: "addSigner",
                to: "Privy signer policy",
                rows: [
                  ["Contract", "Perpl Exchange"],
                  ["Limit", `${fmtUsd(TAP_CAP, 0)} per action`],
                  ["Expires", `in ${TAP_HRS}h`],
                ],
              });
              if (ok) {
                px.setOneTap({
                  until: Date.now() + TAP_HRS * 3600e3,
                  cap: TAP_CAP,
                });
                toast(
                  <>
                    <b>
                      {Bolt}
                      {" One-tap trading on"}
                    </b>
                    {" for "}
                    {TAP_HRS}
                    {" hours"}
                  </>,
                  "g",
                );
              }
            }}
          >
            {"Turn on one-tap trading"}
          </button>
          <button className={"ghost"} onClick={onClose}>
            {"Not now"}
          </button>
        </>
      )}
    </Sheet>
  );
}

/* ================= Small editors ================= */

type LoginState =
  | {
      s: "home" | "otp" | "wallets";
    }
  | {
      s: "social" | "wconnect";
      name: string;
    }
  | {
      s: "creating" | "ok";
      u: User;
    };
