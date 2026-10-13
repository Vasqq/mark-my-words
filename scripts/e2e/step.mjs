// Dev-only: run one snippet against the open browser. Usage: node scripts/e2e/step.mjs '<async js using page>' [screenshot name]
import { chromium } from "@playwright/test";
import * as h from "./lib.mjs";
const browser = await chromium.connectOverCDP(
  `http://127.0.0.1:${process.env.PERPL_E2E_PORT ?? 9333}`,
);
const context = browser.contexts()[0];
let page =
  context.pages().find((p) => p.url().startsWith("http://localhost:3000")) ??
  context.pages()[0];
if (!page) {
  // The window was closed; the profile still holds the login and the session.
  page = await context.newPage();
  await page.goto("http://localhost:3000/");
  await page.waitForTimeout(9000);
}
page.setDefaultTimeout(15000);
const [code, shot] = process.argv.slice(2);
try {
  const result = await new Function(
    "page",
    "context",
    "h",
    `return (async () => { ${code} })()`,
  )(page, context, h);
  if (result !== undefined)
    console.log(
      typeof result === "string" ? result : JSON.stringify(result, null, 1),
    );
} catch (error) {
  console.log("STEP ERROR:", error.message.split("\n").slice(0, 6).join("\n"));
}
if (shot) {
  await page.screenshot({ path: `verification/shots/${shot}.png` });
  console.log(`shot verification/shots/${shot}.png`);
}
await browser.close();
