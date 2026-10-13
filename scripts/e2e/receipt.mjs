// Dev-only: decode a testnet order transaction for the outcomes table. Usage: node scripts/e2e/receipt.mjs <hash> [accountId]
import { createPublicClient, http, parseAbi, decodeEventLog } from "viem";
const abi = parseAbi([
  "event OrderRequestV2(uint256 perpId,uint256 accountId,uint256 orderDescId,uint256 orderId,uint8 orderType,uint256 pricePNS,uint256 lotLNS,uint256 expiryBlock,bool postOnly,bool fillOrKill,bool immediateOrCancel,uint256 maxMatches,uint256 leverageHdths,uint256 lastExecutionBlock,uint256 amountCNS,uint256 maxNegPnlCollatBPS,uint256 gasLeft,bytes extension)",
  "event TakerOrderFilledV2(uint256 entryPricePNS,uint256 collatPricePNS,uint256 pnlPricePNS,uint256 lotLNS,uint256 feeCNS,int256 amountCNS,uint256 balanceCNS,uint256 builderId,uint256 builderFeeCNS)",
  "event PositionClosed(uint256 perpId,uint256 accountId,uint8 positionType,uint256 pricePNS,int256 deltaPnlCNS,int256 fundingCNS)",
  "event PositionDecreased(uint256 perpId,uint256 accountId,uint8 positionType,uint256 startDepositCNS,uint256 endDepositCNS,uint256 startLotLNS,uint256 endLotLNS,int256 deltaPnlCNS,int256 fundingCNS)",
]);
const client = createPublicClient({
  transport: http("https://testnet-rpc.monad.xyz"),
});
const [hash, account] = process.argv.slice(2);
const receipt = await client.getTransactionReceipt({ hash });
let mine = false;
for (const log of receipt.logs) {
  let event;
  try {
    event = decodeEventLog({ abi, data: log.data, topics: log.topics });
  } catch {
    continue;
  }
  if (event.eventName === "OrderRequestV2")
    mine = !account || event.args.accountId === BigInt(account);
  if (!mine) continue;
  const a = event.args;
  if (event.eventName === "OrderRequestV2")
    console.log(
      `request rq=${a.orderDescId} order=${a.orderId} type=${a.orderType} price=${a.pricePNS} lots=${a.lotLNS} lev=${a.leverageHdths}`,
    );
  if (event.eventName === "TakerOrderFilledV2")
    console.log(
      `fill lots=${a.lotLNS} entryPrice=${a.entryPricePNS} pnlPrice=${a.pnlPricePNS} feeCNS=${a.feeCNS} amountCNS=${a.amountCNS} balanceCNS=${a.balanceCNS}`,
    );
  if (event.eventName === "PositionClosed")
    console.log(
      `closed price=${a.pricePNS} pnlCNS=${a.deltaPnlCNS} fundingCNS=${a.fundingCNS}`,
    );
  if (event.eventName === "PositionDecreased")
    console.log(
      `decreased lots ${a.startLotLNS}->${a.endLotLNS} pnlCNS=${a.deltaPnlCNS} fundingCNS=${a.fundingCNS}`,
    );
}
console.log(`block=${receipt.blockNumber} status=${receipt.status}`);
