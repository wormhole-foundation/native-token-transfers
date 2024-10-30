import {
  canonicalAddress,
  isAttested,
  nativeTokenId,
  routes,
  wormhole,
} from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/evm";

// register protocol implementations
import "@wormhole-foundation/sdk-evm-ntt";

import {
  MultiTokenNttExecutorRoute,
  multiTokenNttExecutorRoute,
} from "@wormhole-foundation/sdk-route-ntt";
import { getSigner } from "./helpers.js";

const config: MultiTokenNttExecutorRoute.Config = {
  contracts: [
    {
      chain: "Sepolia",
      manager: "0x6c5aAE4622B835058A41879bA5e128019B9047d6",
      gmpManager: "0xDaeE3A6B4196E3e46015b364F1DAe54CEAE74A91",
    },
    {
      chain: "Monad",
      manager: "0x600D3C45Cd002E7359D12597Bb8058a0C32A20Df",
      gmpManager: "0x641a6608e2959c0D7Fe2a5F267DFDA519ED43d98",
    },
  ],
};

(async function () {
  const wh = await wormhole("Testnet", [evm]);

  const src = wh.getChain("Sepolia");
  const dst = wh.getChain("Monad");

  const srcSigner = await getSigner(src);
  const dstSigner = await getSigner(dst);

  const r = multiTokenNttExecutorRoute(config);

  const resolver = wh.resolver([r]);

  const sendToken = nativeTokenId(src.chain);

  // given the send token, what can we possibly get on the destination chain?
  const destTokens = await r.supportedDestinationTokens(sendToken, src, dst);
  console.log(
    "For the given source token and routes configured, the following tokens may be receivable: ",
    destTokens.map((t) => canonicalAddress(t))
  );
  //grab the first one for the example
  const destinationToken = destTokens[0]!;

  // creating a transfer request fetches token details
  // since all routes will need to know about the tokens
  const tr = await routes.RouteTransferRequest.create(wh, {
    source: sendToken,
    destination: destinationToken,
  });

  // resolve the transfer request to a set of routes that can perform it
  const foundRoutes = await resolver.findRoutes(tr);
  console.log(
    "For the transfer parameters, we found these routes: ",
    foundRoutes
  );

  // Taking the first route here, they'll be sorted by output amount
  // but you can chose any of them
  const bestRoute = foundRoutes[0]!;
  console.log("Selected: ", bestRoute);

  // Figure out what options are available
  const options = bestRoute.getDefaultOptions();
  console.log("This route offers the following default options", options);

  // Validate the transfer params passed
  // This fetches the next bits of data necessary and parses amounts or other values
  // it returns a new type: `ValidatedTransferParams`.
  // This is a validated version of the input params which must be passed to the next step
  const validated = await bestRoute.validate(tr, {
    amount: "0.00001",
    options,
  });
  if (!validated.valid) throw validated.error;
  console.log("Validated parameters: ", validated.params);

  // Fetch quote for the transfer
  // this, too, returns a new type that must be passed to the next step (if you like the quote)
  const quote = await bestRoute.quote(tr, validated.params);
  if (!quote.success) throw quote.error;
  console.log("Quote for transfer: ", quote);

  // Now the transfer may be initiated
  // A receipt will be returned, guess what you gotta do with that?
  let receipt = await bestRoute.initiate(
    tr,
    srcSigner.signer,
    quote,
    dstSigner.address
  );
  console.log("Initiated transfer with receipt: ", receipt);

  for await (receipt of bestRoute.track(receipt, 120 * 1000)) {
    if (routes.isManual(bestRoute) && isAttested(receipt)) {
      console.log("completing transfer");
      await bestRoute.complete(srcSigner.signer, receipt);
    }
    console.log("receipt state:", receipt.state);
  }
})();
