// Dev-only: headed Chrome with a persistent profile so the Privy login survives. Step scripts attach over CDP.
import { chromium } from "@playwright/test";
import { homedir } from "node:os";
const context = await chromium.launchPersistentContext(
  process.env.PERPL_E2E_PROFILE ?? `${homedir()}/.perpl-e2e-profile`,
  {
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: false,
    viewport: null,
    args: [
      `--remote-debugging-port=${process.env.PERPL_E2E_PORT ?? 9333}`,
      "--window-size=1440,900",
    ],
  },
);
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(process.env.BASE_URL ?? "http://localhost:3000/");
console.log("browser ready");
await new Promise((resolve) => context.on("close", resolve));
