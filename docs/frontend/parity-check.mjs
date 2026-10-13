// Perpl UI parity check.
// Drives one scripted user journey through the UI using only accessible names, visible copy and four
// data-testids, then records what the user can read at each checkpoint. Run it against the reference
// design and against the app's demo mode; both must pass, and `compare` must report no copy drift.
//
//   node docs/frontend/parity-check.mjs run --target docs/frontend/reference/perpl-reference.html --out verification/parity/reference
//   node docs/frontend/parity-check.mjs run --target "http://127.0.0.1:4175/?mode=demo"          --out verification/parity/app
//   node docs/frontend/parity-check.mjs compare verification/parity/reference verification/parity/app
//
// CHROME_PATH selects the browser (same convention as scripts/smoke.mjs). No network, wallet or Perpl access is used.
import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

// Copy that must be visible at each checkpoint (exact substrings). The design is the source of truth.
const REQUIRED = {
  "01-browse": [
    "I want to make",
    "Log in",
    "Tap any word to change it. Amounts are before fees.",
    "Log in to view your active positions",
    "Live", "1H", "1D", "1W",
    "Collateral", "Leverage", "Review",
  ],
  "02-goal": ["How much do you want to make?", "type or drag", "collateral"],
  "03-target": ["now", "lowest", "you’d make, after fees", "highest"],
  "04-stop": [
    "Stop loss", "lowest safe stop", "you’d lose", "closest",
    "Closes at market when ETH hits this price. The fill can be a little lower.",
  ],
  "05-market": ["Choose a market", "ETH", "BTC"],
  "06-target-error": ["Pick a target above today’s price", "Switch to falls"],
  "07-review": [
    "Your trade plan", "You buy", "Collateral", "If ETH hits", "If stopped",
    "can be a bit worse in fast markets", "Liquidation", "below today’s price", "Details",
    "I understand I could lose up to my collateral.", "Log in and open", "Back to the chart",
  ],
  "08-review-details": ["Position size", "Worst entry price", "the order won’t fill beyond this", "Fee to open", "Funding"],
  "09-login": [
    "Log in or sign up", "To place trades on Perpl. Looking around never needs an account.",
    "Google", "X / Twitter", "Continue with a wallet", "Protected by",
  ],
  "10-fund": ["Add funds", "This trade needs", "Card or Apple Pay", "Transfer crypto", "Test funds", "Free, for trying Perpl", "Continue"],
  "11-sign": ["is asking you to confirm", "Open ETH long", "Size", "Take profit · stop", "Network", "Monad", "Network fee", "Approve", "Cancel"],
  "12-position": [
    "You’re", "goal. Take profit at", "stop at", "Tap a price or drag its line to change it.", "Back to new trade",
    "Position", "bought at", "leverage", "away", "If you close now", "after fees", "Close",
    "You’re in: long", "Take profit and stop are set.", "Demo",
  ],
  "13-collateral": ["Add collateral to ETH", "Collateral", "Liquidation", "Leverage", "Left to trade", "Add $"],
  "14-one-tap-banner": ["Trade without the pop-up for 24 hours?", "Only on Perpl, up to $1,000 per trade.", "Turn on"],
  "15-close": [
    "Close ETH long", "25%", "50%", "100%", "You get back about", "Profit or loss", "in fees",
    "Amount", "Exit price", "Your take profit and stop will be removed.",
  ],
  "16-result": ["Stop hit", "ETH long closed at", "after fees", "History"],
  "17-account": ["Account", "One-tap trading", "Total value", "Free to trade", "In positions", "History", "Withdraw", "Stop hit", "Add funds", "Export wallet", "Log out"],
  "18-night": [],
};

// Shown only on wide screens (the phone bar keeps Position, Collateral, Liquidation and Close).
const DESKTOP_ONLY = new Set(["If you close now", "after fees"]);

// Builder/trader shorthand that must never reach the user in the main flows.
const FORBIDDEN = [
  /\bbound\b/i, /reduce-only/i, /\bexposure\b/i, /\beffective\b/i, /reference mark/i, /\bbuffer\b/i,
  /%\/hr/i, /session key/i, /\bjudges\b/i, /onramp/i, /\bbudget\b/i, /\bgross\b/i, /\bstale\b/i,
  /\bisolated\b/i, /\bTP and SL\b/, /\bVWAP\b/i, /\bIOC\b/,
];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

// Visible text, skipping aria-hidden subtrees (rolling digit columns) and reading role="text" labels instead.
// Inline runs stay together ("Closes at market when ETH hits…"); block-level boxes are separated by " | ".
const readVisible = () => {
  let out = "";
  const BLOCK = /^(block|flex|grid|list-item|table|table-row|table-cell|flow-root)$/;
  const walk = (node) => {
    if (node.nodeType === 3) {
      out += node.textContent.replace(/\s+/g, " ");
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    if (el.getAttribute("aria-hidden") === "true") return;
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const block = BLOCK.test(cs.display);
    if (block) out += " | ";
    if (el.getAttribute("role") === "text" && el.getAttribute("aria-label")) out += el.getAttribute("aria-label");
    else for (const c of el.childNodes) walk(c);
    if (block) out += " | ";
  };
  walk(document.body);
  return out.split("|").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" | ");
};

async function journey(page, vp, record) {
  const btn = (name) => page.getByRole("button", { name });
  // Sentence words (the chart has its own target/stop handles with similar names).
  const word = (name) => page.getByTestId("sentence-area").getByRole("button", { name });
  const dialog = (name) => page.getByRole("dialog", { name });
  const closePopover = async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  };

  await page.waitForTimeout(1200);
  await record("01-browse");

  await word(/^Profit goal/).click();
  await page.waitForTimeout(300);
  await record("02-goal");
  await closePopover();

  await word(/^Target /).click();
  await page.waitForTimeout(300);
  await record("03-target");
  await closePopover();

  await word(/^Stop /).click();
  await page.waitForTimeout(300);
  await record("04-stop");
  await closePopover();

  await word(/^Market /).click();
  await page.waitForTimeout(300);
  await record("05-market");
  await closePopover();

  // An invalid target produces a plain-language error with a one-tap fix, then we restore the target.
  await word(/^Target /).click();
  await page.getByRole("textbox", { name: "Target price" }).fill("2000");
  await page.keyboard.press("Enter");
  await closePopover();
  await page.waitForTimeout(300);
  await record("06-target-error");
  await word(/^Target /).click();
  await page.getByRole("textbox", { name: "Target price" }).fill("3100");
  await page.keyboard.press("Enter");
  await closePopover();

  await btn(/^Review/).click();
  await page.waitForTimeout(400);
  await record("07-review");
  await page.getByText("Details", { exact: true }).click();
  await page.waitForTimeout(200);
  await record("08-review-details");

  await page.getByRole("checkbox", { name: /could lose up to my collateral/ }).check({ force: true });
  await btn(/^Log in and open$/).click();
  await dialog("Log in or sign up").waitFor();
  await record("09-login");

  await btn(/^Google$/).click();
  await dialog("Add funds").waitFor({ timeout: 15000 });
  await record("10-fund");
  await page.getByRole("radio", { name: /Test funds/ }).click();
  await btn(/^Continue$/).click();

  await dialog(/Open ETH long/).waitFor({ timeout: 15000 });
  await record("11-sign");
  await btn(/^Approve$/).click();
  await page.getByText("You’re in: long").waitFor({ timeout: 15000 });
  await page.waitForTimeout(300);
  await record("12-position");

  await btn(/^Add collateral$/).click();
  await page.waitForTimeout(300);
  await record("13-collateral");
  await btn(/^Add \$/).click();
  await dialog(/collateral/).waitFor({ timeout: 10000 });
  await btn(/^Approve$/).click();
  await page.getByText("Trade without the pop-up for 24 hours?").waitFor({ timeout: 10000 });
  await record("14-one-tap-banner");
  await btn("Not now").click();

  await btn(/^Close$/).last().click();
  await page.waitForTimeout(300);
  await record("15-close");
  await closePopover();

  const demo = btn(/^Demo/);
  if ((await demo.getAttribute("aria-expanded")) !== "true") await demo.click();
  await btn(/^Hit stop$/).click();
  await page.getByText("Stop hit", { exact: true }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(300);
  await record("16-result");

  await btn(/^History$/).click();
  await page.waitForTimeout(400);
  await record("17-account");
  await closePopover();

  await btn(/^Switch to night$/).click();
  await page.waitForTimeout(700);
  await record("18-night");
}

async function run() {
  const target = arg("--target");
  const outDir = arg("--out");
  if (!target || !outDir) throw new Error("Usage: run --target <file-or-url> --out <dir>");
  const url = /^https?:/.test(target) ? target : "file://" + path.resolve(target);
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH ?? (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined),
  });
  const report = { target, date: new Date().toISOString(), viewports: {}, failures: [] };
  try {
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: "light" });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const checkpoints = {};
      const layout = {};
      const record = async (name) => {
        const text = await page.evaluate(readVisible);
        checkpoints[name] = text;
        await page.screenshot({ path: path.join(outDir, `${vp.name}-${name}.png`) });
        layout[name] = await page.evaluate(() => {
          const r = (id) => {
            const el = document.querySelector(`[data-testid="${id}"]`);
            if (!el) return null;
            const b = el.getBoundingClientRect();
            return { top: Math.round(b.top), height: Math.round(b.height) };
          };
          return {
            chart: r("chart"),
            positions: r("positions-row"),
            sentence: r("sentence-area"),
            overflowX: document.documentElement.scrollWidth > innerWidth + 1,
            bodyBg: getComputedStyle(document.body).backgroundColor,
          };
        });
        for (const s of REQUIRED[name] ?? [])
          if (!(vp.name === "phone" && name === "12-position" && DESKTOP_ONLY.has(s)) && !text.includes(s)) report.failures.push(`${vp.name} ${name}: missing "${s}"`);
        for (const re of FORBIDDEN)
          if (re.test(text)) report.failures.push(`${vp.name} ${name}: forbidden wording ${re}`);
        if (layout[name].overflowX) report.failures.push(`${vp.name} ${name}: horizontal overflow`);
      };
      await page.goto(url);
      try {
        await journey(page, vp, record);
      } catch (e) {
        report.failures.push(`${vp.name}: journey stopped: ${e.message.split("\n")[0]}`);
        await page.screenshot({ path: path.join(outDir, `${vp.name}-FAILED.png`) });
      }
      // The chart must not move or resize between browsing, holding a position and seeing a result.
      const c = (n) => layout[n]?.chart;
      for (const n of ["12-position", "16-result"])
        if (c("01-browse") && c(n) && (Math.abs(c(n).top - c("01-browse").top) > 1 || Math.abs(c(n).height - c("01-browse").height) > 1))
          report.failures.push(`${vp.name}: chart moved/resized between 01-browse and ${n}`);
      for (const id of ["chart", "positions-row", "sentence-area"])
        if (!layout["01-browse"]?.[id === "positions-row" ? "positions" : id === "sentence-area" ? "sentence" : id])
          report.failures.push(`${vp.name}: data-testid="${id}" not found`);
      const lum = (rgb) => {
        const [r, g, b] = (rgb.match(/\d+/g) ?? [255, 255, 255]).map(Number);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      };
      if (layout["18-night"] && lum(layout["18-night"].bodyBg) > 0.2)
        report.failures.push(`${vp.name}: night mode background is not dark`);
      if (errors.length) report.failures.push(`${vp.name}: page errors: ${errors.join(" || ")}`);
      report.viewports[vp.name] = { checkpoints, layout, errors };
      await context.close();
    }
  } finally {
    await browser.close();
  }
  await writeFile(path.join(outDir, "parity.json"), JSON.stringify(report, null, 2));
  console.log(report.failures.length ? `FAIL (${report.failures.length})\n- ` + report.failures.join("\n- ") : "PASS: all checkpoints, copy, layout stability and night mode");
  process.exitCode = report.failures.length ? 1 : 0;
}

// Copy drift: compare each checkpoint's words with numbers masked (prices and P&L legitimately differ).
async function compare() {
  const [a, b] = process.argv.slice(3);
  const A = JSON.parse(await readFile(path.join(a, "parity.json"), "utf8"));
  const B = JSON.parse(await readFile(path.join(b, "parity.json"), "utf8"));
  const norm = (t) =>
    new Set(
      (t ?? "")
        .replace(/0x[0-9a-fA-F]+…[0-9a-fA-F]+/g, "0x…")
        .replace(/[−-]?\$?\d[\d,]*(\.\d+)?%?/g, "#")
        .split(" | ")
        .map((s) => s.trim())
        .filter((s) => s && !/^[#\s·.,+−-]*$/.test(s)),
    );
  let drift = 0;
  for (const vp of Object.keys(A.viewports)) {
    for (const cp of Object.keys(A.viewports[vp].checkpoints)) {
      const ra = norm(A.viewports[vp].checkpoints[cp]);
      const rb = norm(B.viewports[vp]?.checkpoints?.[cp]);
      const missing = [...ra].filter((s) => !rb.has(s));
      const extra = [...rb].filter((s) => !ra.has(s));
      if (missing.length || extra.length) {
        drift++;
        console.log(`\n${vp} ${cp}`);
        if (missing.length) console.log("  in reference only: " + missing.join(" ┃ "));
        if (extra.length) console.log("  in app only:       " + extra.join(" ┃ "));
      }
    }
  }
  console.log(drift ? `\n${drift} checkpoint(s) differ. Each difference must be fixed or listed as an approved live-mode exception.` : "No copy drift.");
  process.exitCode = drift ? 1 : 0;
}

const cmd = process.argv[2];
if (cmd === "run") await run();
else if (cmd === "compare") await compare();
else console.log("Usage: parity-check.mjs run --target <file-or-url> --out <dir> | compare <refDir> <appDir>");
