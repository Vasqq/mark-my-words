import { useState } from "react";
import { formatUnits } from "viem";
import { Sheet } from "../../view/ReferenceView";
import type { createLiveController, LiveControllerState } from "./controller";
import { unresolved } from "../../../funding-application";
type Controller = ReturnType<typeof createLiveController>;
const labels = {
  approve: "approval",
  "reset-allowance": "allowance reset",
  deposit: "deposit",
  withdraw: "withdrawal",
  "create-account": "account creation and deposit",
  "claim-test-ausd": "test AUSD claim",
  "enable-forwarding": "order forwarding",
};
export function LiveControls({
  controller,
  state,
}: {
  controller: Controller;
  state: LiveControllerState;
}) {
  const [amount, setAmount] = useState("100");
  const [hash, setHash] = useState("");
  if (!state.control) return null;
  const close = () => controller.control();
  if (state.control === "manage")
    return (
      <Sheet title="Review linked-exit cancellation" onClose={close}>
        <p className="ep-note">
          Cancel the observed linked exit. Cancellation can leave protection
          uncovered. A missing order or acknowledgment does not prove
          cancellation; replacement requires positive terminal evidence and a
          fresh review.
        </p>
        <p className="ep-note">
          {state.management?.admission.action.marketId === 16 ? "BTC" : "ETH"} ·{" "}
          {state.management?.admission.action.kind === "cancel"
            ? `Order ${state.management.admission.action.orderId}`
            : "Review unavailable"}
        </p>
        <button
          className="big red"
          aria-disabled={!state.management || state.busy}
          onClick={() => {
            if (state.management)
              void controller.confirmManagement(state.management.id);
          }}
        >
          Confirm reviewed cancellation
        </button>
        {state.error && (
          <p role="alert" className="ep-note">
            {state.error}
          </p>
        )}
      </Sheet>
    );
  return state.control === "enroll" ? (
    <Sheet title="One-tap trading" onClose={close}>
      <p className="ep-note">
        Authorize read and trade access for 24 hours. API keys cannot withdraw
        funds. Each trade still needs a fresh explicit review.
      </p>
      <div className="rows">
        <div className="r">
          <span className="k">Can use</span>
          <span className="v">Read · trade (scope 3)</span>
        </div>
        <div className="r">
          <span className="k">Lasts</span>
          <span className="v">24 hours</span>
        </div>
        <div className="r">
          <span className="k">Always asks you</span>
          <span className="v">Funding · withdrawals</span>
        </div>
      </div>
      {state.session.expiresAt && (
        <p className="ep-note">
          Expires {new Date(state.session.expiresAt).toLocaleString()}.
        </p>
      )}
      <p className="ep-note">
        The signing key is non-extractable and stays in this browser for this
        wallet, so a reload or logging back in keeps access. Discarding or
        replacing does not revoke the key on Perpl.{" "}
        <a
          href="https://testnet.perpl.xyz/apikeys"
          target="_blank"
          rel="noreferrer"
        >
          Manage revocation on Perpl
        </a>
        .
      </p>
      {state.session.state === "unavailable" && (
        <p role="status" className="ep-note">
          The earlier key may remain active until expiry. Review a replacement
          explicitly to restore this browser's access.
        </p>
      )}
      {state.session.state === "ready" ? (
        <button
          className="big"
          disabled={state.busy}
          onClick={() => void controller.enroll()}
        >
          Authorize 24-hour session in wallet
        </button>
      ) : state.session.state === "active" ? (
        <>
          <button
            className="big"
            disabled={state.busy}
            onClick={() => void controller.refresh()}
          >
            Refresh authenticated account
          </button>
          <button
            className="ghost"
            disabled={state.busy}
            onClick={() => controller.discardSession()}
          >
            Discard local access
          </button>
        </>
      ) : (
        <button
          className="big"
          disabled={state.busy || state.session.state === "blocked"}
          onClick={() => void controller.prepareSession()}
        >
          {state.session.state === "unavailable"
            ? "Review replacement session"
            : "Review API access"}
        </button>
      )}
      {state.error && (
        <p role="alert" className="ep-note">
          {state.error}
        </p>
      )}
    </Sheet>
  ) : (
    <Sheet
      title={
        state.funding?.review.steps[0].kind === "withdraw"
          ? "Withdraw"
          : "Add funds"
      }
      onClose={close}
    >
      <p className="ep-note">
        Monad testnet · test AUSD. Review each faucet, exact approval, deposit
        or forwarding step before confirming it in the owner wallet.
      </p>
      {state.funding?.review.steps[0].kind !== "withdraw" && (
        <label className="numin">
          <span>$</span>
          <input
            aria-label="Deposit amount"
            inputMode="decimal"
            value={amount}
            disabled={state.busy || unresolved(state.attempt ?? null)}
            onChange={(e) => {
              setAmount(e.target.value);
              controller.invalidate();
            }}
          />
        </label>
      )}
      <div className="acts">
        <button
          className="ghost solid"
          disabled={state.busy || unresolved(state.attempt ?? null)}
          onClick={() => void controller.fundingReview("deposit", amount)}
        >
          Review deposit
        </button>
        <button
          className="ghost"
          disabled={state.busy || unresolved(state.attempt ?? null)}
          onClick={() => void controller.fundingReview("faucet", amount)}
        >
          Review test funds
        </button>
        <button
          className="ghost"
          disabled={state.busy || unresolved(state.attempt ?? null)}
          onClick={() => void controller.fundingReview("forwarding", amount)}
        >
          Review order forwarding
        </button>
      </div>
      {state.funding && (
        <>
          <div className="rows">
            <div className="r">
              <span className="k">Next step</span>
              <span className="v">
                {labels[state.funding.review.steps[0].kind]}
              </span>
            </div>
            <div className="r">
              <span className="k">Exact amount</span>
              <span className="v">
                {formatUnits(state.funding.review.amount, 6)} test AUSD
              </span>
            </div>
            <div className="r">
              <span className="k">Estimated fee ceiling</span>
              <span className="v">
                {state.funding.review.nextStepEstimate
                  ? formatUnits(
                      state.funding.review.nextStepEstimate.feeCeiling,
                      18,
                    ) + " MON"
                  : "—"}
              </span>
            </div>
          </div>
          {state.funding.review.steps[0].kind === "enable-forwarding" && (
            <p className="ep-note">
              Persistent permission for the Perpl Exchange administrator to
              forward orders. API key expiry does not revoke this permission;
              this action places no order.
            </p>
          )}
          {state.funding.review.snapshot.walletMon === 0n && (
            <p className="ep-note">
              <a
                href="https://faucet.monad.xyz"
                target="_blank"
                rel="noreferrer"
              >
                Get test MON from the Monad faucet
              </a>
            </p>
          )}
          {state.funding.review.blockers.map((reason) => (
            <p key={reason} role="status" className="ep-note">
              {reason}
            </p>
          ))}
          <button
            className="big"
            disabled={
              state.busy ||
              Date.now() >= state.funding.review.expiresAt ||
              !!state.funding.review.blockers.length ||
              !state.funding.review.nextStepEstimate
            }
            onClick={() => void controller.confirmFunding(state.funding!.id)}
          >
            Confirm {labels[state.funding.review.steps[0].kind]} in wallet
          </button>
        </>
      )}
      {state.attempt && (
        <p role="status" className="ep-note">
          {labels[state.attempt.kind]} · {state.attempt.status}. A submitted
          request is not finality.
        </p>
      )}
      {unresolved(state.attempt ?? null) && (
        <>
          <label className="numin">
            <input
              aria-label="Recovery transaction hash"
              value={hash}
              onChange={(e) => setHash(e.target.value)}
            />
          </label>
          <button
            className="ghost"
            disabled={state.busy || (!hash.trim() && !state.attempt?.hash)}
            onClick={() => void controller.checkFunding(hash || undefined)}
          >
            Check transaction
          </button>
        </>
      )}
      {state.attempt && !unresolved(state.attempt) && (
        <button
          className="ghost"
          disabled={state.busy}
          onClick={() => void controller.checkFunding()}
        >
          Refresh finalized account
        </button>
      )}
      {state.error && (
        <p role="alert" className="ep-note">
          {state.error}
        </p>
      )}
    </Sheet>
  );
}
