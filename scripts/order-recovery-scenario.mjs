import { build } from "vite";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";

// Bundle the actual session/recovery components without Privy credentials or upstream access.
export async function verifyOrderRecovery(browser) {
  const owner = `0x${"1".repeat(40)}`;
  const other = `0x${"2".repeat(40)}`;
  const key = `perpl-orders-v1:10143:${owner}`;
  const entry = "\0order-recovery-scenario";
  const output = await build({
    configFile: false,
    logLevel: "silent",
    plugins: [
      {
        name: "recovery-scenario",
        resolveId: (id) => (id === entry ? entry : undefined),
        load: (id) =>
          id === entry
            ? `
        import React from ${JSON.stringify(resolve("node_modules/react/index.js"))};
        import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
        import {SessionAccess} from ${JSON.stringify(resolve("src/SessionAccess.tsx"))};
        import {TradingStateView} from ${JSON.stringify(resolve("src/TradingStateView.tsx"))};
        import {LivePositionManagement} from ${JSON.stringify(resolve("src/LivePositionManagement.tsx"))};
        const metadata = {symbol:"ETH",marketId:32,instanceId:12,configBlock:100,configTime:Date.now(),contextVersion:1,orderTtlBlocks:20,tick:10000n,lot:1000n,priceDecimals:2,sizeDecimals:3,open:true,baseTakerFeePpm:345n,initialMarginFactor:1200,maintenanceMarginFactor:2000,fundingIntervalBlocks:8571,fundingIntervalSeconds:2580};
        const btcMetadata = {...metadata,symbol:"BTC",marketId:16,tick:100000n,lot:10n,priceDecimals:1,sizeDecimals:5,initialMarginFactor:1500,maintenanceMarginFactor:2500,baseTakerFeePpm:550n};
        const btcPosition={id:77,market:btcMetadata,side:"Short",size:123n,entryPrice:650000n,entryResidueQ16:32000,collateral:5000000n,fees:11n};
        const managedState = {owner:${JSON.stringify(owner)},accountId:1057,balance:100000000n,free:100000000n,locked:0n,forwarding:true,frozen:false,feeTier:0,lastRequestId:19,markets:[metadata],restrictions:{halted:false,addressBlocked:false,whitelistEnabled:false,whitelisted:false,minimumInitialDeposit:100000000n},positions:[{id:99,market:metadata,side:"Long",size:10n,entryPrice:250000n,entryResidueQ16:0,collateral:10000000n,fees:9n}],orders:[{id:901,request:19,market:metadata,type:3,status:8,size:10n,filled:0n,price:298500n,flags:4,leverage:0,triggerCondition:3,triggerPrice:300000n,linkedPosition:99}],sources:[{name:"Wallet",block:100,time:Date.now()}],receivedAt:Date.now(),reconciled:true};
        let readMode="fresh",releaseRead;
        const freshState=()=>({...managedState,receivedAt:Date.now(),sources:[{name:"Wallet",block:100,time:Date.now()}]});
        const readState=async()=>{if(readMode==="failed")throw Error("Controlled snapshot unavailable");if(readMode==="pending")return new Promise(resolve=>{releaseRead=()=>resolve({...freshState(),positions:[{...managedState.positions[0],size:999n}]})});return freshState()};
        const testSession={identity:()=>({id:"22222222-2222-2222-2222-222222222222",expiresAt:Date.now()+3600000})};
        function Scenario() {
          const [owner,setOwner] = React.useState(${JSON.stringify(owner)});
          const [audit,setAudit]=React.useState(false);
          const [auditAccess,setAuditAccess]=React.useState(true);
          const [management,setManagement] = React.useState(false);
          const [snapshot,setSnapshot] = React.useState(managedState);
          return React.createElement(React.Fragment,null,
            React.createElement("button",{onClick:()=>setOwner(${JSON.stringify(other)})},"Select another wallet"),
            React.createElement("button",{onClick:()=>setOwner(${JSON.stringify(owner)})},"Restore wallet"),
            React.createElement("button",{onClick:()=>setManagement(true)},"Inspect observed exposure"),
            React.createElement("button",{onClick:()=>setSnapshot({...managedState,receivedAt:0,sources:[{name:"Wallet",block:100,time:0}]})},"Expire management snapshot"),
            React.createElement("button",{onClick:()=>setSnapshot({...managedState,receivedAt:Date.now(),sources:[{name:"Wallet",block:100,time:Date.now()}],markets:[metadata,btcMetadata],positions:[...managedState.positions,btcPosition]})},"Inspect concurrent BTC short"),
            React.createElement("button",{onClick:()=>setAudit(true)},"Inspect trading-state failures"),
            React.createElement("button",{onClick:()=>{readMode="failed"}},"Fail next snapshot"),
            React.createElement("button",{onClick:()=>{readMode="pending"}},"Delay next snapshot"),
            React.createElement("button",{onClick:()=>{readMode="fresh"}},"Restore snapshot reader"),
            React.createElement("button",{onClick:()=>releaseRead?.()},"Release old snapshot"),
            React.createElement("button",{onClick:()=>setAuditAccess(false)},"Lose snapshot session"),
            React.createElement("button",{onClick:()=>setAuditAccess(true)},"Restore snapshot session"),
            audit && React.createElement(TradingStateView,{owner,session:testSession,readState,available:auditAccess}),
            management && !audit && React.createElement(LivePositionManagement,{owner,state:snapshot,session:testSession,readRisk:async(state,id,options,marketId=32)=>{const p=state.positions.find(p=>p.id===id&&p.market.marketId===marketId);return {accountId:1057,positionId:id,marketId,side:p.side,block:100n,blockTime:Date.now(),size:p.size,entryPrice:p.entryPrice,entryResidueQ16:p.entryResidueQ16,collateral:p.collateral,premiumPnl:0n,mark:p.entryPrice,maintenanceFactor:BigInt(p.market.maintenanceMarginFactor),dynamicLeverage:BigInt(p.market.initialMarginFactor)}}}),
            React.createElement(SessionAccess,{key:owner,owner}));
        }
        createRoot(document.getElementById("root")).render(React.createElement(Scenario));
      `
            : undefined,
      },
    ],
    build: {
      write: false,
      rollupOptions: { input: entry, output: { inlineDynamicImports: true } },
    },
  });
  const script = output.output.find((item) => item.type === "chunk").code;
  const styles = await readFile(resolve("src/styles.css"), "utf8");
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", async (route) => {
    if (route.request().url() !== "https://order-recovery.test/") {
      requests.push(route.request().url());
      return route.abort();
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<meta charset="utf-8"><style>${styles}</style><main id="root" class="testnet-account"></main><script type="module">${script.replaceAll("</script", "<\\/script")}</script>`,
    });
  });
  const journal = {
    version: 1,
    owner,
    chainId: 10143,
    exchange: "0x1964C32f0bE608E7D29302AFF5E61268E72080cc",
    accountId: 1057,
    highWater: 18,
    lastProtocolId: 17,
    operations: [
      {
        id: "11111111-1111-1111-1111-111111111111",
        binding: "a".repeat(64),
        sessionId: "22222222-2222-2222-2222-222222222222",
        expiresAt: 1,
        protocolId: 17,
        payload: {
          rq: 18,
          acc: 1057,
          mkt: 32,
          t: 1,
          p: 250000,
          s: 20,
          lv: 300,
          fl: 4,
          mnp: 50,
          lb: 120,
        },
        phase: "prepared",
        filled: 0,
        protection: "not-applicable",
        history: "unresolved",
        settlement: null,
      },
    ],
  };
  const panel = page.getByRole("region", { name: "Recorded order recovery" });
  const saved = () => page.evaluate((key) => localStorage.getItem(key), key);
  async function reloadWith(value) {
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
      key,
      value,
    });
    await page.reload();
    await expect(panel).toBeVisible();
  }
  try {
    await page.goto("https://order-recovery.test/");
    await reloadWith(JSON.stringify(journal));
    await expect(
      panel.getByRole("button", { name: "Discard unsent order" }),
    ).toBeEnabled();
    await panel.getByRole("button", { name: "Discard unsent order" }).click();
    await expect(panel).toHaveCount(0);
    expect(JSON.parse(await saved()).operations[0].phase).toBe("discarded");
    await page.reload();
    await expect(panel).toHaveCount(0);
    for (const phase of ["submitting", "unknown"]) {
      journal.operations[0].phase = phase;
      const raw = JSON.stringify(journal);
      await reloadWith(raw);
      await expect(
        panel.getByText(/Restore Perpl session access/),
      ).toBeVisible();
      await expect(
        panel.getByRole("button", { name: "Check order history" }),
      ).toBeDisabled();
      await expect(
        panel.getByRole("button", { name: "Discard unsent order" }),
      ).toHaveCount(0);
      expect(await saved()).toBe(raw);
      await page.getByRole("button", { name: "Select another wallet" }).click();
      await expect(panel).toHaveCount(0);
      await page.getByRole("button", { name: "Restore wallet" }).click();
      await expect(panel).toBeVisible();
      expect(await saved()).toBe(raw);
    }
    journal.highWater = 19;
    journal.management = [
      {
        id: "33333333-3333-3333-3333-333333333333",
        binding: "b".repeat(64),
        sessionId: "22222222-2222-2222-2222-222222222222",
        expiresAt: 1,
        protocolId: 18,
        kind: "close",
        positionId: 99,
        payload: {
          rq: 19,
          acc: 1057,
          mkt: 32,
          t: 3,
          p: 240000,
          s: 10,
          lv: 0,
          fl: 4,
          mnp: 0,
          lb: 120,
        },
        phase: "prepared",
        filled: 0,
        settlement: null,
      },
    ];
    await reloadWith(JSON.stringify(journal));
    await panel.getByRole("button", { name: "Discard unsent order" }).click();
    await expect
      .poll(async () => JSON.parse(await saved()).management[0].phase)
      .toBe("discarded");
    await expect(panel.getByLabel("Recorded position actions")).toContainText(
      "close: discarded",
    );
    journal.management[0].phase = "unknown";
    await reloadWith(JSON.stringify(journal));
    await expect(panel.getByLabel("Recorded position actions")).toContainText(
      "close: unknown",
    );
    await expect(
      panel.getByRole("button", { name: "Check order history" }),
    ).toBeDisabled();
    await expect(
      panel.getByRole("button", { name: "Discard unsent order" }),
    ).toHaveCount(0);
    const blockedProtection = structuredClone(journal);
    blockedProtection.highWater = 20;
    const laterClose = blockedProtection.management[0];
    laterClose.payload.rq = 20;
    laterClose.protocolId = 19;
    blockedProtection.management.unshift({
      ...laterClose,
      id: "44444444-4444-4444-4444-444444444444",
      protocolId: 18,
      kind: "take-profit",
      payload: {
        ...laterClose.payload,
        rq: 19,
        p: 298500,
        tp: 300000,
        tpc: 3,
        lp: 99,
        lb: 0,
      },
    });
    blockedProtection.operations[0] = {
      ...blockedProtection.operations[0],
      phase: "partial-fill",
      filled: 10,
      protection: "pending",
      history: "settled",
      settlement: { hash: `0x${"ab".repeat(32)}`, block: 100, orderId: 900 },
    };
    const blockedRaw = JSON.stringify(blockedProtection);
    await reloadWith(blockedRaw);
    const selection = panel.getByRole("combobox", {
      name: "Recorded operation",
    });
    await expect(selection).toHaveValue(blockedProtection.management[0].id);
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(selection).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await selection.focus();
    await selection.press("ArrowDown");
    await expect(selection).toBeFocused();
    await page.setViewportSize({ width: 1290, height: 736 });
    await selection.selectOption(laterClose.id);
    await expect(selection).toHaveValue(laterClose.id);
    await expect(
      panel.getByRole("button", { name: "Check order history" }),
    ).toBeDisabled();
    await selection.selectOption(blockedProtection.operations[0].id);
    await expect(panel.getByRole("alert")).toContainText("A fill was verified");
    await expect(panel.getByLabel("Recorded position actions")).toContainText(
      "take-profit: unknown",
    );
    expect(await saved()).toBe(blockedRaw);
    await page.reload();
    await selection.selectOption(laterClose.id);
    await expect(selection).toHaveValue(laterClose.id);
    expect(await saved()).toBe(blockedRaw);
    journal.operations[0] = {
      ...journal.operations[0],
      phase: "partial-fill",
      filled: 10,
      protection: "pending",
      history: "settled",
      settlement: { hash: `0x${"ab".repeat(32)}`, block: 100, orderId: 900 },
      completion: {
        positionId: 99,
        hash: `0x${"cd".repeat(32)}`,
        block: 101,
        orderId: 902,
        balance: "100000000",
        locked: "0",
        pnl: "1000",
        funding: "-5",
        fees: "17",
      },
    };
    journal.management[0] = {
      ...journal.management[0],
      phase: "settled",
      filled: 10,
      settlement: { hash: `0x${"cd".repeat(32)}`, block: 101, orderId: 902 },
    };
    await reloadWith(JSON.stringify(journal));
    await expect(panel.getByLabel("Reconciled trade lifecycle")).toContainText(
      "Trade lifecycle reconciled at block 101",
    );
    await expect(panel.getByLabel("Reconciled trade lifecycle")).toContainText(
      "net 0.000978 AUSD",
    );
    await expect(panel.getByRole("button")).toHaveCount(0);
    await reloadWith("{}");
    await expect(panel.getByRole("alert")).toContainText(
      "Preserve this browser's data",
    );
    await expect(panel.getByRole("button")).toHaveCount(0);
    expect(await saved()).toBe("{}");
    await page
      .getByRole("button", { name: "Inspect observed exposure" })
      .click();
    const management = page.getByRole("region", {
      name: "Live position management",
    });
    await expect(management).toBeVisible();
    await expect(management.getByText(/Take profit: waiting/)).toBeVisible();
    await expect(management.getByText(/Stop loss: missing/)).toBeVisible();
    await management.getByLabel("Position 99 ETH price").fill("2400.00");
    await management
      .getByRole("button", { name: "Review position action" })
      .click();
    await expect(management.locator("pre")).toContainText('"s": 10');
    await expect(management.locator("pre")).toContainText('"t": 3');
    await expect(
      management.getByRole("button", {
        name: "Confirm reviewed position action",
      }),
    ).toBeDisabled();
    await management
      .getByLabel("Position 99 ETH action")
      .selectOption("partial-close");
    await management.getByLabel("Position 99 ETH partial amount").fill("0.006");
    await management
      .getByRole("button", { name: "Review position action" })
      .click();
    await expect(management.locator("pre")).toContainText('"s": 6');
    await expect(
      management.getByText(/Expected remaining if fully filled: 0.004 ETH/),
    ).toBeVisible();
    await expect(
      management.getByText(/actual remaining 0.01 ETH/),
    ).toBeVisible();
    await management.getByLabel("Position 99 ETH partial amount").fill("0.010");
    await management
      .getByRole("button", { name: "Review position action" })
      .click();
    await expect(management.getByRole("alert")).toContainText(
      "leave at least one native lot",
    );
    await management
      .getByLabel("Position 99 ETH action")
      .selectOption("amend-take-profit");
    await management.getByLabel("Position 99 ETH price").fill("3100.00");
    await management
      .getByRole("button", { name: "Review position action" })
      .click();
    await expect(management.locator("pre")).toContainText('"t": 7');
    await expect(management.locator("pre")).toContainText('"oid": 901');
    await expect(management.locator("pre")).toContainText('"tp": 310000');
    await expect(management.getByText(/observed trigger \$3000/)).toBeVisible();
    await expect(
      management.getByText(/previous observed exit remains displayed/),
    ).toBeVisible();
    await expect(
      management.getByRole("button", {
        name: "Confirm reviewed position action",
      }),
    ).toBeDisabled();
    await management.getByLabel("Position 99 ETH price").fill("2400.00");
    await management
      .getByRole("button", { name: "Review position action" })
      .click();
    const immediate = management.getByRole("checkbox", {
      name: /May trigger immediately/,
    });
    await expect(immediate).toBeVisible();
    await expect(immediate).not.toBeChecked();
    await immediate.check();
    await expect(immediate).toBeChecked();
    await management.getByLabel("Position 99 ETH price").fill("2401.00");
    await expect(immediate).toHaveCount(0);
    await management
      .getByRole("button", { name: "Review position action" })
      .click();
    await expect(immediate).not.toBeChecked();
    await management
      .getByLabel("Position 99 ETH action")
      .selectOption("stop-loss");
    await management.getByLabel("Position 99 ETH price").fill("0.01");
    await management
      .getByRole("button", { name: "Review position action" })
      .click();
    await expect(management.getByRole("alert")).toContainText(
      "1% mark-price buffer",
    );
    await management.getByLabel("Position 99 ETH price").fill("2600.00");
    await management
      .getByRole("button", { name: "Review position action" })
      .click();
    await expect(immediate).toBeVisible();
    await expect(management.locator("pre")).toContainText('"tp": 260000');
    await management
      .getByRole("button", { name: "Review cancellation 901 ETH" })
      .click();
    await expect(management.locator("pre")).toContainText('"tp": 300000');
    await expect(
      management.getByText(/Nothing replaces it automatically/),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Expire management snapshot" })
      .click();
    await expect(
      management.getByRole("button", { name: "Review position action" }),
    ).toBeDisabled();
    await expect(management.getByText(/Take profit: waiting/)).toBeVisible();
    await page
      .getByRole("button", { name: "Inspect concurrent BTC short" })
      .click();
    const btcForm = management
      .locator("form")
      .filter({ has: page.getByLabel("Position 77 BTC price") });
    await btcForm
      .getByLabel("Position 77 BTC action")
      .selectOption("partial-close");
    await btcForm.getByLabel("Position 77 BTC price").fill("65000.0");
    await btcForm.getByLabel("Position 77 BTC partial amount").fill("0.00023");
    await btcForm
      .getByRole("button", { name: "Review position action" })
      .click();
    await expect(management.locator("pre")).toContainText('"mkt": 16');
    await expect(management.locator("pre")).toContainText('"t": 4');
    await expect(management.locator("pre")).toContainText('"s": 23');
    await expect(
      management.getByText(/Expected remaining if fully filled: 0.001 BTC/),
    ).toBeVisible();
    await expect(
      management.getByText(/actual remaining 0.01 ETH/),
    ).toBeVisible();
    await btcForm.getByLabel("Position 77 BTC price").fill("65000.01");
    await btcForm
      .getByRole("button", { name: "Review position action" })
      .click();
    await expect(management.getByRole("alert")).toContainText(
      "at most 1 decimals",
    );
    await btcForm
      .getByLabel("Position 77 BTC action")
      .selectOption("take-profit");
    await btcForm.getByLabel("Position 77 BTC price").fill("62000.0");
    await btcForm
      .getByRole("button", { name: "Review position action" })
      .click();
    await expect(management.locator("pre")).toContainText('"tpc": 4');
    await expect(management.locator("pre")).toContainText('"p": 623100');
    await expect(management.getByText(/observed trigger \$3000/)).toBeVisible();
    await btcForm
      .getByLabel("Position 77 BTC action")
      .selectOption("stop-loss");
    await btcForm.getByLabel("Position 77 BTC price").fill("64000.0");
    await btcForm
      .getByRole("button", { name: "Review position action" })
      .click();
    await expect(management.locator("pre")).toContainText('"tpc": 3');
    await expect(
      management.getByRole("checkbox", { name: /May trigger immediately/ }),
    ).toBeVisible();
    const preserved = await saved();
    await page
      .getByRole("button", { name: "Inspect trading-state failures" })
      .click();
    const audit = page.getByRole("region", {
      name: "Live Perpl trading state",
    });
    await audit
      .getByRole("button", { name: "Refresh trading state", exact: true })
      .click();
    const auditManagement = audit.getByRole("region", {
      name: "Live position management",
    });
    const auditReview = auditManagement.getByRole("button", {
      name: "Review position action",
    });
    await expect(auditReview).toBeEnabled();
    await auditManagement.getByLabel("Position 99 ETH price").fill("2400.00");
    await auditReview.click();
    await expect(auditManagement.locator("pre")).toBeVisible();
    await page.getByRole("button", { name: "Delay next snapshot" }).click();
    await audit
      .getByRole("button", { name: "Refresh trading state", exact: true })
      .click();
    await expect(auditReview).toBeDisabled();
    await expect(auditManagement.locator("pre")).toHaveCount(0);
    await page.evaluate(() =>
      window.dispatchEvent(new Event("perpl-order-change")),
    );
    await expect(audit.getByRole("alert")).toContainText(
      "Account activity changed",
    );
    await page.getByRole("button", { name: "Restore snapshot reader" }).click();
    await audit
      .getByRole("button", { name: "Refresh trading state", exact: true })
      .click();
    await expect(auditReview).toBeEnabled();
    await page.getByRole("button", { name: "Release old snapshot" }).click();
    await expect(
      auditManagement.getByText(/actual remaining 0.01 ETH/),
    ).toBeVisible();
    await page.getByRole("button", { name: "Fail next snapshot" }).click();
    await audit
      .getByRole("button", { name: "Refresh trading state", exact: true })
      .click();
    await expect(audit.getByRole("alert")).toContainText(
      "Controlled snapshot unavailable",
    );
    await expect(auditReview).toBeDisabled();
    await expect(
      auditManagement.getByText(/actual remaining 0.01 ETH/),
    ).toBeVisible();
    await page.getByRole("button", { name: "Restore snapshot reader" }).click();
    await audit
      .getByRole("button", { name: "Refresh trading state", exact: true })
      .click();
    await page.evaluate(
      (owner) =>
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: `perpl-funding-v1:10143:${owner}`,
          }),
        ),
      owner,
    );
    await expect(auditReview).toBeDisabled();
    await expect(audit.getByRole("alert")).toContainText(
      "Account activity changed",
    );
    await page.getByRole("button", { name: "Lose snapshot session" }).click();
    await expect(
      auditManagement.getByText(/actual remaining 0.01 ETH/),
    ).toBeVisible();
    await expect(
      audit.getByRole("button", { name: "Refresh trading state", exact: true }),
    ).toBeDisabled();
    await expect(audit.getByRole("alert")).toContainText("Restore access");
    await page
      .getByRole("button", { name: "Restore snapshot session" })
      .click();
    await expect(auditReview).toBeDisabled();
    await audit
      .getByRole("button", { name: "Refresh trading state", exact: true })
      .click();
    await expect(auditReview).toBeEnabled();
    expect(await saved()).toBe(preserved);
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
    return {
      localDiscardWithoutSession: true,
      unknownPreserved: true,
      managementRecoveryWithoutSession: true,
      unknownProtectionDoesNotHideCloseOrLifecycleAfterReload: true,
      completedAccountingAfterReload: true,
      walletIsolation: true,
      corruptPreserved: true,
      upstreamRequests: 0,
      independentProtectionAndFullCloseReview: true,
      exactPartialCloseAndPreservedAmendmentReview: true,
      explicitCancellationReplacementGap: true,
      staleManagementRemainsVisible: true,
      unsafeStopRejectedAndProfitableStopReviewed: true,
      immediateTriggerAcknowledgmentClearedOnEdit: true,
      concurrentBtcShortUsesOwnPrecisionBuyCeilingAndTriggerSide: true,
      btcManagementPreservesEthExposureAndExit: true,
      pendingFailedAndCrossTabReadsDisableReviewsButPreserveExposure: true,
      supersededSnapshotCannotOverrideSuccessfulRecovery: true,
      sessionLossRetainsObservedExposureAndRequiresNewSnapshot: true,
    };
  } finally {
    await context.close();
  }
}
