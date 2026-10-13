// Dev-only: wait until one of an account's positions ends on chain (trigger, liquidation
// or close). Usage: node scripts/e2e/watch-positions.mjs <accountId> [hours=10]
import { createPublicClient, http, parseAbi } from "viem";
const client = createPublicClient({
  transport: http("https://testnet-rpc.monad.xyz"),
});
const abi = parseAbi([
  "struct PositionInfoV2 { uint256 accountId; uint256 nextNodeId; uint256 prevNodeId; uint8 positionType; uint256 depositCNS; uint256 pricePNS; uint256 lotLNS; uint256 entryBlock; int256 pnlCNS; int256 deltaPnlCNS; int256 premiumPnlCNS; uint256 priceResiduePNSQ16; }",
  "function getPositionV2(uint256 perpId, uint256 accountId) view returns (PositionInfoV2 positionInfo, uint256 markPricePNS, bool markPriceValid)",
]);
const account = BigInt(process.argv[2]);
const until = Date.now() + Number(process.argv[3] ?? 10) * 3600_000;
const read = async (market) => {
  const [info, mark] = await client.readContract({
    address: "0x1964C32f0bE608E7D29302AFF5E61268E72080cc",
    abi,
    functionName: "getPositionV2",
    args: [BigInt(market), account],
  });
  return {
    lots: info.lotLNS,
    entry: info.pricePNS,
    mark,
    side: info.positionType,
  };
};
const open = {};
for (const market of [16, 32]) {
  const p = await read(market);
  if (p.lots > 0n) open[market] = p;
  console.log(
    `market ${market}: lots ${p.lots} entry ${p.entry} mark ${p.mark}`,
  );
}
let tick = 0;
while (Date.now() < until && Object.keys(open).length) {
  await new Promise((resolve) => setTimeout(resolve, 20000));
  for (const market of Object.keys(open)) {
    let p;
    try {
      p = await read(market);
    } catch {
      continue; // RPC hiccup: never treat a failed read as a closed position
    }
    if (p.lots === 0n) {
      console.log(
        `ENDED market ${market} at ${new Date().toISOString()}, last mark ${p.mark}`,
      );
      process.exit(0);
    }
    if (tick % 45 === 0)
      console.log(
        `${new Date().toISOString().slice(11, 16)} market ${market} mark ${p.mark} (entry ${open[market].entry})`,
      );
  }
  tick++;
}
console.log("no position ended in the watch window");
