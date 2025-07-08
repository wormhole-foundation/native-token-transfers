import {
  Wormhole,
  canonicalAddress,
  routes,
  wormhole,
} from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/evm";
import solana from "@wormhole-foundation/sdk/solana";

// register protocol implementations
import "@wormhole-foundation/sdk-evm-ntt";
import "@wormhole-foundation/sdk-solana-ntt";

import {
  nttAutomaticRoute,
  nttManualRoute,
} from "@wormhole-foundation/sdk-route-ntt";
import { NttTokens } from "./consts.js";
import { getSigner } from "./helpers.js";

// eslint-disable-next-line @typescript-eslint/no-floating-promises
(async function () {
  const wh = await wormhole("Testnet", [solana, evm]);

  const src = wh.getChain("Solana");
  const dst = wh.getChain("ArbitrumSepolia");

  const srcSigner = await getSigner(src);
  const dstSigner = await getSigner(dst);

  const resolver = wh.resolver([
    nttManualRoute({ tokens: NttTokens }),
    nttAutomaticRoute({ tokens: NttTokens }),
  ]);

  const sendToken = Wormhole.tokenId(src.chain, "native");

  // given the send token, what can we possibly get on the destination chain?
  const destTokens = await resolver.supportedDestinationTokens(
    sendToken,
    src,
    dst
  );
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
  const receipt = await bestRoute.initiate(
    tr,
    srcSigner.signer,
    quote,
    dstSigner.address
  );
  console.log("Initiated transfer with receipt: ", receipt);

  // Kick off a wait log and executor
  // If there is an opportunity to advance it to the next step, it will take it
  // ie complete or finalize
  // see the implementation for how this works
  await routes.checkAndCompleteTransfer(bestRoute, receipt, dstSigner.signer);
})();
