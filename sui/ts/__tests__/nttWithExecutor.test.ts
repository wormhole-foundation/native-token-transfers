import { SuiNttWithExecutor } from "../src/nttWithExecutor.js";
import { SuiNtt } from "../src/ntt.js";
import {
  mockSuiClient,
  mockCoinMetadata,
  TEST_ADDRESSES,
  TEST_CONTRACTS,
} from "./mocks.js";

describe("SuiNttWithExecutor", () => {
  let suiNttWithExecutor: SuiNttWithExecutor<"Testnet", "Sui">;
  let suiNtt: SuiNtt<"Testnet", "Sui">;
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
    referrerFee: 500000n, // 0.0005 SUI
    remainingAmount: 999500000n, // 0.9995 SUI
    referrerFeeDbps: 5n, // 0.05%
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

    // Setup common mocks
    mockClient.getObject
      .mockResolvedValueOnce({
        // getPackageId for manager state
        data: {
          content: {
            dataType: "moveObject",
            type: "0x1234567890abcdef1234567890abcdef12345678901234567890abcdef123456::ntt::State",
            fields: {
              transceivers: {
                fields: {
                  id: {
                    id: "0xtransceiverregistryid567890abcdef1234567890abcdef1234567890abcd",
                  },
                },
              },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        // transceiver info from registry
        data: {
          content: {
            dataType: "moveObject",
            fields: {
              value: {
                fields: {
                  id: 0,
                  state_object_id:
                    "0xtransceiverstateid890abcdef1234567890abcdef12345678901234567890",
                },
              },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        // getPackageId for transceiver state
        data: {
          content: {
            dataType: "moveObject",
            type: "0xabcdef1234567890abcdef1234567890abcdef12345678901234567890abcdef::wormhole_transceiver::State",
            fields: {},
          },
        },
      })
      .mockResolvedValue(mockCoinMetadata()); // getCoinMetadata - use mockResolvedValue to reuse for multiple calls

    mockClient.getCoinMetadata.mockResolvedValue(mockCoinMetadata()); // Mock getCoinMetadata method

    // Mock getCoins for transfer operations
    mockClient.getCoins.mockResolvedValue({
      data: [
        {
          coinType: "0x2::sui::SUI",
          coinObjectId:
            "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
          balance: "1000000000", // 1 SUI
          lockedUntilEpoch: null,
          previousTransaction: "mockTxDigest",
        },
      ],
      nextCursor: null,
      hasNextPage: false,
    });

    // Mock getDynamicFields for both getWormholePackageId and getTransceivers
    mockClient.getDynamicFields
      .mockResolvedValueOnce({
        // For getTransceivers
        data: [
          {
            name: { type: "transceiver_registry::Key" },
            objectId:
              "0xtransceiverinfoobj90abcdef1234567890abcdef12345678901234567890",
          },
        ],
        hasNextPage: false,
        nextCursor: null,
      })
      .mockResolvedValue({
        // For getWormholePackageId
        data: [
          {
            name: { type: "CurrentPackage" },
            objectId:
              "0x1234567890abcdef1234567890abcdef12345678901234567890abcdef123456",
          },
        ],
        hasNextPage: false,
        nextCursor: null,
      });

    // Add additional mock for the CurrentPackage object that will be fetched by getObjectFields
    mockClient.getObject.mockResolvedValueOnce({
      // Mock the CurrentPackage object response
      data: {
        digest: "mockDigest",
        objectId:
          "0x1234567890abcdef1234567890abcdef12345678901234567890abcdef123456",
        version: "1",
        content: {
          dataType: "moveObject" as const,
          type: "CurrentPackage",
          hasPublicTransfer: false,
          fields: {
            value: {
              fields: {
                package:
                  "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
              },
            },
          },
        },
      },
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
    const sender = TEST_ADDRESSES.USER;
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
  });

  describe("estimateMsgValueAndGasLimit", () => {
    it("should estimate costs for transfer", async () => {
      const estimate = await suiNttWithExecutor.estimateMsgValueAndGasLimit(
        undefined
      );

      expect(typeof estimate.gasLimit).toBe("bigint");
      expect(typeof estimate.msgValue).toBe("bigint");
      expect(estimate.gasLimit).toBeGreaterThan(0n);
    });
  });

  describe("getSupportedDestinationChains", () => {
    it("should return supported Solana and EVM chains", async () => {
      const chains = await suiNttWithExecutor.getSupportedDestinationChains();

      expect(chains).toContain("Solana");
      expect(chains).toContain("Ethereum");
      expect(chains).toContain("Bsc");
      expect(chains).toContain("Polygon");
      expect(chains).toContain("Avalanche");
      expect(chains).toContain("Arbitrum");
      expect(chains).toContain("Optimism");
      expect(chains).toContain("Base");
      expect(chains).toHaveLength(8);
    });
  });

  describe("splitCoinsByType", () => {
    let mockTx: any;
    const sender = TEST_ADDRESSES.USER;

    beforeEach(() => {
      // Mock Transaction object
      mockTx = {
        gas: Symbol("gas"),
        pure: {
          u64: jest.fn((value) => `pure_u64_${value}`),
        },
        splitCoins: jest.fn((source, amounts) => [
          `split_result_${amounts[0]}`,
        ]),
        object: jest.fn((id) => `object_${id}`),
        mergeCoins: jest.fn(),
      };
    });

    it("should split from gas for native SUI token", async () => {
      const splitAmount = 1000000n;
      const isNative = true;
      const coinType = "0x2::sui::SUI";

      // Call the function te be tested
      const result = await suiNttWithExecutor.splitCoinsByType(
        mockTx,
        sender as any,
        coinType,
        isNative,
        splitAmount
      );

      // Verify it splits from gas
      expect(mockTx.pure.u64).toHaveBeenCalledWith(splitAmount);
      expect(mockTx.splitCoins).toHaveBeenCalledWith(mockTx.gas, [
        `pure_u64_${splitAmount}`,
      ]);
      expect(result).toEqual([`split_result_pure_u64_${splitAmount}`]);

      // Verify getCoins was NOT called for native
      expect(mockClient.getCoins).not.toHaveBeenCalled();
    });

    it("should split from user coins for non-native token", async () => {
      const splitAmount = 1000000n;
      const isNative = false;
      const coinType = "0xabc::token::TOKEN";

      // Mock user's coins
      const mockCoins = [
        {
          coinObjectId: "coin1",
          coinType: coinType,
          balance: "100000",
        },
        {
          coinObjectId: "coin2",
          coinType: coinType,
          balance: "200000",
        },
      ];

      // Mock getCoins to return user's coins
      mockClient.getCoins.mockResolvedValue({
        data: mockCoins,
        nextCursor: null,
        hasNextPage: false,
      });

      // Call the function te be tested
      const result = await suiNttWithExecutor.splitCoinsByType(
        mockTx,
        sender as any,
        coinType,
        isNative,
        splitAmount
      );

      // Verify it fetched user's coins
      expect(mockClient.getCoins).toHaveBeenCalledWith({
        owner: expect.any(String),
        coinType: coinType,
        cursor: null,
      });

      // Verify it merged coins
      expect(mockTx.object).toHaveBeenCalledWith("coin1");
      expect(mockTx.object).toHaveBeenCalledWith("coin2");
      expect(mockTx.mergeCoins).toHaveBeenCalledWith("object_coin1", [
        "object_coin2",
      ]);

      // Verify it split from the primary coin
      expect(mockTx.pure.u64).toHaveBeenCalledWith(splitAmount);
      expect(mockTx.splitCoins).toHaveBeenCalledWith("object_coin1", [
        `pure_u64_${splitAmount}`,
      ]);
      expect(result).toEqual([`split_result_pure_u64_${splitAmount}`]);
    });
  });
});
