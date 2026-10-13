// Dev-only helpers for driving the live UI. Imported by step.mjs snippets as `h`.
export const text = async (page) =>
  (await page.locator("body").innerText()).replace(/\n\d(?=\n)/g, "");
export async function field(page, chip, label, value) {
  await page.locator("button.tk").nth(chip).click();
  const input = page.getByRole("textbox", { name: label });
  await input.fill(String(value));
  await input.press("Enter");
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}
/** Sets market, side, goal, target and stop through the normal sentence editors. */
export async function sentence(page, { market, side, goal, target, stop }) {
  const chips = () =>
    page
      .locator("button.tk")
      .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  let labels = await chips();
  if (
    market &&
    !labels[1].includes(market === "BTC" ? "Bitcoin" : "Ethereum")
  ) {
    await page.locator("button.tk").nth(1).click();
    await page
      .getByRole("option", {
        name: new RegExp(market === "BTC" ? "Bitcoin|BTC" : "Ethereum|ETH"),
      })
      .or(page.getByRole("menuitem", { name: new RegExp(market) }))
      .or(page.locator(".ep button", { hasText: market }))
      .first()
      .click();
    await page.waitForTimeout(600);
    await page.keyboard.press("Escape");
  }
  labels = await chips();
  if (side && !labels[2].startsWith(`Direction ${side}`)) {
    await page.locator("button.tk").nth(2).click();
    await page.waitForTimeout(600);
  }
  // Order matters: a new side needs target and stop on the right sides of the mark.
  if (goal !== undefined) await field(page, 0, "Profit goal", goal);
  if (target !== undefined) await field(page, 3, "Target price", target);
  if (stop !== undefined) await field(page, 4, "Stop price", stop);
  return chips();
}
/** Current mark in dollars from the public relay (native ticks are cents for ETH and BTC). */
export const mark = async (page, market = "ETH") => {
  const id = market === "BTC" ? 16 : 32;
  const response = await page.request.get(
    `http://localhost:3000/perpl-public/v1/market-data/${id}/ticker`,
  );
  // Native ticks: ETH $0.01, BTC $0.1.
  return (await response.json()).d[id].mrk / (id === 16 ? 10 : 100);
};
/** Re-authorizes the 24-hour API session after a reload (wallet signature only). */
export async function enroll(page) {
  const visible = (locator) => locator.isVisible().catch(() => false);
  const authorize = page.getByRole("button", {
    name: "Authorize 24-hour session in wallet",
  });
  const review = page.getByRole("button", {
    name: /^Review (API access|replacement session)$/,
  });
  if (!(await visible(authorize)) && !(await visible(review))) {
    const row = page.getByText("One-tap trading").first();
    if (!(await visible(row)))
      await page.getByRole("button", { name: "Account", exact: true }).click();
    await row.click();
  }
  if (!(await visible(authorize))) await review.click();
  await page
    .getByRole("button", { name: "Authorize 24-hour session in wallet" })
    .click();
  await page.getByRole("button", { name: "Sign and continue" }).click();
  await page
    .getByRole("button", { name: "Refresh authenticated account" })
    .waitFor({ timeout: 30000 });
  await page.waitForTimeout(6000);
  const alerts = await page.locator("[role=alert]").allInnerTexts();
  for (let i = 0; i < 2; i++)
    await page
      .getByRole("button", { name: "Close" })
      .last()
      .click()
      .catch(() => {});
  return alerts;
}
/** Collects relay response bodies (market and account data only; request bodies are never read). */
export function capture(
  page,
  routes = /perpl-account\/(position-history|order-history|fills|account-history|positions|orders)$/,
) {
  const seen = [];
  page.on("response", async (response) => {
    const match = new URL(response.url()).pathname.match(routes);
    if (!match || !response.ok()) return;
    try {
      seen.push({ route: match[1], body: await response.json() });
    } catch {
      /* ignore non-JSON */
    }
  });
  return seen;
}
/**
 * Runs one reviewed funding step in the open Add funds sheet: review, confirm, approve in
 * the Privy wallet dialog, then wait for the app to verify the finalized receipt.
 */
export async function openFunds(page) {
  const add = page.getByRole("button", { name: "Add funds" });
  if (
    !(await page
      .getByRole("button", { name: "Review deposit" })
      .isVisible()
      .catch(() => false))
  ) {
    if (!(await add.isVisible().catch(() => false)))
      await page.getByRole("button", { name: "Account", exact: true }).click();
    await add.click();
  }
  await page.waitForTimeout(800);
  return page
    .getByText("Monad testnet · test AUSD")
    .locator("xpath=ancestor::*[@role='dialog'][1]");
}
export async function fundingStep(page, reviewButton, amount) {
  const sheet = await openFunds(page);
  // A previous attempt must be verified before the app accepts another.
  const pending = sheet.getByRole("button", { name: "Check transaction" });
  if (await pending.isVisible().catch(() => false)) {
    // Empty means "use the recorded hash"; a stale typed hash would be rejected.
    await sheet.getByLabel("Recovery transaction hash").fill("");
    await pending.click();
    await page.waitForTimeout(7000);
  }
  if (amount !== undefined) {
    const input = sheet.getByLabel("Deposit amount");
    for (let i = 0; i < 10 && (await input.isDisabled()); i++)
      await page.waitForTimeout(1500);
    if ((await input.inputValue()) !== String(amount))
      await input.fill(String(amount));
  }
  await sheet.getByRole("button", { name: reviewButton }).click();
  const confirm = sheet.getByRole("button", { name: /^Confirm .* in wallet$/ });
  await confirm.waitFor({ timeout: 25000 });
  const plan = (await sheet.innerText()).replace(/\n/g, " ").slice(-260);
  await confirm.click();
  const approve = page
    .locator("#privy-modal-content button")
    .filter({ hasText: /^Approve$/ })
    .first();
  await approve.waitFor({ timeout: 25000 });
  await approve.click();
  // Privy shows its own result screen; the app verifies the receipt separately.
  let privy = "";
  for (
    let i = 0;
    i < 20 && !/0x[0-9a-f]{64}|failed|All done|success/i.test(privy);
    i++
  ) {
    await page.waitForTimeout(1500);
    privy = (await page.locator("#privy-modal-content").allInnerTexts())
      .join(" ")
      .replace(/\n/g, " ");
  }
  const hash = privy.match(/0x[0-9a-f]{64}/i)?.[0];
  const buttons = await page
    .locator("#privy-modal-content button")
    .allInnerTexts();
  const done = page
    .locator("#privy-modal-content button")
    .filter({ hasText: /^(All done|Close|Done|Continue)$/ })
    .first();
  if (await done.isVisible().catch(() => false)) await done.click();
  else
    await page
      .locator("#privy-modal-content button")
      .first()
      .click()
      .catch(() => {});
  await page.waitForTimeout(6000);
  const after = await openFunds(page);
  const check = after.getByRole("button", { name: "Check transaction" });
  if (await check.isVisible().catch(() => false)) {
    if (hash) await after.getByLabel("Recovery transaction hash").fill(hash);
    await check.click();
    await page.waitForTimeout(8000);
  }
  return {
    plan,
    privy: privy.slice(0, 160),
    buttons,
    hash,
    status: (await after.innerText()).replace(/\n/g, " ").slice(-220),
  };
}
// The profile can hold journals for several wallets; PERPL_E2E_OWNER picks one.
export const journal = (page, owner = process.env.PERPL_E2E_OWNER) =>
  page.evaluate((owner) => {
    const key = Object.keys(localStorage).find(
      (k) =>
        k.startsWith("perpl-orders-v1") &&
        (!owner || k.endsWith(owner.toLowerCase())),
    );
    return key ? JSON.parse(localStorage.getItem(key)) : null;
  }, owner);
const summary = (j) =>
  JSON.stringify({
    e: j?.operations.map((o) => [
      o.payload.mkt,
      o.payload.t,
      o.phase,
      o.filled,
      o.completion ? "done" : o.positionId ? "open" : "",
    ]),
    m: j?.management?.map((o) => [o.kind, o.phase]),
  });
/** Polls the journal and returns each distinct state it passed through. */
export async function watch(page, seconds = 36) {
  const log = [];
  for (let i = 0; i < seconds / 3; i++) {
    await page.waitForTimeout(3000);
    const line = summary(await journal(page));
    if (log.at(-1) !== line) log.push(line);
  }
  return log;
}
/** Sentence -> Review -> confirm. Returns the reviewed plan and the journal states. */
export async function open(page, intent, seconds = 36) {
  await sentence(page, intent);
  await page.getByRole("button", { name: /^Review/ }).click();
  const confirm = page.getByRole("button", { name: "Open position" });
  // A stale market read fails the review once in a while; refresh it like a user would.
  for (let i = 0; i < 3; i++) {
    try {
      await confirm.waitFor({ timeout: 12000 });
      break;
    } catch {
      await page
        .getByRole("button", { name: /Refresh account review|Prices moved/ })
        .first()
        .click()
        .catch(() => {});
    }
  }
  await confirm.waitFor({ timeout: 12000 });
  const plan = (await page.locator("[role=dialog]").first().innerText())
    .replace(/\n/g, " ")
    .slice(0, 330);
  await page
    .getByText("I understand I could lose up to my collateral.")
    .click();
  await confirm.click();
  return {
    plan,
    log: await watch(page, seconds),
    alerts: await page.locator("[role=alert]").allInnerTexts(),
  };
}
/** Opens the position for a market and closes 25, 50 or 100 percent through the Close sheet. */
export async function close(page, market, percent = 100, seconds = 36) {
  const card = page
    .locator("button")
    .filter({ hasText: new RegExp(`^${market}\\s*[↗↘]`) })
    .first();
  if (
    !(await page
      .getByRole("button", { name: "Close", exact: true })
      .isVisible()
      .catch(() => false))
  )
    await card.click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const sheet = page.locator("[role=dialog]").last();
  if (percent !== 100)
    await sheet
      .getByRole("button", { name: new RegExp(`^${percent}`) })
      .click();
  const confirm = sheet.getByRole("button", {
    name: new RegExp(`^Close [\\d.]+ ${market}$`),
  });
  await confirm.waitFor({ timeout: 25000 });
  await page.waitForTimeout(600);
  const plan = (await sheet.innerText()).replace(/\n/g, " ").slice(0, 420);
  await confirm.click();
  return {
    plan,
    log: await watch(page, seconds),
    alerts: await page.locator("[role=alert]").allInnerTexts(),
  };
}
/** Moves the take profit ("tp") or stop ("sl") of the open position shown on screen. */
export async function amend(page, which, price, seconds = 30) {
  const chip = page.locator(
    `button.tk[aria-label^="${which === "tp" ? "Take profit" : "Stop"}"]`,
  );
  await page.keyboard.press("Escape");
  await chip.first().click();
  let pop = page.locator("[role=dialog]").last();
  {
    await page.waitForTimeout(600);
    pop = page.locator("[role=dialog]").last();
  }
  await pop.getByLabel("Trigger price").fill(String(price));
  const review = pop.getByRole("button", { name: "Review change" });
  if (await review.isVisible().catch(() => false)) await review.click();
  const confirm = pop.getByRole("button", { name: /^Confirm/ });
  await confirm.waitFor({ timeout: 20000 });
  // A trigger that is already satisfied needs an explicit acknowledgment.
  const ack = page.getByText("May trigger immediately");
  if (await ack.isVisible().catch(() => false)) await ack.click();
  const plan = (await pop.innerText()).replace(/\n/g, " ").slice(0, 260);
  await confirm.click();
  const log = await watch(page, seconds);
  await page.keyboard.press("Escape");
  return {
    plan,
    log,
    alerts: await page.locator("[role=alert]").allInnerTexts(),
  };
}
/** One whole journey through the UI: open, close half, move target, move stop, close the rest. */
export async function journey(page, market, side, goal = 1) {
  const up = side === "long" ? 1 : -1;
  await page
    .getByRole("button", { name: "×" })
    .click()
    .catch(() => {});
  const back = page.getByText("Back to new trade");
  if (await back.isVisible().catch(() => false)) await back.click();
  const m = await mark(page, market);
  const out = { market, side, mark: m };
  const o = await open(
    page,
    {
      market,
      side,
      goal,
      target: Math.round(m * (1 + up * 0.05)),
      stop: Math.round(m * (1 - up * 0.035)),
    },
    45,
  );
  out.open = {
    plan: o.plan.slice(20, 190),
    last: o.log.at(-1),
    alerts: o.alerts,
  };
  const card = page
    .locator("button")
    .filter({ hasText: new RegExp(`^${market}\\s*[↗↘]`) });
  await card
    .first()
    .click()
    .catch(() => {});
  await page.waitForTimeout(1500);
  const partial = await close(page, market, 50, 30);
  out.partial = { plan: partial.plan.slice(60, 190), alerts: partial.alerts };
  const m2 = await mark(page, market);
  const tp = await amend(page, "tp", Math.round(m2 * (1 + up * 0.04)), 24);
  const sl = await amend(page, "sl", Math.round(m2 * (1 - up * 0.025)), 24);
  out.amend = { tp: tp.alerts, sl: sl.alerts };
  out.chips = await page
    .locator("button.tk")
    .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  const full = await close(page, market, 100, 40);
  out.close = { plan: full.plan.slice(30, 190), alerts: full.alerts };
  const j = await journal(page);
  const entry = j.operations.at(-1);
  out.entry = {
    t: entry.payload.t,
    rq: entry.payload.rq,
    lots: entry.filled,
    hash: entry.settlement?.hash,
    completion: entry.completion,
  };
  const first = j.management.findIndex((o) => o.payload.rq > entry.payload.rq);
  out.orders = j.management
    .slice(first)
    .map((o) => [
      o.kind,
      o.phase,
      o.payload.rq,
      o.payload.tp ?? o.payload.s,
      o.settlement?.hash ?? "",
    ]);
  out.screen = (await text(page)).slice(85, 230);
  return out;
}
/** Sets leverage with the bar's stepper buttons. */
export async function leverage(page, target = 3) {
  const read = async () =>
    Number((await text(page)).match(/(\d+(?:\.\d+)?)x\n/)?.[1] ?? NaN);
  for (let i = 0; i < 60; i++) {
    const now = await read();
    if (!Number.isFinite(now) || Math.abs(now - target) < 0.01) return now;
    await page
      .getByRole("button", {
        name: now < target ? "Raise leverage" : "Lower leverage",
      })
      .click();
    await page.waitForTimeout(120);
  }
  return read();
}
