import { jest } from "@jest/globals";
import { SuiGrpcClient } from "@mysten/sui/grpc";

// Base64 encoding of the 32-byte array [0, 1, 2, ..., 31]
const ADDRESS_BYTES_0_31_BASE64 =
  "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
// Base64 encoding of a 32-byte array filled with 0x01
const ADDRESS_BYTES_FILL_1_BASE64 =
  "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

// Mock SuiGrpcClient responses (gRPC core methods)
export const mockSuiClient = (): jest.Mocked<SuiGrpcClient> => {
  return {
    getObject: jest.fn(),
    getDynamicField: jest.fn(),
    listDynamicFields: jest.fn(),
    getCoinMetadata: jest.fn(),
    listCoins: jest.fn(),
    simulateTransaction: jest.fn(),
    movePackageService: {
      getDatatype: jest.fn(),
    },
  } as any;
};

// Mock NTT state object (flat gRPC json shape)
export const mockNttState = (overrides: any = {}) => ({
  object: {
    type: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef::ntt::State<0x2::sui::SUI>",
    owner: { $kind: "Shared", Shared: { initialSharedVersion: "1" } },
    json: {
      id: "mock-state-id",
      mode: { variant: overrides.mode || "Locking" },
      balance: { value: "0" },
      threshold: overrides.threshold || "2",
      treasury_cap: null,
      peers: {
        id: "mock-peers-table-id",
        size: "0",
      },
      outbox: {
        entries: {
          id: "mock-outbox-table-id",
          size: "0",
        },
        rate_limit: {
          limit: overrides.outboundLimit || "1000000000000",
          capacity_at_last_tx: overrides.outboundCapacity || "1000000000000",
          last_tx_timestamp: "0",
        },
      },
      inbox: {
        entries: {
          id: "mock-inbox-table-id",
          size: "0",
        },
      },
      transceivers: {
        id: "mock-transceivers-table-id",
        next_id: "1",
        enabled_bitmap: "1",
      },
      chain_id: "21", // Sui chain ID
      next_sequence: "0",
      version: "1",
      admin_cap_id:
        overrides.adminCapId !== undefined
          ? overrides.adminCapId
          : "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      upgrade_cap_id:
        overrides.upgradeCapId !== undefined
          ? overrides.upgradeCapId
          : "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      paused: overrides.paused || false,
      ...overrides.fields,
    },
  },
});

// Mock AdminCap Object (gRPC: owner is a discriminated union)
export const mockAdminCap = (
  owner: string = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
) => ({
  object: {
    type: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef::admin::AdminCap",
    owner: {
      $kind: "AddressOwner",
      AddressOwner: owner,
    },
  },
});

// Mock UpgradeCap Object (getPackageIdFromObject reads upgradeCap.fields.cap.package)
export const mockUpgradeCap = () => ({
  object: {
    type: "0x2::package::UpgradeCap",
    json: {
      cap: {
        package:
          "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      },
    },
  },
});

// Mock Coin Metadata for SUI (returned via getCoinMetadata as { coinMetadata })
export const mockCoinMetadata = (decimals: number = 9) => ({
  coinMetadata: {
    id: "0x9876543210987654321098765432109876543210987654321098765432109876",
    decimals,
    name: "Sui",
    symbol: "SUI",
    description: "The native currency of Sui",
  },
});

// Mock Peer Data: the flat-json Field wrapper's value struct, accessed via
// getDynamicField -> fieldId -> getObject(json).value
export const mockPeerData = (overrides: any = {}) => ({
  object: {
    json: {
      value: {
        address: {
          value: {
            data: ADDRESS_BYTES_0_31_BASE64,
          },
        },
        token_decimals: overrides.tokenDecimals || "6",
        inbound_rate_limit: {
          limit: overrides.inboundLimit || "500000000000",
          capacity_at_last_tx: overrides.inboundCapacity || "500000000000",
          last_tx_timestamp: overrides.lastTxTimestamp || "0",
        },
      },
    },
  },
});

// Mock the getDynamicField response that points at a peer field object
export const mockPeerDynamicField = (fieldId: string = "0xpeerfield") => ({
  dynamicField: {
    fieldId,
  },
});

// Mock Transceiver State (getTransceiver wrapper reads state.fields.emitter_cap.id)
export const mockTransceiverState = () => ({
  object: {
    type: "0x456::wormhole_transceiver::State",
    json: {
      admin_cap_id:
        "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      peers: {
        id: "mock-transceiver-peers-table-id",
        size: "0",
      },
      emitter_cap: {
        id: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      },
    },
  },
});

// Mock Transceiver Peer Data (flat-json Field wrapper value, address bytes base64)
export const mockTransceiverPeerData = () => ({
  object: {
    json: {
      value: {
        value: {
          data: ADDRESS_BYTES_0_31_BASE64,
        },
      },
    },
  },
});

// Mock listDynamicFields response
export const mockDynamicFields = () => ({
  dynamicFields: [
    {
      name: {
        type: "0x123::transceiver_registry::Key",
      },
      fieldId: "mock-transceiver-info-id",
    },
  ],
  hasNextPage: false,
  cursor: null,
});

// Mock Transceiver Info (flat-json Field wrapper value)
export const mockTransceiverInfo = () => ({
  object: {
    json: {
      value: {
        id: 0,
        state_object_id: "mock-wormhole-transceiver-state-id",
      },
    },
  },
});

// Test Constants
export const TEST_ADDRESSES = {
  ADMIN: "0x1234567890123456789012345678901234567890123456789012345678901234",
  USER: "0x9876543210987654321098765432109876543210987654321098765432109876",
  PEER: "0x1111111111111111111111111111111111111111111111111111111111111111",
};

export const TEST_CONTRACTS = {
  ntt: {
    manager:
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    token: "0x2::sui::SUI",
    transceiver: {
      wormhole:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
    },
  },
  coreBridge:
    "0x4444444444444444444444444444444444444444444444444444444444444444",
};

export const TEST_CHAIN_IDS = {
  ETHEREUM: 2,
  SOLANA: 1,
  SUI: 21,
} as const;

// Mock Attestation
export const mockAttestation = (sourceChain: any = "Ethereum") =>
  ({
    payloadName: "WormholeTransfer" as const,
    protocolName: "Ntt" as const,
    payloadLiteral: "WormholeTransfer" as const,
    hash: new Uint8Array(32).fill(0xaa),
    guardianSet: 0,
    emitterChain: sourceChain,
    emitterAddress: {
      toUint8Array: () => new Uint8Array(32).fill(0xbb),
    },
    sequence: 123n,
    timestamp: Date.now(),
    nonce: 456,
    consistencyLevel: 15,
    payload: {
      nttManagerPayload: {
        id: new Uint8Array(32).fill(1),
        sender: {
          toUint8Array: () => new Uint8Array(32).fill(2),
        },
        payload: {
          trimmedAmount: {
            amount: 1000000n,
            decimals: 6,
          },
          sourceToken: new Uint8Array(32).fill(3),
          recipientAddress: new Uint8Array(32).fill(4),
          recipientChain: "Sui",
          additionalPayload: new Uint8Array(0),
        },
      },
    },
  }) as any;

// Mock standard Sui object response (flat gRPC json shape)
export const mockSuiObject = (type: string, json: any) => ({
  object: {
    type,
    owner: { $kind: "Shared", Shared: { initialSharedVersion: "1" } },
    json,
  },
});

// Base64 helpers exported for inline test usage
export const TEST_BASE64 = {
  BYTES_0_31: ADDRESS_BYTES_0_31_BASE64,
  BYTES_FILL_1: ADDRESS_BYTES_FILL_1_BASE64,
};
