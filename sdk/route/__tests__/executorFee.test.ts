import {
  Wormhole,
  routes,
  type Network,
} from "@wormhole-foundation/sdk-connect";

import { register as registerDefinitionsNtt } from "@wormhole-foundation/sdk-definitions-ntt";
import { register as registerEvmNtt } from "@wormhole-foundation/sdk-evm-ntt";
import { register as registerSolanaNtt } from "@wormhole-foundation/sdk-solana-ntt";

registerDefinitionsNtt();
registerEvmNtt();
registerSolanaNtt();

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

describe("NttExecutorRoute getFee", () => {
  let request: routes.RouteTransferRequest<"Testnet">;

  beforeAll(async () => {
    request = await routes.RouteTransferRequest.create(wh, {
      source: Wormhole.tokenId("Solana", SOL_TOKEN),
      destination: Wormhole.tokenId("Sepolia", SEPOLIA_TOKEN),
    });
  });

  it("uses getFee callback when defined", async () => {
    const getFee = jest.fn(async () => ({
      transferTokenFee: 1_000_000n,
      nativeTokenFee: 500_000n,
      referrerAddress: "0x9b2A3B92b1D86938D3Ed37B0519952C227bA6D09",
    }));
    const route = createRoute({ ntt: nttConfig, getFee });

    const result = await route.validate(request, { amount: "1.0" });
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("unexpected");

    expect(getFee).toHaveBeenCalledWith({
      amount: expect.any(BigInt),
      sourceChain: "Solana",
      sourceToken: SOL_TOKEN,
      destinationChain: "Sepolia",
      destinationToken: SEPOLIA_TOKEN,
    });

    const params = result.params as NttExecutorRoute.ValidatedParams;
    expect(params.normalizedParams.transferTokenFee).toBe(1_000_000n);
    expect(params.normalizedParams.nativeTokenFee).toBe(500_000n);
  });

  it("defaults to zero fees when getFee is not defined", async () => {
    const route = createRoute({ ntt: nttConfig });

    const result = await route.validate(request, { amount: "1.0" });
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("unexpected");

    const params = result.params as NttExecutorRoute.ValidatedParams;
    expect(params.normalizedParams.transferTokenFee).toBe(0n);
    expect(params.normalizedParams.nativeTokenFee).toBe(0n);
    expect(params.normalizedParams.referrerAddress).toBeUndefined();
  });

  it("sets referrer address from getFee result", async () => {
    const referrer = "9q2q3EtP1VNdyaxzju1CGfh3EDj7heGABgxAJNyQDXgT";
    const route = createRoute({
      ntt: nttConfig,
      getFee: async () => ({
        transferTokenFee: 0n,
        nativeTokenFee: 0n,
        referrerAddress: referrer,
      }),
    });

    const result = await route.validate(request, { amount: "1.0" });
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("unexpected");

    const params = result.params as NttExecutorRoute.ValidatedParams;
    expect(params.normalizedParams.referrerAddress).toBeDefined();
    expect(params.normalizedParams.referrerAddress?.chain).toBe("Solana");
  });

  it("validates nativeGas option bounds", async () => {
    const route = createRoute({ ntt: nttConfig });

    const tooLow = await route.validate(request, {
      amount: "1.0",
      options: { nativeGas: -0.1 },
    });
    expect(tooLow.valid).toBe(false);

    const tooHigh = await route.validate(request, {
      amount: "1.0",
      options: { nativeGas: 1.1 },
    });
    expect(tooHigh.valid).toBe(false);

    const valid = await route.validate(request, {
      amount: "1.0",
      options: { nativeGas: 0.5 },
    });
    expect(valid.valid).toBe(true);
  });
});
