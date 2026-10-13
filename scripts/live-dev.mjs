// Local live loop: rebuilds the app on source changes and restarts the relay server on server changes.
import { spawn } from "node:child_process";

const env = {
  ...process.env,
  PORT: process.env.PORT ?? "3000",
  HOST: process.env.HOST ?? "127.0.0.1",
  PERPL_APP_ORIGIN: process.env.PERPL_APP_ORIGIN ?? "http://localhost:3000",
};
const run = (cmd, args) =>
  spawn(cmd, args, {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });

const build = run("npx", [
  "vite",
  "build",
  "--watch",
  "--emptyOutDir",
  "false",
]);
const server = run("node", ["--watch-path=server", "server/index.mjs"]);
const stop = () => {
  build.kill();
  server.kill();
  process.exit();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log(`Perpl live loop: http://localhost:${env.PORT}`);
