import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createAccountRelay } from "./account-api.mjs";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicDataRelay } from "./public-data.mjs";

const root = await realpath(fileURLToPath(new URL("../dist", import.meta.url)));
const readPublic = createPublicDataRelay();
// One shared sampler keeps the live chart's recent marks for everyone; it never holds the
// process open and one slow response never queues another.
let sampling = false;
setInterval(async () => {
  if (sampling) return;
  sampling = true;
  try {
    await readPublic.sample();
  } finally {
    sampling = false;
  }
}, 2_000).unref();
const accountApi = createAccountRelay({
  // Render sets RENDER_EXTERNAL_URL to the service's own https origin; an explicit value wins
  // (for example a custom domain).
  appOrigin: process.env.PERPL_APP_ORIGIN || process.env.RENDER_EXTERNAL_URL,
});
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};
const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/perpl-account")) {
      const request = new Request(url, {
        method: req.method,
        headers: Object.fromEntries(
          Object.entries(req.headers).filter(
            ([, value]) => typeof value === "string",
          ),
        ),
        ...(!["GET", "HEAD"].includes(req.method ?? "GET")
          ? { body: Readable.toWeb(req), duplex: "half" }
          : {}),
      });
      const result = await accountApi(request);
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(Buffer.from(await result.arrayBuffer()));
      return;
    }
    if (url.pathname.startsWith("/perpl-public")) {
      const result = await readPublic(url.pathname + url.search, req.method);
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(Buffer.from(await result.arrayBuffer()));
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    // Serve only built files, never project sources, secrets or symlink escapes.
    const requested = resolve(
      root,
      pathname === "/" ? "index.html" : `.${pathname}`,
    );
    const file = await realpath(requested);
    if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const bytes = await readFile(file);
    res.setHeader(
      "Content-Type",
      mime[extname(file)] ?? "application/octet-stream",
    );
    res.setHeader(
      "Cache-Control",
      pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    );
    res.writeHead(200);
    res.end(req.method === "HEAD" ? undefined : bytes);
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "127.0.0.1";
server.listen(port, host, () =>
  console.log(
    `Built app with public Perpl testnet data: http://${host}:${port}`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close());
