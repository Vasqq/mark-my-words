// Dev-only: script time the page spends per second of wall clock, over a quiet 10 s window.
import { chromium } from "@playwright/test";
const browser = await chromium.connectOverCDP(
  `http://127.0.0.1:${process.env.PERPL_E2E_PORT ?? 9334}`,
);
const page = browser
  .contexts()[0]
  .pages()
  .find((p) => p.url().startsWith("http://localhost:3000"));
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
const read = async () =>
  Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map((m) => [
      m.name,
      m.value,
    ]),
  );
const a = await read();
await page.waitForTimeout(10000);
const b = await read();
const per = (k) => (((b[k] - a[k]) / 10) * 1000).toFixed(0);
console.log(
  `script ${per("ScriptDuration")} ms/s, layout ${per("LayoutDuration")} ms/s, style ${per("RecalcStyleDuration")} ms/s, task ${per("TaskDuration")} ms/s`,
);
await browser.close();
