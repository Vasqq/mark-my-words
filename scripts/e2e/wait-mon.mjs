// Dev-only: wait until an address holds testnet MON. Usage: node scripts/e2e/wait-mon.mjs <address>
import { createPublicClient, http, formatEther } from "viem";
const client = createPublicClient({
  transport: http("https://testnet-rpc.monad.xyz"),
});
for (let i = 0; i < 115; i++) {
  const balance = await client.getBalance({ address: process.argv[2] });
  if (balance > 0n) {
    console.log(`funded: ${formatEther(balance)} MON`);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
console.log("still 0 MON");
