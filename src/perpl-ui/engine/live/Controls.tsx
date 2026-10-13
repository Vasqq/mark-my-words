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
// Plain status for a funding step. "unknown" still blocks a resend until it is checked.
const attemptNote = {
  requesting: (step: string) => `Confirm the ${step} in your wallet.`,
  pending: (step: string) =>
    `Waiting for Monad to confirm your ${step}. This usually takes a few seconds.`,
  unknown: (step: string) =>
    `We couldn't confirm your ${step} yet. Check the transaction before trying again.`,
  confirmed: (step: string) => `Your ${step} is confirmed.`,
  reverted: (step: string) =>
    `Your ${step} didn't go through. Nothing was moved.`,
  rejected: (step: string) => `You cancelled the ${step} in your wallet.`,
  replaced: (step: string) =>
    `Another transaction from this wallet replaced your ${step}. Review it again.`,
} as const;
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
  const account = state.account;
  // First-time setup, read from the latest finalized account: gas, then test AUSD, then the
  // deposit that creates the Perpl account, then forwarding. Unknown state shows no step.
  const minimum = account?.funding.minimumInitialDeposit ?? 0n;
  const setup = !account
    ? undefined
    : account.walletMon === 0n
      ? {
          step: "gas",
          title: "Step 1 of 4: get free test MON for gas",
          body: "Your new wallet starts empty. Copy its address, paste it into the Monad faucet, then come back here. It can take a minute to arrive.",
        }
      : !account.exchangeAccount && account.walletAusd < minimum
        ? {
            step: "faucet",
            title: "Step 2 of 4: claim test AUSD",
            body: "Press Review test funds, then confirm in your wallet. It's free test money for trading.",
          }
        : !account.exchangeAccount
          ? {
              step: "deposit",
              title: "Step 3 of 4: deposit to create your Perpl account",
              body: `Deposit at least ${formatUnits(minimum, 6)} test AUSD. Your wallet asks you to approve it, then to deposit.`,
            }
          : state.session.state !== "active" &&
              state.attempt?.kind === "enable-forwarding" &&
              state.attempt.status === "confirmed"
            ? {
                step: "ready",
                title: "You're set up",
                body: "Last thing: turn on one-tap trading, then write your sentence and press Review.",
              }
            : state.session.state !== "active"
              ? {
                  step: "forwarding",
                  title: "Step 4 of 4: allow order forwarding",
                  body: "Do this once if you haven't yet, then turn on one-tap trading in your account and you're ready to trade.",
                }
              : undefined;
  const next = setup?.step ?? "deposit";
  const close = () => controller.control();
  // Close on success so the sheet doesn't sit on a Refresh button that looks inert. Only
  // this sheet, and only if the session ended up active (a lapsed key needs the sheet).
  const closeIfActive = (ok: boolean | undefined) => {
    const now = controller.getSnapshot();
    if (ok && now.control === "enroll" && now.session.state === "active")
      close();
  };
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
        Trade without a wallet pop-up for the next 24 hours. This access can
        open and close trades but can never withdraw your funds, and you still
        review every trade before it's sent.
      </p>
      <div className="rows">
        <div className="r">
          <span className="k">Can use</span>
          <span className="v">View and trade</span>
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
        The access key stays locked in this browser, so reloading or logging
        back in keeps it on. Removing it here doesn't revoke it on Perpl.{" "}
        <a
          href="https://testnet.perpl.xyz/apikeys"
          target="_blank"
          rel="noreferrer"
        >
          Manage keys on Perpl
        </a>
        .
      </p>
      {state.session.state === "unavailable" && (
        <p role="status" className="ep-note">
          Your earlier access isn't available in this browser. Start a new
          24-hour session to trade again.
        </p>
      )}
      {state.session.state === "ready" ? (
        <button
          className="big"
          disabled={state.busy}
          onClick={async () => {
            closeIfActive(await controller.enroll());
          }}
        >
          Authorize 24-hour session in wallet
        </button>
      ) : state.session.state === "active" ? (
        <>
          <button
            className="big"
            disabled={state.busy}
            onClick={async () => {
              closeIfActive(await controller.refresh());
            }}
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
            ? "Review new session"
            : "Review one-tap access"}
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
      {state.funding?.review.steps[0].kind !== "withdraw" &&
        (setup ? (
          <div className="ep-note" role="status">
            <b>{setup.title}</b>
            <br />
            {setup.body}
            {setup.step === "ready" && (
              <>
                <br />
                <button
                  className="ghost solid"
                  onClick={() => controller.control("enroll")}
                >
                  Turn on one-tap trading
                </button>
              </>
            )}
            {setup.step === "gas" && account && (
              <>
                <br />
                <button
                  className="ghost"
                  onClick={() =>
                    void navigator.clipboard?.writeText(account.owner)
                  }
                >
                  Copy wallet address
                </button>{" "}
                <a
                  href="https://faucet.monad.xyz"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open the Monad faucet
                </a>
              </>
            )}
          </div>
        ) : (
          <p className="ep-note">
            Each step asks you to confirm in your wallet and uses a little test
            MON for gas.
          </p>
        ))}
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
          className={next === "deposit" ? "ghost solid" : "ghost"}
          disabled={state.busy || unresolved(state.attempt ?? null)}
          onClick={() => void controller.fundingReview("deposit", amount)}
        >
          Review deposit
        </button>
        <button
          className={next === "faucet" ? "ghost solid" : "ghost"}
          disabled={state.busy || unresolved(state.attempt ?? null)}
          onClick={() => void controller.fundingReview("faucet", amount)}
        >
          Review test funds
        </button>
        <button
          className={next === "forwarding" ? "ghost solid" : "ghost"}
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
            {state.funding.review.amount > 0n && (
              <div className="r">
                <span className="k">Amount</span>
                <span className="v">
                  {formatUnits(state.funding.review.amount, 6)} test AUSD
                </span>
              </div>
            )}
            <div className="r">
              <span className="k">Max gas fee</span>
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
              Lets Perpl send the trades you approve to the exchange for you. It
              stays on after your 24-hour session ends, and it places no order
              by itself.
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
          {attemptNote[state.attempt.status](labels[state.attempt.kind])}
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
