import {
  Wormhole,
  routes,
  type Network,
} from "@wormhole-foundation/sdk-connect";

import "@wormhole-foundation/sdk-definitions-ntt";
import "@wormhole-foundation/sdk-evm-ntt";
import "@wormhole-foundation/sdk-solana-ntt";

import { EvmPlatform } from "@wormhole-foundation/sdk-evm";
import { SolanaPlatform } from "@wormhole-foundation/sdk-solana";
import {
  nttExecutorRoute,
  NttExecutorRoute,
} from "../src/executor/executor.js";

const SOL_TOKEN = "EetppHswYvV1jjRWoQKC1hejdeBDHR9NNzNtCyRQfrrQ";
const SEPOLIA_TOKEN = "0x738141EFf659625F2eAD4feECDfCD94155C67f18";

const nttConfig: NttExecutorRoute.Config["ntt"] = {
  tokens: {
    TestToken: [
      {
        chain: "Solana",
        token: SOL_TOKEN,
        manager: "NTtAaoDJhkeHeaVUHnyhwbPNAN6WgBpHkHBTc6d7vLK",
        transceiver: [
          {
            type: "wormhole",
            address: "ExVbjD8inGXkt7Cx8jVr4GF175sQy1MeqgfaY53Ah8as",
          },
        ],
        quoter: "Nqd6XqA8LbsCuG8MLWWuP865NV6jR1MbXeKxD4HLKDJ",
      },
      {
        chain: "Sepolia",
        token: SEPOLIA_TOKEN,
        manager: "0x649fF7B32C2DE771043ea105c4aAb2D724497238",
        transceiver: [
          {
            type: "wormhole",
            address: "0x06413c42e913327Bc9a08B7C1E362BAE7C0b9598",
          },
        ],
      },
    ],
  },
};

const wh = new Wormhole("Testnet", [SolanaPlatform, EvmPlatform]);

function createRoute(config: NttExecutorRoute.Config) {
  const Route = nttExecutorRoute(config);
  return new Route(wh);
}

describe("NttExecutorRoute referrer fee", () => {
  let request: routes.RouteTransferRequest<"Testnet">;

  beforeAll(async () => {
    request = await routes.RouteTransferRequest.create(wh, {
      source: Wormhole.tokenId("Solana", SOL_TOKEN),
      destination: Wormhole.tokenId("Sepolia", SEPOLIA_TOKEN),
    });
  });

  it("uses getReferrerFee callback when defined", async () => {
    const getReferrerFee = jest.fn(async () => ({
      feeDbps: 42n,
      referrerAddress: "0x9b2A3B92b1D86938D3Ed37B0519952C227bA6D09",
    }));
    const route = createRoute({ ntt: nttConfig, getReferrerFee });

    const result = await route.validate(request, { amount: "1.0" });
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("unexpected");

    expect(getReferrerFee).toHaveBeenCalledWith({
      sourceChain: "Solana",
      sourceToken: SOL_TOKEN,
      destinationChain: "Sepolia",
      destinationToken: SEPOLIA_TOKEN,
    });
    const params = result.params as NttExecutorRoute.ValidatedParams;
    expect(params.normalizedParams.referrerFeeDbps).toBe(42n);
  });

  it("uses static referrerFee when getReferrerFee is not defined", async () => {
    const route = createRoute({
      ntt: nttConfig,
      referrerFee: { feeDbps: 100n },
    });

    const result = await route.validate(request, { amount: "1.0" });
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("unexpected");

    const params = result.params as NttExecutorRoute.ValidatedParams;
    expect(params.normalizedParams.referrerFeeDbps).toBe(100n);
  });

  it("getReferrerFee takes priority over static referrerFee", async () => {
    const route = createRoute({
      ntt: nttConfig,
      referrerFee: { feeDbps: 100n },
      getReferrerFee: async () => ({
        feeDbps: 77n,
        referrerAddress: "0x9b2A3B92b1D86938D3Ed37B0519952C227bA6D09",
      }),
    });

    const result = await route.validate(request, { amount: "1.0" });
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("unexpected");

    const params = result.params as NttExecutorRoute.ValidatedParams;
    expect(params.normalizedParams.referrerFeeDbps).toBe(77n);
  });

  it("defaults to 0 when neither is defined", async () => {
    const route = createRoute({ ntt: nttConfig });

    const result = await route.validate(request, { amount: "1.0" });
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("unexpected");

    const params = result.params as NttExecutorRoute.ValidatedParams;
    expect(params.normalizedParams.referrerFeeDbps).toBe(0n);
  });

  it("resolves per-token feeDbps override from static config", async () => {
    const route = createRoute({
      ntt: nttConfig,
      referrerFee: {
        feeDbps: 10n,
        perTokenOverrides: {
          Solana: {
            [SOL_TOKEN]: { referrerFeeDbps: 50n },
          },
        },
      },
    });

    const result = await route.validate(request, { amount: "1.0" });
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("unexpected");

    const params = result.params as NttExecutorRoute.ValidatedParams;
    expect(params.normalizedParams.referrerFeeDbps).toBe(50n);
  });
});
