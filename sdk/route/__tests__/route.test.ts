import {
  Network,
  Wormhole,
  canonicalAddress,
  routes,
} from "@wormhole-foundation/sdk-connect";

import "@wormhole-foundation/sdk-definitions-ntt";
import "@wormhole-foundation/sdk-evm-ntt";
import "@wormhole-foundation/sdk-solana-ntt";

import { EvmPlatform } from "@wormhole-foundation/sdk-evm";
import { SolanaPlatform } from "@wormhole-foundation/sdk-solana";
import { nttAutomaticRoute, NttAutomaticRoute } from "../src/automatic.js";
import { nttManualRoute, NttManualRoute } from "../src/manual.js";
import { NttRoute } from "../src/types.js";

const SOL_TOKEN = "EetppHswYvV1jjRWoQKC1hejdeBDHR9NNzNtCyRQfrrQ";
const SEPOLIA_TOKEN = "0x738141EFf659625F2eAD4feECDfCD94155C67f18";

const conf: NttRoute.Config = {
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
const network: Network = "Testnet";

const dummyGetProtocol = async function (name: string, params: any) {
  if (name !== "Ntt") throw new Error("Unexpected protocol");
  return {
    getRateLimitDuration: async () => 0n,
    getCurrentInboundCapacity: async () => 0n,
  };
};

describe("Manual Route Tests", function () {
  const wh = new Wormhole("Testnet", [SolanaPlatform, EvmPlatform]);
  const fromChain = wh.getChain("Solana");
  const toChain = wh.getChain("Sepolia");

  let rt: typeof NttManualRoute;
  it("Should create a Route Constructor given ntt config", function () {
    rt = nttManualRoute(conf);
    expect(rt).toBeTruthy();
  });

  it("Should return supported chains", function () {
    const supportedChains = rt.supportedChains(network);
    expect(supportedChains).toEqual(["Solana", "Sepolia"]);
  });

  it("Should return supported tokens", async function () {
    const tokens = await rt.supportedSourceTokens(fromChain);
    expect(tokens).toHaveLength(1);
    expect(canonicalAddress(tokens[0]!)).toEqual(SOL_TOKEN);
  });

  it("Should correctly return corresponding destination token", async function () {
    const token = Wormhole.tokenId("Solana", SOL_TOKEN);
    const tokens = await rt.supportedDestinationTokens(
      token,
      fromChain,
      toChain
    );
    expect(tokens).toHaveLength(1);
    expect(canonicalAddress(tokens[0]!)).toEqual(SEPOLIA_TOKEN);
  });

  let resolver: routes.RouteResolver<Network>;
  it("Should satisfy resolver", async function () {
    resolver = new routes.RouteResolver(wh, [rt]);
  });

  let found: routes.ManualRoute<Network>;
  let request: routes.RouteTransferRequest<Network>;
  it("Should resolve a given route request", async function () {
    request = await routes.RouteTransferRequest.create(wh, {
      source: Wormhole.tokenId("Solana", SOL_TOKEN),
      destination: Wormhole.tokenId("Sepolia", SEPOLIA_TOKEN),
    });
    const foundRoutes = await resolver.findRoutes(request);
    expect(foundRoutes).toHaveLength(1);
    expect(request.fromChain.chain).toEqual("Solana");

    const rt = foundRoutes[0]!;
    if (!routes.isManual(rt)) throw new Error("Expected manual route");

    found = rt;
  });

  let op: ReturnType<typeof found.getDefaultOptions>;
  it("Should provide default options", async function () {
    op = found.getDefaultOptions();
    expect(op).toBeTruthy();
  });

  let vp: routes.ValidationResult<typeof op>;
  it("Should validate a transfer request", async function () {
    vp = await found.validate(request, { amount: "1.0", options: op });
    expect(vp.valid).toBeTruthy();
    expect(vp.params.amount).toEqual("1.0");
  });

  let qr: Awaited<ReturnType<typeof found.quote>>;
  it("Should fetch a quote given the validated parameters", async function () {
    if (!vp.valid) throw new Error("Invalid transfer params used");
    const getProtocol = request.toChain.getProtocol;
    // @ts-ignore
    // TODO: mock instead of monkey patch
    request.toChain.getProtocol = dummyGetProtocol;
    qr = await found.quote(request, vp.params);
    request.toChain.getProtocol = getProtocol;
    if (!qr.success) throw new Error("Failed to fetch quote");

    expect(qr.params.amount).toEqual("1.0");

    const srcAddy = canonicalAddress(qr.sourceToken.token);
    expect(srcAddy).toEqual(SOL_TOKEN);

    const dstAddy = canonicalAddress(qr.destinationToken.token);
    expect(dstAddy).toEqual(SEPOLIA_TOKEN);

    // No fees or other fields
    expect(Object.keys(qr)).toEqual([
      "success",
      "params",
      "sourceToken",
      "destinationToken",
      "eta",
    ]);
  });
});

describe("Automatic Route Tests", function () {
  const wh = new Wormhole("Testnet", [SolanaPlatform, EvmPlatform]);
  const fromChain = wh.getChain("Solana");
  const toChain = wh.getChain("Sepolia");

  let rt: typeof NttAutomaticRoute;
  it("Should create a Route Constructor given ntt config", function () {
    rt = nttAutomaticRoute(conf);
    expect(rt).toBeTruthy();
  });

  it("Should return supported chains", function () {
    const supportedChains = rt.supportedChains(network);
    expect(supportedChains).toEqual(["Solana", "Sepolia"]);
  });

  it("Should return supported tokens", async function () {
    const tokens = await rt.supportedSourceTokens(fromChain);
    expect(tokens).toHaveLength(1);
    expect(canonicalAddress(tokens[0]!)).toEqual(SOL_TOKEN);
  });

  it("Should correctly return corresponding destination token", async function () {
    const token = Wormhole.tokenId("Solana", SOL_TOKEN);
    const tokens = await rt.supportedDestinationTokens(
      token,
      fromChain,
      toChain
    );
    expect(tokens).toHaveLength(1);
    expect(canonicalAddress(tokens[0]!)).toEqual(SEPOLIA_TOKEN);
  });

  let resolver: routes.RouteResolver<Network>;
  it("Should satisfy resolver", async function () {
    resolver = new routes.RouteResolver(wh, [rt]);
  });

  let found: routes.AutomaticRoute<Network>;
  let request: routes.RouteTransferRequest<Network>;
  it("Should resolve a given route request", async function () {
    request = await routes.RouteTransferRequest.create(wh, {
      source: Wormhole.tokenId("Solana", SOL_TOKEN),
      destination: Wormhole.tokenId("Sepolia", SEPOLIA_TOKEN),
    });
    const foundRoutes = await resolver.findRoutes(request);
    expect(foundRoutes).toHaveLength(1);
    expect(request.fromChain.chain).toEqual("Solana");

    const rt = foundRoutes[0]!;
    if (!routes.isAutomatic(rt)) throw new Error("Expected automatic route");

    found = rt;
  });

  let op: ReturnType<typeof found.getDefaultOptions>;
  it("Should provide default options", async function () {
    op = found.getDefaultOptions();
    expect(op).toBeTruthy();
  });

  let vp: routes.ValidationResult<typeof op>;
  it("Should validate a transfer request", async function () {
    vp = await found.validate(request, { amount: "1.0", options: op });
    expect(vp.valid).toBeTruthy();
    expect(vp.params.amount).toEqual("1.0");
  });

  let qr: Awaited<ReturnType<typeof found.quote>>;
  it("Should fetch a quote given the validated parameters", async function () {
    if (!vp.valid) throw new Error("Invalid transfer params used");
    const getProtocol = request.toChain.getProtocol;
    // @ts-ignore
    // TODO: mock instead of monkey patch
    request.toChain.getProtocol = dummyGetProtocol;
    qr = await found.quote(request, vp.params);
    request.toChain.getProtocol = getProtocol;
    if (!qr.success) throw new Error("Failed to fetch quote");

    expect(qr.params.amount).toEqual("1.0");

    const srcAddy = canonicalAddress(qr.sourceToken.token);
    expect(srcAddy).toEqual(SOL_TOKEN);

    const dstAddy = canonicalAddress(qr.destinationToken.token);
    expect(dstAddy).toEqual(SEPOLIA_TOKEN);

    // No fees or other fields
    expect(Object.keys(qr)).toEqual([
      "success",
      "params",
      "sourceToken",
      "destinationToken",
      "relayFee",
      "destinationNativeGas",
      "eta",
    ]);
  });
});
