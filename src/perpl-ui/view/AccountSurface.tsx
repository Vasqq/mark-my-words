import { formatUnits } from "viem";
import { useState } from "react";
import type { SignRequest } from "../engine/types";
import { useEngine } from "../engine/context";
import { fmtUsd, fmtP } from "./format";
import { Sheet, NumIn, Slider, Bolt, Odo } from "./ReferenceView";
type Gate = (req: SignRequest, need?: number) => Promise<boolean>;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);
export function AccountSurface({
  onClose,
  gate,
  openTap,
}: {
  onClose: () => void;
  gate: Gate;
  openTap: () => void;
}) {
  const engine = useEngine();
  const { px, markets: MK, accountTotals: totals } = engine;
  const history =
    engine.history.state === "observed" ? engine.history.value : [];
  const [tab, setTab] = useState("overview");
  const [amt, setAmt] = useState(250);
  const [rawAmount, setRawAmount] = useState("250");
  const [busy, setBusy] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState<string>();
  const equity = totals.value;
  const amountDisplay =
    engine.kind === "live"
      ? engine.accountAmount?.(rawAmount)
      : { coordinate: amt, label: fmtUsd(amt) };
  const visibleAmount = amountDisplay?.coordinate ?? NaN;
  const max = (tab === "deposit" ? totals.wallet : totals.free) ?? NaN;
  const u = px.user;
  if (!u) return null;
  const [cp, setCp] = useState(false);
  return (
    <Sheet title={"Account"} onClose={onClose} wide>
      <div className={"who"}>
        <span className={"av"} aria-hidden={"true"}>
          {(u.label || "?")[0].toUpperCase()}
        </span>
        <span>
          <b>{u.label}</b>
          <button
            className={"addr"}
            onClick={() => {
              try {
                navigator.clipboard.writeText(u.addr);
              } catch (e) {}
              setCp(true);
              setTimeout(() => setCp(false), 1200);
            }}
          >
            <span className={"mono"}>{short(u.addr)}</span>{" "}
            {cp ? "copied" : "copy"}
          </button>
          <small>
            {u.embedded ? "Privy wallet" : u.ext}
            {" \xB7 Monad"}
          </small>
        </span>
      </div>
      {u.embedded && (
        <button
          className={"taprow" + (px.tapOn() ? " on" : "")}
          onClick={async () => {
            if (engine.kind === "demo") openTap();
            else setUnavailableReason((await engine.command("enroll")).reason);
          }}
        >
          <span className={"bolt"}>{Bolt}</span>
          <span>
            <b>{"One-tap trading"}</b>
            <small>
              {engine.kind === "live"
                ? px.tapOn()
                  ? "On · 24 hours in this browser"
                  : "Off · turn on to trade without pop-ups"
                : px.tapOn()
                  ? "On · trades sign instantly"
                  : "Off · each trade asks to confirm"}
            </small>
          </span>
          <em>
            {engine.kind === "live"
              ? px.tapOn()
                ? "Manage"
                : "Turn on"
              : px.tapOn()
                ? "Manage"
                : "Turn on"}
          </em>
        </button>
      )}
      {engine.kind === "demo" && (
        <span className={"simtag"}>{"Simulation \xB7 no real funds"}</span>
      )}
      <div className={"kv"}>
        <div className={"wide"}>
          <small>{"Total value"}</small>
          <b>
            <Odo text={fmtUsd(equity)} />
          </b>
        </div>
        <div>
          <small>{"Free to trade"}</small>
          <b>
            <Odo text={fmtUsd(totals.free)} />
          </b>
        </div>
        <div>
          <small>{"In positions"}</small>
          <b>{fmtUsd(totals.locked)}</b>
        </div>
      </div>
      <div className={"segd"} role={"group"}>
        {[
          ["overview", "History"],
          ["withdraw", "Withdraw"],
        ].map(([k, l]) => (
          <button
            key={k}
            aria-pressed={tab === k}
            onClick={() => {
              setTab(k);
              setAmt(250);
              setRawAmount("250");
              engine.invalidateReviews?.();
            }}
          >
            {l}
          </button>
        ))}
      </div>
      {tab === "overview" ? (
        <div className={"hist"}>
          {engine.settledHistory?.map((entry) => (
            <div className="hrow" key={entry.id}>
              <span>
                <b>
                  {entry.market} {entry.side}
                </b>
                <small>Manual lifecycle reconciled · block {entry.block}</small>
              </span>
              <b className={entry.net >= 0 ? "g" : "r"}>
                {fmtUsd(entry.net, 2, true)}
              </b>
            </div>
          ))}
          {engine.history.state !== "observed" ? (
            <p className="ep-note">{engine.history.reason}</p>
          ) : history.length === 0 ? (
            <p className={"ep-note"}>
              {"Closed trades will show up here with what you made or lost."}
            </p>
          ) : (
            history.map((h, i) => (
              <div key={i} className={"hrow"}>
                <span>
                  <b>
                    {h.market} {h.side}
                  </b>
                  <small>
                    {
                      {
                        tp: "Take profit hit",
                        sl: "Stop hit",
                        liq: "Liquidated",
                        manual: "Closed",
                      }[h.reason]
                    }
                    {" \xB7 "}
                    {fmtP(h.E, MK[h.market])}
                    {" \u2192 "}
                    {fmtP(h.exit, MK[h.market])}
                  </small>
                </span>
                <b className={h.net >= 0 ? "g" : "r"}>
                  {fmtUsd(h.net, 2, true)}
                </b>
              </div>
            ))
          )}
        </div>
      ) : (
        <>
          <NumIn
            value={engine.kind === "live" ? visibleAmount : amt}
            rawValue={engine.kind === "live" ? rawAmount : undefined}
            onRawPreview={engine.kind === "live" ? setRawAmount : undefined}
            onRawCommit={engine.kind === "live" ? setRawAmount : undefined}
            label={"Amount"}
            focus={false}
            onPreview={setAmt}
            onCommit={setAmt}
          />
          <Slider
            value={clamp(
              Math.round(
                engine.kind === "live"
                  ? Number.isFinite(visibleAmount)
                    ? visibleAmount
                    : 1
                  : amt,
              ),
              1,
              Number.isFinite(max) ? Math.max(2, Math.floor(max)) : 2,
            )}
            min={1}
            max={Number.isFinite(max) ? Math.max(2, Math.floor(max)) : 2}
            disabled={
              engine.kind === "live" &&
              (!Number.isFinite(max) || !Number.isFinite(visibleAmount))
            }
            step={1}
            color={"var(--lav)"}
            label={"Amount"}
            valuetext={amountDisplay?.label ?? "—"}
            onChange={(value) => {
              setAmt(value);
              setRawAmount(String(value));
            }}
          />
          <p className={"ep-note"}>
            {tab === "deposit"
              ? ""
              : "You can withdraw anything that isn’t in a position."}
          </p>
          <button
            className={"big"}
            aria-disabled={
              busy ||
              (engine.kind === "live"
                ? !Number.isFinite(visibleAmount) || visibleAmount <= 0
                : amt <= 0 || amt > max)
            }
            onClick={async () => {
              if (engine.kind === "live") {
                setUnavailableReason(
                  (await engine.transferRawAccount?.(tab, rawAmount))?.reason,
                );
                return;
              }
              if (busy || amt <= 0 || amt > max) return;
              setBusy(true);
              const result = await engine.transferAccount(tab, amt, gate);
              setBusy(false);
              if (result.state === "accepted") setTab("overview");
              else if (result.reason) setUnavailableReason(result.reason);
            }}
          >
            {busy
              ? "Confirming…"
              : (tab === "deposit" ? "Deposit " : "Withdraw ") +
                (amountDisplay?.label ?? "—")}
          </button>
        </>
      )}
      {engine.kind === "live" && (
        <>
          <p className="ep-note" role="status">
            {unavailableReason ??
              (engine.account.state === "observed"
                ? engine.account.stale
                  ? "Account snapshot is stale. Refresh account."
                  : engine.account.value.exchangeAccount
                    ? engine.account.value.exchangeAccount.hasPosition
                      ? engine.positions.state === "observed" &&
                        !engine.positions.stale
                        ? "Signed positions and protective exits observed."
                        : "Exposure recorded · signed position details unavailable."
                      : "No open positions."
                    : "No Perpl account yet. Add funds to create one."
                : engine.account.reason)}
          </p>
          {engine.linkedExits?.map((exit) => (
            <p className="ep-note" key={`${exit.marketId}:${exit.id}`}>
              {exit.label}{" "}
              <button
                className="ghost"
                onClick={() =>
                  void engine.reviewCancel?.(exit.id, exit.marketId)
                }
              >
                Review cancellation
              </button>
            </p>
          ))}
          {engine.recovery?.map((op) => (
            <p className="ep-note" key={op.id}>
              {op.label} · {op.phase}{" "}
              <button
                className="ghost"
                onClick={() =>
                  op.phase === "prepared"
                    ? void engine.discardRecovery?.(op.id, op.management)
                    : void engine.command("manage")
                }
              >
                {op.phase === "prepared"
                  ? "Discard unsent review"
                  : "Check recorded activity"}
              </button>
            </p>
          ))}
          <details className="more">
            <summary>Details</summary>
            <div className="rows">
              {engine.account.state === "observed" && (
                <>
                  <div className="r">
                    <span className="k">Finalized block</span>
                    <span className="v">
                      {engine.account.value.block.toString()}
                    </span>
                  </div>
                  <div className="r">
                    <span className="k">Wallet MON</span>
                    <span className="v">
                      {formatUnits(engine.account.value.walletMon, 18)}
                    </span>
                  </div>
                  <div className="r">
                    <span className="k">Wallet test AUSD</span>
                    <span className="v">
                      {formatUnits(engine.account.value.walletAusd, 6)}
                    </span>
                  </div>
                  {!engine.account.value.exchangeAccount && (
                    <div className="r">
                      <span className="k">Minimum initial deposit</span>
                      <span className="v">
                        {formatUnits(
                          engine.account.value.funding.minimumInitialDeposit,
                          6,
                        )}{" "}
                        test AUSD
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
            {engine.exportAccountEvidence && (
              <button
                className="ghost"
                onClick={() => void engine.exportAccountEvidence?.()}
              >
                Download account evidence
              </button>
            )}
            {engine.copyAccountEvidence && (
              <button
                className="ghost"
                disabled={
                  engine.accountEvidenceStatus ===
                  "Reading fresh account evidence…"
                }
                onClick={() => void engine.copyAccountEvidence?.()}
              >
                Copy account evidence
              </button>
            )}
            {engine.accountEvidenceStatus && (
              <p className="ep-note" role="status">
                {engine.accountEvidenceStatus}
              </p>
            )}
            {engine.ownerRecoveryAvailable && (
              <button
                className="ghost"
                onClick={() => engine.reviewOwnerRecovery?.()}
              >
                Review owner-wallet recovery
              </button>
            )}
            <button className="ghost" onClick={engine.refreshAccount}>
              Refresh account
            </button>
          </details>
        </>
      )}
      <div className={"acts"}>
        <button
          className={"ghost solid"}
          onClick={() => {
            if (engine.kind === "demo") {
              onClose();
              void px.fund(0);
            } else
              void engine
                .command("fund")
                .then((result) => setUnavailableReason(result.reason));
          }}
        >
          {"Add funds"}
        </button>
        {u.embedded && (
          <button
            className={"ghost"}
            onClick={async () => {
              const result = await engine.exportWallet();
              if (result.reason) setUnavailableReason(result.reason);
            }}
          >
            {"Export wallet"}
          </button>
        )}
        <button
          className={"ghost"}
          onClick={() => {
            onClose();
            engine.logout();
          }}
        >
          {"Log out"}
        </button>
      </div>
    </Sheet>
  );
}
