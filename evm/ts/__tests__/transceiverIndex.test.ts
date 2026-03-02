import { EvmNtt, EvmNttWormholeTranceiver } from "../src/ntt.js";
import { Ntt } from "@wormhole-foundation/sdk-definitions-ntt";

// Helper to build a minimal mock xcvr object
function mockXcvr(address: string, registeredIndex = 0) {
  return {
    address,
    registeredIndex,
    encodeFlags: jest.fn((flags: { skipRelay: boolean }) => {
      return new Uint8Array([flags.skipRelay ? 1 : 0]);
    }),
    transceiver: {
      quoteDeliveryPrice: jest.fn().mockResolvedValue(100n),
    },
  } as unknown as EvmNttWormholeTranceiver<any, any>;
}

// Helper to build a minimal mock EvmNtt-like object with prototype methods bound
function buildNttStub(opts: {
  xcvrs: EvmNttWormholeTranceiver<any, any>[];
  manager: Record<string, jest.Mock | any>;
}) {
  return {
    xcvrs: opts.xcvrs,
    manager: opts.manager,
    _transceiverIndicesInitialized: false,
    managerAddress: "0xmanager",
    tokenAddress: "0xtoken",
    initTransceiverIndices: EvmNtt.prototype.initTransceiverIndices,
    encodeOptions: EvmNtt.prototype.encodeOptions,
    quoteDeliveryPrice: EvmNtt.prototype.quoteDeliveryPrice,
    verifyAddresses: EvmNtt.prototype.verifyAddresses,
  };
}

describe("transceiver index handling", () => {
  describe("constructor", () => {
    it("should not throw when contracts.ntt.transceiver is missing", () => {
      const ntt = new EvmNtt(
        "Testnet" as any,
        "Sepolia" as any,
        {} as any,
        {
          ntt: {
            manager: "0x0000000000000000000000000000000000000001",
            token: "0x0000000000000000000000000000000000000002",
          },
        } as any,
        "2.0.0"
      );

      expect(ntt.xcvrs).toHaveLength(0);
    });

    it("should throw on unsupported transceiver types", () => {
      expect(
        () =>
          new EvmNtt(
            "Testnet" as any,
            "Sepolia" as any,
            {} as any,
            {
              ntt: {
                manager: "0x0000000000000000000000000000000000000001",
                token: "0x0000000000000000000000000000000000000002",
                transceiver: {
                  wormhole: "0x0000000000000000000000000000000000000003",
                  axelar: "0x0000000000000000000000000000000000000004",
                },
              },
            } as any,
            "2.0.0"
          )
      ).toThrow("Unsupported transceiver type: axelar");
    });
  });

  describe("initTransceiverIndices", () => {
    it("should set registeredIndex from on-chain getTransceiverInfo", async () => {
      const xcvr = mockXcvr("0xb58477e074265bdc7f7ca6100ed0f7de264f74a2");

      const ntt = buildNttStub({
        xcvrs: [xcvr],
        manager: {
          getTransceiverInfo: jest
            .fn()
            .mockResolvedValue([
              { registered: true, enabled: true, index: 1n },
            ]),
          getTransceivers: jest
            .fn()
            .mockResolvedValue(["0xb58477e074265bdc7f7ca6100ed0f7de264f74a2"]),
        },
      });

      await ntt.initTransceiverIndices();

      expect(xcvr.registeredIndex).toBe(1);
    });

    it("should match transceivers by address case-insensitively", async () => {
      const xcvr = mockXcvr("0xB58477E074265BDC7F7CA6100ED0F7DE264F74A2");

      const ntt = buildNttStub({
        xcvrs: [xcvr],
        manager: {
          getTransceiverInfo: jest
            .fn()
            .mockResolvedValue([
              { registered: true, enabled: true, index: 3n },
            ]),
          getTransceivers: jest
            .fn()
            .mockResolvedValue(["0xb58477e074265bdc7f7ca6100ed0f7de264f74a2"]),
        },
      });

      await ntt.initTransceiverIndices();

      expect(xcvr.registeredIndex).toBe(3);
    });

    it("should keep default index 0 when getTransceiverInfo is not available", async () => {
      const xcvr = mockXcvr("0xb58477e074265bdc7f7ca6100ed0f7de264f74a2");

      // Manager without getTransceiverInfo (old ABI version)
      const ntt = buildNttStub({
        xcvrs: [xcvr],
        manager: {
          getTransceivers: jest
            .fn()
            .mockResolvedValue(["0xb58477e074265bdc7f7ca6100ed0f7de264f74a2"]),
        },
      });

      await ntt.initTransceiverIndices();

      expect(xcvr.registeredIndex).toBe(0);
    });

    it("should keep default index 0 when getTransceiverInfo throws", async () => {
      const xcvr = mockXcvr("0xb58477e074265bdc7f7ca6100ed0f7de264f74a2");

      const ntt = buildNttStub({
        xcvrs: [xcvr],
        manager: {
          getTransceiverInfo: jest
            .fn()
            .mockRejectedValue(new Error("not supported")),
          getTransceivers: jest.fn().mockResolvedValue([]),
        },
      });

      await ntt.initTransceiverIndices();

      expect(xcvr.registeredIndex).toBe(0);
    });

    it("should retry initialization after a transient failure", async () => {
      const xcvr = mockXcvr("0xaaaa");

      const getTransceiverInfo = jest
        .fn()
        .mockRejectedValueOnce(new Error("temporary rpc error"))
        .mockResolvedValueOnce([
          { registered: true, enabled: true, index: 7n },
        ]);

      const ntt = buildNttStub({
        xcvrs: [xcvr],
        manager: {
          getTransceiverInfo,
          getTransceivers: jest.fn().mockResolvedValue(["0xaaaa"]),
        },
      });

      await ntt.initTransceiverIndices();
      expect(xcvr.registeredIndex).toBe(0);

      await ntt.initTransceiverIndices();
      expect(xcvr.registeredIndex).toBe(7);
      expect(getTransceiverInfo).toHaveBeenCalledTimes(2);
    });

    it("should only initialize once (idempotent)", async () => {
      const xcvr = mockXcvr("0xaaaa");

      const getTransceiverInfo = jest
        .fn()
        .mockResolvedValue([{ registered: true, enabled: true, index: 5n }]);

      const ntt = buildNttStub({
        xcvrs: [xcvr],
        manager: {
          getTransceiverInfo,
          getTransceivers: jest.fn().mockResolvedValue(["0xaaaa"]),
        },
      });

      await ntt.initTransceiverIndices();
      await ntt.initTransceiverIndices();
      await ntt.initTransceiverIndices();

      expect(getTransceiverInfo).toHaveBeenCalledTimes(1);
    });

    it("should handle multiple transceivers with different indices", async () => {
      const xcvrA = mockXcvr("0xaaaa");
      const xcvrB = mockXcvr("0xbbbb");

      const ntt = buildNttStub({
        xcvrs: [xcvrA, xcvrB],
        manager: {
          getTransceiverInfo: jest.fn().mockResolvedValue([
            { registered: true, enabled: true, index: 2n },
            { registered: true, enabled: true, index: 5n },
          ]),
          getTransceivers: jest.fn().mockResolvedValue(["0xaaaa", "0xbbbb"]),
        },
      });

      await ntt.initTransceiverIndices();

      expect(xcvrA.registeredIndex).toBe(2);
      expect(xcvrB.registeredIndex).toBe(5);
    });
  });

  describe("encodeOptions", () => {
    it("should use registeredIndex instead of hardcoded 0", () => {
      const xcvr = mockXcvr("0xaaaa", 3);

      const ntt = buildNttStub({
        xcvrs: [xcvr],
        manager: {},
      });

      const options: Ntt.TransferOptions = {
        queue: false,
        automatic: false,
      };

      const result = ntt.encodeOptions(options);

      expect(result).toHaveLength(1);
      expect(result[0]!.index).toBe(3);
    });

    it("should produce sorted instructions when multiple transceivers exist", () => {
      const xcvrA = mockXcvr("0xaaaa", 5);
      const xcvrB = mockXcvr("0xbbbb", 2);

      const ntt = buildNttStub({
        xcvrs: [xcvrA, xcvrB],
        manager: {},
      });

      const result = ntt.encodeOptions({ queue: false, automatic: false });

      expect(result).toHaveLength(2);
      // Should be sorted ascending by index
      expect(result[0]!.index).toBe(2);
      expect(result[1]!.index).toBe(5);
    });

    it("should encode skipRelay=true when automatic=false", () => {
      const xcvr = mockXcvr("0xaaaa", 1);

      const ntt = buildNttStub({
        xcvrs: [xcvr],
        manager: {},
      });

      ntt.encodeOptions({ queue: false, automatic: false });

      expect(xcvr.encodeFlags).toHaveBeenCalledWith({ skipRelay: true });
    });

    it("should encode skipRelay=false when automatic=true", () => {
      const xcvr = mockXcvr("0xaaaa", 1);

      const ntt = buildNttStub({
        xcvrs: [xcvr],
        manager: {},
      });

      ntt.encodeOptions({ queue: false, automatic: true });

      expect(xcvr.encodeFlags).toHaveBeenCalledWith({ skipRelay: false });
    });
  });

  describe("quoteDeliveryPrice", () => {
    it("should call transceiver quoteDeliveryPrice directly (not manager)", async () => {
      const xcvr = mockXcvr("0xaaaa", 1);
      (
        xcvr.transceiver.quoteDeliveryPrice as unknown as jest.Mock
      ).mockResolvedValue(42000n);

      const managerQuote = jest.fn();

      const ntt = buildNttStub({
        xcvrs: [xcvr],
        manager: {
          quoteDeliveryPrice: managerQuote,
          getTransceiverInfo: jest
            .fn()
            .mockResolvedValue([
              { registered: true, enabled: true, index: 1n },
            ]),
          getTransceivers: jest.fn().mockResolvedValue(["0xaaaa"]),
        },
      });

      // Pre-init so we don't need to mock toChainId chain resolution
      ntt._transceiverIndicesInitialized = true;
      xcvr.registeredIndex = 1;

      const price = await ntt.quoteDeliveryPrice("Sepolia" as any, {
        queue: false,
        automatic: false,
      });

      expect(price).toBe(42000n);
      expect(xcvr.transceiver.quoteDeliveryPrice).toHaveBeenCalled();
      // Manager's quoteDeliveryPrice should NOT be called
      expect(managerQuote).not.toHaveBeenCalled();
    });

    it("should sum quotes from multiple transceivers", async () => {
      const xcvrA = mockXcvr("0xaaaa", 2);
      const xcvrB = mockXcvr("0xbbbb", 5);
      (
        xcvrA.transceiver.quoteDeliveryPrice as unknown as jest.Mock
      ).mockResolvedValue(100n);
      (
        xcvrB.transceiver.quoteDeliveryPrice as unknown as jest.Mock
      ).mockResolvedValue(200n);

      const ntt = buildNttStub({
        xcvrs: [xcvrA, xcvrB],
        manager: {},
      });
      ntt._transceiverIndicesInitialized = true;

      const price = await ntt.quoteDeliveryPrice("Sepolia" as any, {
        queue: false,
        automatic: false,
      });

      expect(price).toBe(300n);
    });

    it("should pass each transceiver the instruction matching its registered index", async () => {
      const xcvrA = mockXcvr("0xaaaa", 2);
      const xcvrB = mockXcvr("0xbbbb", 5);

      const ntt = buildNttStub({
        xcvrs: [xcvrA, xcvrB],
        manager: {},
      });
      ntt._transceiverIndicesInitialized = true;

      await ntt.quoteDeliveryPrice("Sepolia" as any, {
        queue: false,
        automatic: false,
      });

      // Each transceiver should receive an instruction with its own registered index
      const callA = (
        xcvrA.transceiver.quoteDeliveryPrice as unknown as jest.Mock
      ).mock.calls[0]!;
      expect(callA[1].index).toBe(2);

      const callB = (
        xcvrB.transceiver.quoteDeliveryPrice as unknown as jest.Mock
      ).mock.calls[0]!;
      expect(callB[1].index).toBe(5);
    });
  });

  describe("real-world scenario: transceiver at index 1 after remove+re-add", () => {
    it("should correctly encode instructions for a transceiver at index 1", async () => {
      // Simulate: old transceiver was at index 0, removed.
      // New transceiver registered at index 1.
      const newXcvr = mockXcvr("0xb58477e074265bdc7f7ca6100ed0f7de264f74a2");

      const ntt = buildNttStub({
        xcvrs: [newXcvr],
        manager: {
          getTransceiverInfo: jest
            .fn()
            .mockResolvedValue([
              { registered: true, enabled: true, index: 1n },
            ]),
          getTransceivers: jest
            .fn()
            .mockResolvedValue(["0xb58477e074265bdc7f7ca6100ed0f7de264f74a2"]),
        },
      });

      await ntt.initTransceiverIndices();

      expect(newXcvr.registeredIndex).toBe(1);

      const instructions = ntt.encodeOptions({
        queue: false,
        automatic: false,
      });
      expect(instructions[0]!.index).toBe(1);

      // Verify the encoded bytes contain index 1, not index 0
      // Format: [num_instructions(1 byte), index(1 byte), payload_len(1 byte), payload...]
      const encoded = Ntt.encodeTransceiverInstructions(instructions);
      expect(encoded[0]).toBe(1); // 1 instruction
      expect(encoded[1]).toBe(1); // index = 1, not 0
    });
  });

  describe("verifyAddresses", () => {
    it("should fall back to first enabled transceiver for manager-only discovery", async () => {
      const ntt = buildNttStub({
        xcvrs: [],
        manager: {
          token: jest.fn().mockResolvedValue("0xtoken"),
          getTransceivers: jest.fn().mockResolvedValue(["0xabc"]),
        },
      });

      const diff = await ntt.verifyAddresses();

      expect(diff).toEqual({
        transceiver: {
          wormhole: "0xabc",
        },
      });
    });
  });
});
