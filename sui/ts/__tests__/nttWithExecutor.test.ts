import { jest } from "@jest/globals";
import { SuiAddress } from "@wormhole-foundation/sdk-sui";
import {
  mockSuiClient,
  mockCoinMetadata,
  mockSuiObject,
  mockTransceiverInfo,
  TEST_ADDRESSES,
  TEST_CONTRACTS,
} from "./mocks.js";

// Mock SuiGraphQLClient (used by getCoinMetadataId). jest.mock does not hoist
// under native-ESM jest, so use unstable_mockModule + dynamic import.
const mockQuery = jest.fn<any>().mockResolvedValue({
  data: {
    objects: {
      nodes: [
        {
          address:
            "0x9876543210987654321098765432109876543210987654321098765432109876",
        },
      ],
    },
  },
});

jest.unstable_mockModule("@mysten/sui/graphql", () => ({
  SuiGraphQLClient: jest.fn().mockImplementation(() => ({
    query: mockQuery,
  })),
}));

const { SuiNttWithExecutor } = await import("../src/nttWithExecutor.js");
const { SuiNtt } = await import("../src/ntt.js");

describe("SuiNttWithExecutor", () => {
  let suiNttWithExecutor: InstanceType<
    typeof SuiNttWithExecutor<"Testnet", "Sui">
  >;
  let suiNtt: InstanceType<typeof SuiNtt<"Testnet", "Sui">>;
  let mockClient: jest.Mocked<any>;

  const mockQuote = {
    signedQuote: new Uint8Array([1, 2, 3, 4]),
    relayInstructions: new Uint8Array([5, 6, 7, 8]),
    estimatedCost: 1000000n, // 0.001 SUI
    payeeAddress: new Uint8Array(32).fill(0xaa),
    referrer: {
      chain: "Solana" as const,
      address: {
        toUint8Array: () => new Uint8Array(32).fill(0xbb),
      },
    } as any,
    transferTokenFee: 500000n,
    nativeTokenFee: 0n,
    remainingAmount: 999500000n, // 0.9995 SUI
    expires: new Date(Date.now() + 3600000), // 1 hour from now
    gasDropOff: 100000n, // 0.0001 SUI
  };

  beforeEach(() => {
    mockClient = mockSuiClient();

    suiNtt = new SuiNtt("Testnet", "Sui", mockClient, {
      ntt: TEST_CONTRACTS.ntt,
      coreBridge: TEST_CONTRACTS.coreBridge,
    });

    suiNttWithExecutor = new SuiNttWithExecutor("Testnet", "Sui", mockClient, {
      ntt: TEST_CONTRACTS.ntt,
      coreBridge: TEST_CONTRACTS.coreBridge,
    });

    // Setup common getObject mocks keyed by objectId.
    mockClient.getObject.mockImplementation((params: any) => {
      if (params.objectId === TEST_CONTRACTS.ntt.manager) {
        // getPackageId for manager state
        return Promise.resolve(
          mockSuiObject(
            "0x1234567890abcdef1234567890abcdef12345678901234567890abcdef123456::ntt::State<0x2::sui::SUI>",
            {
              transceivers: {
                id: "0xtransceiverregistryid567890abcdef1234567890abcdef1234567890abcd",
              },
            }
          )
        );
      } else if (
        params.objectId ===
        "0xtransceiverinfoobj90abcdef1234567890abcdef12345678901234567890"
      ) {
        // transceiver info from registry (getTransceivers)
        return Promise.resolve(
          mockSuiObject("0x123::transceiver_registry::Info", {
            value: {
              id: 0,
              state_object_id:
                "0xtransceiverstateid890abcdef1234567890abcdef12345678901234567890",
            },
          })
        );
      } else if (
        params.objectId ===
        "0xtransceiverstateid890abcdef1234567890abcdef12345678901234567890"
      ) {
        // getPackageId for transceiver state
        return Promise.resolve(
          mockSuiObject(
            "0xabcdef1234567890abcdef1234567890abcdef12345678901234567890abcdef::wormhole_transceiver::State",
            {}
          )
        );
      } else if (
        params.objectId ===
        "0x1234567890abcdef1234567890abcdef12345678901234567890abcdef123456"
      ) {
        // CurrentPackage object (getWormholePackageId)
        return Promise.resolve(
          mockSuiObject("CurrentPackage", {
            value: {
              package:
                "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
            },
          })
        );
      }
      // Fallback
      return Promise.resolve(mockTransceiverInfo());
    });

    mockClient.getCoinMetadata.mockResolvedValue(mockCoinMetadata());

    // Mock listCoins for transfer operations (gRPC-shaped, consumed by
    // SuiPlatform.getCoins, which reads `objects[].{type,objectId}`)
    mockClient.listCoins.mockResolvedValue({
      objects: [
        {
          type: "0x2::sui::SUI",
          objectId:
            "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        },
      ],
      cursor: null,
      hasNextPage: false,
    });

    // Mock listDynamicFields for both getTransceivers and getWormholePackageId
    mockClient.listDynamicFields
      .mockResolvedValueOnce({
        // For getTransceivers
        dynamicFields: [
          {
            name: { type: "0x123::transceiver_registry::Key" },
            fieldId:
              "0xtransceiverinfoobj90abcdef1234567890abcdef12345678901234567890",
          },
        ],
        hasNextPage: false,
        cursor: null,
      })
      .mockResolvedValue({
        // For getWormholePackageId
        dynamicFields: [
          {
            name: { type: "CurrentPackage" },
            fieldId:
              "0x1234567890abcdef1234567890abcdef12345678901234567890abcdef123456",
          },
        ],
        hasNextPage: false,
        cursor: null,
      });
  });

  describe("constructor", () => {
    it("should initialize with correct configuration", () => {
      expect(suiNttWithExecutor.network).toBe("Testnet");
      expect(suiNttWithExecutor.chain).toBe("Sui");
      expect(suiNttWithExecutor.provider).toBe(mockClient);
      expect(suiNttWithExecutor.contracts.ntt?.manager).toBe(
        TEST_CONTRACTS.ntt.manager
      );
    });
  });

  describe("transfer", () => {
    const transferAmount = 1000000000n; // 1 SUI
    const sender = new SuiAddress(TEST_ADDRESSES.USER);
    const destination = {
      chain: "Solana" as const,
      address: {
        toUint8Array: () => new Uint8Array(32).fill(1),
        toString: () => "11111111111111111111111111111112", // Valid base58 Solana address
      },
    } as any;

    it("should throw error for expired quote", async () => {
      const expiredQuote = {
        ...mockQuote,
        expires: new Date(Date.now() - 3600000), // 1 hour ago
      };

      const txGenerator = suiNttWithExecutor.transfer(
        sender as any,
        destination,
        transferAmount,
        expiredQuote,
        suiNtt
      );

      await expect(txGenerator.next()).rejects.toThrow("Quote has expired");
    });

    it("should throw error for non-Solana/EVM destination chains", async () => {
      const nearDestination = {
        chain: "Near" as const,
        address: {
          toUint8Array: () => new Uint8Array(32).fill(1),
        },
      } as any;

      const txGenerator = suiNttWithExecutor.transfer(
        sender as any,
        nearDestination,
        transferAmount,
        mockQuote,
        suiNtt
      );

      await expect(txGenerator.next()).rejects.toThrow(
        "Executor only supports Solana and EVM destination chains"
      );
    });

    it("should handle native SUI token splitting correctly", async () => {
      // Use native SUI token
      suiNtt = new SuiNtt("Testnet", "Sui", mockClient, {
        ntt: {
          ...TEST_CONTRACTS.ntt,
          token: "0x2::sui::SUI", // Native SUI
        },
        coreBridge: TEST_CONTRACTS.coreBridge,
      });

      // Mock getPeer to return null (no peer configured)
      jest
        .spyOn(suiNtt, "getPeer")
        .mockImplementation(() => Promise.resolve(null));

      const txGenerator = suiNttWithExecutor.transfer(
        sender as any,
        destination,
        transferAmount,
        mockQuote,
        suiNtt
      );

      const { value: tx } = await txGenerator.next();
      expect(tx).toBeDefined();

      // For native tokens, listCoins should not be called since we split from gas
      expect(mockClient.listCoins).not.toHaveBeenCalledWith(
        expect.objectContaining({
          coinType: "0x2::sui::SUI",
        })
      );
    });

    it("should handle non-native token splitting correctly", async () => {
      // Use a non-native token
      const nonNativeToken =
        "0x0000000000000000000000000000000000000000000000000000000000abc123::custom_token::TOKEN";
      suiNtt = new SuiNtt("Testnet", "Sui", mockClient, {
        ntt: {
          ...TEST_CONTRACTS.ntt,
          token: "0xabc123::custom_token::TOKEN",
        },
        coreBridge: TEST_CONTRACTS.coreBridge,
      });

      // Mock getPeer to return null (no peer configured)
      jest
        .spyOn(suiNtt, "getPeer")
        .mockImplementation(() => Promise.resolve(null));

      // Mock user's coins for the non-native token (gRPC listCoins shape)
      const mockCoins = [
        {
          objectId: "token1",
          type: nonNativeToken,
        },
        {
          objectId: "token2",
          type: nonNativeToken,
        },
      ];

      // Reset and configure mocks for non-native token
      mockClient.listCoins.mockResolvedValueOnce({
        objects: mockCoins,
        cursor: null,
        hasNextPage: false,
      });

      const txGenerator = suiNttWithExecutor.transfer(
        sender as any,
        destination,
        transferAmount,
        mockQuote,
        suiNtt
      );

      const { value: tx } = await txGenerator.next();
      expect(tx).toBeDefined();

      // For non-native tokens, listCoins should be called to fetch user's coins
      expect(mockClient.listCoins).toHaveBeenCalledWith({
        owner: expect.any(String),
        coinType: nonNativeToken,
        cursor: null,
      });
    });
  });

  describe("estimateMsgValueAndGasLimit", () => {
    it("should estimate costs for transfer", async () => {
      const estimate =
        await suiNttWithExecutor.estimateMsgValueAndGasLimit(undefined);

      expect(typeof estimate.gasLimit).toBe("bigint");
      expect(typeof estimate.msgValue).toBe("bigint");
      expect(estimate.gasLimit).toBeGreaterThan(0n);
    });
  });

  describe("isSupportedDestinationChain", () => {
    it("returns true for Solana and EVM platforms", () => {
      expect(suiNttWithExecutor.isSupportedDestinationChain("Solana")).toBe(
        true
      );
      expect(suiNttWithExecutor.isSupportedDestinationChain("Ethereum")).toBe(
        true
      );
      expect(suiNttWithExecutor.isSupportedDestinationChain("Arbitrum")).toBe(
        true
      );
    });

    it("returns false for unsupported platforms", () => {
      expect(suiNttWithExecutor.isSupportedDestinationChain("Sui")).toBe(false);
    });
  });
});
