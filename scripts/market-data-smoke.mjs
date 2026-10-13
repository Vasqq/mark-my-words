import { chromium, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { verifyOrderRecovery } from "./order-recovery-scenario.mjs";

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1290, height: 736 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const panel = page.getByRole("dialog", { name: "Perpl market review" });
const row = (label) =>
  panel
    .locator(".data-row")
    .filter({
      has: page.locator("span", { hasText: new RegExp(`^${label}$`) }),
    })
    .locator("strong");
const storage = () =>
  page.evaluate(() => ({
    account: localStorage.getItem("metropolis-simulation-v1"),
    draft: (() => {
      const raw = localStorage.getItem("metropolis-draft");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return JSON.stringify(parsed, Object.keys(parsed).sort());
    })(),
  }));
const ready = () =>
  expect(panel.getByRole("status")).toHaveText("Current observation", {
    timeout: 35000,
  });
const observation = async () => ({
  market: await panel.getByLabel("Read-only market").inputValue(),
  transport: await row("Transport").innerText(),
  mark: await row("Mark price").innerText(),
  units: await row("Price tick / quantity lot").innerText(),
  book: await row("Book source").innerText(),
});
try {
  const base = new URL(
    process.env.BASE_URL ??
      process.env.PUBLIC_DATA_BASE_URL ??
      "http://127.0.0.1:4173/",
  );
  if (process.env.CONTROLLED_RESILIENCE === "1") {
    await verifyControlledJourney(page, context, base);
  } else {
    await page.goto(base.href);
    // Actual built testnet composer: no credentials, account fixtures or signed actions.
    await expect(page.locator(".market-mark")).toContainText("Perpl testnet", {
      timeout: 35000,
    });
    await expect(
      page.getByRole("button", { name: /Review trade/ }),
    ).toBeEnabled();
    if ((await storage()).account !== null)
      throw Error("Testnet composer instantiated a simulation account");
    const liveDraft = (await storage()).draft;
    const initialMark = await page.locator(".market-mark").innerText();
    let editingRequests = 0;
    const editingRequest = (request) => {
      if (new URL(request.url()).pathname.startsWith("/perpl-public/"))
        editingRequests++;
    };
    await page.getByRole("button", { name: /Gross profit goal/ }).click();
    const goal = page.getByRole("textbox", {
      name: "How much do you want to make?",
    });
    page.on("request", editingRequest);
    const editStarted = Date.now();
    await goal.fill("12.");
    await expect(goal).toHaveValue("12.");
    await page.waitForTimeout(5000); // Allow a real background refresh while the input stays focused.
    await expect(goal).toHaveValue("12.");
    await expect(goal).toBeFocused();
    page.off("request", editingRequest);
    const editElapsedMs = Date.now() - editStarted;
    await goal.press("Escape");
    await expect(
      page.getByRole("button", { name: /Gross profit goal/ }),
    ).toBeFocused();
    await expect.poll(async () => (await storage()).draft).toBe(liveDraft);
    await page.getByRole("button", { name: /Review trade/ }).click();
    await expect(
      page.getByRole("heading", { name: "Your trade plan" }),
    ).toBeFocused();
    await expect(page.getByRole("alert")).toContainText("restore Perpl access");
    await expect(
      page.getByRole("button", {
        name: "Order execution is not enabled",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(page.getByRole("checkbox")).toBeDisabled();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("button", { name: "ETH perpetual market" }).click();
    await page.getByRole("option", { name: /Bitcoin/ }).click();
    await expect(page.locator(".market-mark")).toContainText("BTC", {
      timeout: 35000,
    });
    await expect(page.locator(".market-mark")).toContainText("Perpl testnet", {
      timeout: 35000,
    });
    const btcDraft = (await storage()).draft;
    await page.reload();
    await expect(
      page.getByRole("button", { name: "BTC perpetual market" }),
    ).toBeVisible();
    await expect.poll(async () => (await storage()).draft).toBe(btcDraft);
    await context.route("**/perpl-public/**", (route) => route.abort());
    await page.getByRole("button", { name: "Perpl testnet data" }).click();
    await panel.getByRole("button", { name: "Retry public data" }).click();
    await expect(panel.getByRole("status")).toContainText("Stale observation");
    await panel.getByRole("button", { name: "Close dialog" }).click();
    await expect(
      page.getByRole("button", { name: /Review trade/ }),
    ).toBeDisabled();
    if ((await storage()).account !== null)
      throw Error("Testnet failure fell back to simulation");
    await context.unroute("**/perpl-public/**");
    await page.getByRole("button", { name: "Retry public data" }).click();
    await expect(page.locator(".market-mark")).toContainText("Perpl testnet", {
      timeout: 35000,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )
    )
      throw Error("Testnet composer overflows mobile viewport");
    await page.screenshot({
      path: "verification/testnet-iteration-1-composer.png",
    });
    await page.setViewportSize({ width: 1290, height: 736 });
    const liveJourney = {
      initialMark,
      editingRequests,
      editElapsedMs,
      rawAndFocusPreserved: true,
      noSimulator: true,
      reviewRequiresSession: true,
      reloadPreservesIntent: true,
      authenticatedReview: "pending owner-enabled session",
    };
    base.searchParams.set("mode", "simulation");
    await page.goto(base.href);
    await page.getByRole("button", { name: "BTC perpetual market" }).click();
    await page.getByRole("option", { name: /Ethereum/ }).click();
    await page.getByRole("button", { name: "ETH perpetual market" }).click();
    await page.getByRole("option", { name: /Bitcoin/ }).click();
    await expect
      .poll(async () => JSON.parse((await storage()).draft).market)
      .toBe("BTC");
    await expect
      .poll(async () => {
        const account = (await storage()).account;
        return account && JSON.parse(account).traces.at(-1)?.quantities.market;
      })
      .toBe("BTC");
    const before = await storage();
    await page.getByRole("button", { name: "Perpl testnet data" }).click();
    await ready();
    await expect(panel).toContainText("chain 10143");
    await expect(row("Price tick / quantity lot")).toHaveText(
      "$0.01 / 0.001 ETH",
    );
    const eth = await observation();
    await page.screenshot({
      path: "verification/testnet-iteration-1-perpl-live-review.png",
    });
    await panel.getByLabel("Read-only market").selectOption("BTC");
    await ready();
    await expect(row("Price tick / quantity lot")).toHaveText(
      "$0.10 / 0.00001 BTC",
    );
    const btc = await observation();
    await panel
      .locator("summary")
      .filter({ hasText: "Observed book depth" })
      .click();
    await page.screenshot({
      path: "verification/testnet-iteration-1-perpl-btc-review.png",
    });
    await expect(
      panel.getByRole("button", {
        name: "Open simulated position",
        exact: true,
      }),
    ).toHaveCount(0);

    await context.route("**/perpl-public/**", (route) => route.abort());
    await panel.getByRole("button", { name: "Retry public data" }).click();
    await expect(panel.getByRole("status")).toContainText("Stale observation");
    await expect(row("Last observed mark")).toHaveText(btc.mark);
    await page.screenshot({
      path: "verification/testnet-iteration-1-perpl-stale-review.png",
    });
    await context.unroute("**/perpl-public/**");
    await panel.getByRole("button", { name: "Retry public data" }).click();
    await ready();
    const recovered = await observation();
    const block = (text) => Number(text.split("block ")[1]);
    if (block(recovered.book) < block(btc.book))
      throw Error("Recovery regressed source block");
    await panel.getByRole("button", { name: "Close dialog" }).click();
    if (JSON.stringify(await storage()) !== JSON.stringify(before))
      throw Error("Public review changed simulation storage");

    // Observe real requests after the panel closes, without importing development modules.
    let closedRequests = 0;
    const onRequest = (request) => {
      if (new URL(request.url()).pathname.startsWith("/perpl-public/"))
        closedRequests++;
    };
    page.on("request", onRequest);
    await page.waitForTimeout(5000);
    page.off("request", onRequest);
    if (closedRequests) throw Error("Closed public review kept polling");
    await page.reload();
    if (JSON.stringify(await storage()) !== JSON.stringify(before))
      throw Error("Reload changed simulation storage");
    await page.getByRole("button", { name: "Perpl testnet data" }).click();
    await ready();
    await page.setViewportSize({ width: 390, height: 844 });
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )
    )
      throw Error("Public review overflows mobile viewport");
    await page.screenshot({
      path: "verification/testnet-iteration-1-perpl-live-mobile.png",
    });
    await panel.getByRole("button", { name: "Close dialog" }).click();
    if (errors.length) throw Error(errors.join("\n"));
    const result = {
      recoveryComponent: await verifyOrderRecovery(browser),
      checkedAt: new Date().toISOString(),
      baseUrl: page.url(),
      publicOnly: true,
      liveJourney,
      execution: "simulated separately",
      eth,
      btc,
      recovered,
      persistenceUnchanged: true,
      subscriptionsCleanedUp: true,
      errors,
    };
    await writeFile(
      "verification/testnet-iteration-1-perpl-market-data-result.json",
      JSON.stringify(result, null, 2),
    );
    console.log(
      "Built-app public market flow passed: ETH/BTC, interruption/recovery, isolation, cleanup and mobile.",
    );
  }
} finally {
  await context.close();
  await browser.close();
}

/** Served production app with bounded, repeatable public faults; never authenticated acceptance. */
async function verifyControlledJourney(page, context, base) {
  let fault = "none";
  let publicReads = 0;
  const mutations = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.method() !== "HEAD")
      mutations.push(new URL(request.url()).pathname);
  });
  await context.route("**/perpl-public/**", async (route) => {
    publicReads++;
    const path = new URL(route.request().url()).pathname;
    if (fault === "offline") return route.abort();
    if (fault === "rate-limit")
      return route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: "Controlled rate limit" }),
      });
    const at = { b: 100, t: Date.now() - (fault === "stale" ? 30000 : 0) };
    const market = (
      symbol,
      id,
      priceDecimals,
      sizeDecimals,
      mark,
      initial,
      maintenance,
    ) => ({
      symbol,
      id,
      perpetual_id: id,
      instance_id: 12,
      size_units: symbol,
      ver: 1,
      order_ttl_blocks: 20,
      funding_interval_blocks: 8571,
      funding_interval_sec: 2580,
      config: {
        at: { b: 100, t: Date.now() },
        is_open: fault !== "closed",
        price_decimals: priceDecimals,
        size_decimals: sizeDecimals,
        initial_margin: initial,
        maintenance_margin: maintenance,
        taker_fee: 345,
      },
      state: { at, mrk: mark, bid: mark - 1, ask: mark + 1 },
    });
    const markets = [
      market("ETH", 32, 2, 3, 250000, 1200, 2000),
      market("BTC", 16, 1, 5, 650000, 1500, 2500),
    ];
    let data;
    if (path.endsWith("/pub/context"))
      data = {
        chain: { chain_id: 10143 },
        instances: [
          {
            id: 12,
            address: "0x1964C32f0bE608E7D29302AFF5E61268E72080cc",
            collateral_token_id: 1,
          },
        ],
        tokens: [
          {
            id: 1,
            address: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC",
            symbol: "AUSD",
            decimals: 6,
          },
        ],
        markets,
      };
    else {
      const id = Number(path.split("/")[4]);
      const m = markets.find((m) => m.id === id);
      if (!m) throw Error("Unexpected fixture market");
      data = path.endsWith("/ticker")
        ? { mt: 9, sn: 100, d: { [id]: m.state } }
        : {
            mt: 15,
            sn: 100,
            at,
            bid: [{ p: m.state.bid, s: 1000000, o: 1 }],
            ask: [{ p: m.state.ask, s: 1000000, o: 1 }],
          };
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
  await page.goto(base.href);
  await expect(page.locator(".market-mark")).toContainText("Perpl testnet");
  const original = await storage();
  const goalButton = page.getByRole("button", { name: /Gross profit goal/ });
  await goalButton.focus();
  await goalButton.press("Enter");
  const goal = page.getByRole("textbox", {
    name: "How much do you want to make?",
  });
  await expect(goal).toBeFocused();
  const beforeEdit = publicReads;
  for (const value of ["1", "12", "12."]) await goal.fill(value);
  expect(publicReads - beforeEdit).toBeLessThanOrEqual(3);
  fault = "offline";
  await expect(page.locator(".market-mark")).toContainText("pending / stale", {
    timeout: 10000,
  });
  await expect(goal).toHaveValue("12.");
  await expect(goal).toBeFocused();
  await goal.press("Escape");
  await expect(goalButton).toBeFocused();
  await expect(
    page.getByRole("button", { name: /Review trade/ }),
  ).toBeDisabled();
  expect((await storage()).draft).toBe(original.draft);
  fault = "rate-limit";
  await page
    .getByRole("button", { name: "Retry public data", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "HTTP 429" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Review trade/ }),
  ).toBeDisabled();
  fault = "stale";
  await page
    .getByRole("button", { name: "Retry public data", exact: true })
    .click();
  await expect(page.locator(".market-mark")).toContainText("pending / stale");
  await expect(
    page.getByRole("button", { name: /Review trade/ }),
  ).toBeDisabled();
  await expect(
    page.getByRole("status").filter({ hasText: "Obsolete" }),
  ).toBeVisible();
  fault = "closed";
  await page
    .getByRole("button", { name: "Retry public data", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "closed on testnet" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Review trade/ }),
  ).toBeDisabled();
  fault = "none";
  await page
    .getByRole("button", { name: "Retry public data", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Review trade/ }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 320, height: 900 });
  await goalButton.focus();
  await goalButton.press("Enter");
  await expect(goal).toBeFocused();
  await goal.fill("15.");
  await expect(goal).toHaveValue("15.");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await goal.press("Escape");
  await expect(goalButton).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "";
  });
  await page.getByRole("button", { name: /Review trade/ }).click();
  await expect(
    page.getByRole("heading", { name: "Your trade plan" }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", {
      name: "Order execution is not enabled",
      exact: true,
    }),
  ).toBeDisabled();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("perpl-order-change")),
  );
  await expect(page.getByRole("alert")).toContainText(
    "Recorded account activity changed",
  );
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const second = await context.newPage();
  await second.goto(base.href);
  const draft = await second.evaluate(() =>
    JSON.parse(localStorage.getItem("metropolis-draft")),
  );
  await second.evaluate(
    (draft) =>
      localStorage.setItem(
        "metropolis-draft",
        JSON.stringify({
          ...draft,
          goal: "18000000",
          revision: draft.revision + 1,
        }),
      ),
    draft,
  );
  await goalButton.focus();
  await goalButton.press("Enter");
  await goal.fill("16.");
  await second.evaluate(
    (draft) =>
      localStorage.setItem(
        "metropolis-draft",
        JSON.stringify({
          ...draft,
          goal: "19000000",
          revision: draft.revision + 2,
        }),
      ),
    draft,
  );
  await expect(goal).toHaveValue("16.");
  await expect(goal).toBeFocused();
  await goal.press("Escape");
  await second.close();
  const final = await storage();
  expect(final.account).toBeNull();
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
  await writeFile(
    "verification/testnet-iteration-7-browser.json",
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        baseUrl: base.href,
        source:
          "actual served production app; controlled public fixtures/faults; no authentication",
        offlineRateLimitStaleClosedAndReconnect: true,
        rawDraftFocusKeyboardNarrowAndTwoTabs: true,
        cssZoom200PercentNoOverflow: true,
        orderActivityInvalidatesReview: true,
        publicReads,
        mutations,
        simulationAccount: final.account,
        errors,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Built-app controlled resilience, keyboard/narrow/zoom and two-tab draft flow passed.",
  );
}
