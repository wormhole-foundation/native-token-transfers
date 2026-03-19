import {
  canonicalAddress,
  isSameToken,
  nativeTokenId,
  routes,
  TokenId,
  Wormhole,
  wormhole,
  ChainContext,
  Network,
} from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/evm";

// register protocol implementations
import "@wormhole-foundation/sdk-evm-ntt";

import { MultiTokenNttExecutorRoute } from "@wormhole-foundation/sdk-route-ntt";

// Monad Bridge mainnet contracts
const config: MultiTokenNttExecutorRoute.Config = {
  contracts: [
    {
      chain: "Ethereum",
      manager: "0x556790e948b9920A8868bCAFcC87D25e82e8a075",
      gmpManager: "0xc6793a32761a11e96c97A3D18fC6545ea931F0E9",
    },
    {
      chain: "Monad",
      manager: "0x36878C6FCa7e0E8a88F90dc410CfBBcA5B695C95",
      gmpManager: "0x92957b3D0CaB3eA7110fEd1ccc4eF564981a59Fc",
    },
  ],
};

// Token allowlist — only these tokens can be sent/received
const TOKEN_ALLOW_LIST: TokenId[] = [
  // Monad tokens
  Wormhole.tokenId("Monad", "native"), // MON
  Wormhole.tokenId("Monad", "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A"), // WMON
  Wormhole.tokenId("Monad", "0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242"), // WETH (NTT Token on Monad)
  // Ethereum tokens
  Wormhole.tokenId("Ethereum", "native"), // ETH
  Wormhole.tokenId("Ethereum", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"), // WETH
  Wormhole.tokenId("Ethereum", "0x6917037F8944201b2648198a89906Edf863B9517"), // WMON (NTT Token on Ethereum)
];

function isTokenAllowed(token: TokenId): boolean {
  return TOKEN_ALLOW_LIST.some((t) => isSameToken(t, token));
}

// Create the route with the allowlist applied
function monadBridgeExecutorRoute(
  config: MultiTokenNttExecutorRoute.Config
): routes.RouteConstructor {
  class MonadBridgeExecutorRoute<
    N extends Network,
  > extends MultiTokenNttExecutorRoute<N> {
    static meta = { name: "MonadBridgeExecutorRoute" };
    static override config = config;

    static override async supportedDestinationTokens<N extends Network>(
      sourceToken: TokenId,
      fromChain: ChainContext<N>,
      toChain: ChainContext<N>
    ): Promise<TokenId[]> {
      if (!isTokenAllowed(sourceToken)) return [];
      const tokens = await super.supportedDestinationTokens(
        sourceToken,
        fromChain,
        toChain
      );
      return tokens.filter((t) => isTokenAllowed(t));
    }
  }
  return MonadBridgeExecutorRoute;
}

(async function () {
  const wh = await wormhole("Mainnet", [evm]);

  const src = wh.getChain("Ethereum");
  const dst = wh.getChain("Monad");

  const r = monadBridgeExecutorRoute(config);

  const resolver = wh.resolver([r]);

  // Send native ETH from Ethereum to Monad
  const sendToken = nativeTokenId(src.chain);

  // What can we receive on Monad?
  const destTokens = await r.supportedDestinationTokens(sendToken, src, dst);
  console.log(
    "Receivable tokens on destination:",
    destTokens.map((t) => canonicalAddress(t))
  );
  const destinationToken = destTokens[0]!;

  // Create transfer request
  const tr = await routes.RouteTransferRequest.create(wh, {
    source: sendToken,
    destination: destinationToken,
  });

  // Find routes
  const foundRoutes = await resolver.findRoutes(tr);
  console.log("Found routes:", foundRoutes);

  const bestRoute = foundRoutes[0]!;
  const options = bestRoute.getDefaultOptions();
  console.log("Default options:", options);

  // Validate transfer params
  const validated = await bestRoute.validate(tr, {
    amount: "0.001",
    options,
  });
  if (!validated.valid) throw validated.error;
  console.log("Validated params:", validated.params);

  // Get a quote
  const quote = await bestRoute.quote(tr, validated.params);
  if (!quote.success) throw quote.error;
  console.log(
    "Quote:",
    JSON.stringify(
      quote,
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2
    )
  );
})();
