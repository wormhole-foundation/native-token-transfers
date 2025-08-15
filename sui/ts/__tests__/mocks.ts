import { SuiClient } from '@mysten/sui/client';

// Mock SuiClient responses
export const mockSuiClient = (): jest.Mocked<SuiClient> => {
  return {
    getObject: jest.fn(),
    getOwnedObjects: jest.fn(),
    getDynamicFieldObject: jest.fn(),
    getDynamicFields: jest.fn(),
    getCoinMetadata: jest.fn(),
    getCoins: jest.fn(),
    executeTransactionBlock: jest.fn(),
    dryRunTransactionBlock: jest.fn(),
    getBalance: jest.fn(),
    getAllBalances: jest.fn(),
    getTransactionBlock: jest.fn(),
    multiGetObjects: jest.fn(),
    getRpcApiVersion: jest.fn(),
    requestSuiFromFaucet: jest.fn(),
  } as any;
};

// Mock SuiMoveObject structure for NTT state
export const mockNttState = (overrides: any = {}) => ({
  data: {
    digest: 'mockDigest123',
    objectId: 'mockObjectId123',
    version: '1',
    content: {
      dataType: 'moveObject' as const,
      type: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef::ntt::State<0x2::sui::SUI>',
      hasPublicTransfer: false,
      fields: {
        id: { id: 'mock-state-id' },
        mode: { variant: overrides.mode || 'Locking' },
        balance: { value: '0' },
        threshold: overrides.threshold || '2',
        treasury_cap: null,
        peers: {
          fields: {
            id: { id: 'mock-peers-table-id' },
            size: '0'
          }
        },
        outbox: {
          fields: {
            entries: {
              fields: {
                id: { id: 'mock-outbox-table-id' },
                size: '0'
              }
            },
            rate_limit: {
              fields: {
                limit: overrides.outboundLimit || '1000000000000',
                capacity_at_last_tx: overrides.outboundCapacity || '1000000000000',
                last_tx_timestamp: '0'
              }
            }
          }
        },
        inbox: {
          fields: {
            entries: {
              fields: {
                id: { id: 'mock-inbox-table-id' },
                size: '0'
              }
            }
          }
        },
        transceivers: {
          fields: {
            id: { id: 'mock-transceivers-table-id' },
            next_id: '1',
            enabled_bitmap: '1'
          }
        },
        chain_id: '21', // Sui chain ID
        next_sequence: '0',
        version: '1',
        admin_cap_id: overrides.adminCapId !== undefined ? overrides.adminCapId : '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        upgrade_cap_id: overrides.upgradeCapId !== undefined ? overrides.upgradeCapId : '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        paused: overrides.paused || false,
        ...overrides.fields
      }
    }
  }
});

// Mock AdminCap Object
export const mockAdminCap = (owner: string = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef') => ({
  data: {
    objectId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    owner: {
      AddressOwner: owner
    }
  }
});

// Mock UpgradeCap Object
export const mockUpgradeCap = () => ({
  data: {
    content: {
      dataType: 'moveObject',
      fields: {
        cap: {
          fields: {
            package: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
          }
        }
      }
    }
  }
});

// Mock Coin Metadata for SUI
export const mockCoinMetadata = (decimals: number = 9) => ({
  id: '0x9876543210987654321098765432109876543210987654321098765432109876',
  decimals,
  name: 'Sui',
  symbol: 'SUI',
  description: 'The native currency of Sui'
});

// Mock Peer Data from dynamic field
export const mockPeerData = (overrides: any = {}) => ({
  data: {
    content: {
      dataType: 'moveObject',
      fields: {
        value: {
          fields: {
            address: {
              fields: {
                value: {
                  fields: {
                    data: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]
                  }
                }
              }
            },
            token_decimals: overrides.tokenDecimals || '6',
            inbound_rate_limit: {
              fields: {
                limit: overrides.inboundLimit || '500000000000',
                capacity_at_last_tx: overrides.inboundCapacity || '500000000000',
                last_tx_timestamp: overrides.lastTxTimestamp || '0'
              }
            }
          }
        }
      }
    }
  }
});

// Mock Transceiver State
export const mockTransceiverState = () => ({
  data: {
    content: {
      dataType: 'moveObject',
      type: '0x456::wormhole_transceiver::State',
      fields: {
        admin_cap_id: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        peers: {
          fields: {
            id: { id: 'mock-transceiver-peers-table-id' },
            size: '0'
          }
        },
        emitter_cap: {
          fields: {
            id: { id: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' }
          }
        }
      }
    }
  }
});

// Mock Transceiver Peer Data
export const mockTransceiverPeerData = () => ({
  data: {
    content: {
      dataType: 'moveObject',
      fields: {
        value: {
          fields: {
            value: {
              fields: {
                data: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]
              }
            }
          }
        }
      }
    }
  }
});

// Mock Dynamic Fields response
export const mockDynamicFields = () => ({
  data: [
    {
      name: {
        type: '0x123::transceiver_registry::Key',
        value: { id: 0 }
      },
      objectId: 'mock-transceiver-info-id'
    }
  ]
});

// Mock Transceiver Info
export const mockTransceiverInfo = () => ({
  data: {
    content: {
      dataType: 'moveObject',
      fields: {
        value: {
          fields: {
            id: 0,
            state_object_id: 'mock-wormhole-transceiver-state-id'
          }
        }
      }
    }
  }
});

// Test Constants
export const TEST_ADDRESSES = {
  ADMIN: '0x1234567890123456789012345678901234567890123456789012345678901234',
  USER: '0x9876543210987654321098765432109876543210987654321098765432109876',
  PEER: '0x1111111111111111111111111111111111111111111111111111111111111111'
};

export const TEST_CONTRACTS = {
  ntt: {
    manager: '0x2222222222222222222222222222222222222222222222222222222222222222',
    token: '0x2::sui::SUI',
    transceiver: {
      wormhole: '0x3333333333333333333333333333333333333333333333333333333333333333'
    }
  },
  coreBridge: '0x4444444444444444444444444444444444444444444444444444444444444444'
};

export const TEST_CHAIN_IDS = {
  ETHEREUM: 2,
  SOLANA: 1,
  SUI: 21
} as const;

// Mock Attestation
export const mockAttestation = (sourceChain: any = 'Ethereum') => ({
  payloadName: 'WormholeTransfer' as const,
  protocolName: 'Ntt' as const,
  payloadLiteral: 'WormholeTransfer' as const,
  hash: new Uint8Array(32).fill(0xaa),
  guardianSet: 0,
  emitterChain: sourceChain,
  emitterAddress: {
    toUint8Array: () => new Uint8Array(32).fill(0xbb)
  },
  sequence: 123n,
  timestamp: Date.now(),
  nonce: 456,
  consistencyLevel: 15,
  payload: {
    nttManagerPayload: {
      id: new Uint8Array(32).fill(1),
      sender: {
        toUint8Array: () => new Uint8Array(32).fill(2)
      },
      payload: {
        trimmedAmount: {
          amount: 1000000n,
          decimals: 6
        },
        sourceToken: new Uint8Array(32).fill(3),
        recipientAddress: new Uint8Array(32).fill(4),
        recipientChain: 'Sui',
        additionalPayload: new Uint8Array(0)
      }
    }
  }
} as any);

// Mock standard Sui object response
export const mockSuiObject = (type: string, fields: any) => ({
  data: {
    digest: 'mockDigest',
    objectId: 'mockObjectId',
    version: '1',
    content: {
      dataType: 'moveObject' as const,
      type,
      hasPublicTransfer: false,
      fields
    }
  }
});

// Mock Inbox Item for transfer status checking
export const mockInboxItem = (overrides: any = {}) => ({
  data: {
    content: {
      dataType: 'moveObject',
      type: '0x123::inbox::InboxItem',
      hasPublicTransfer: false,
      fields: {
        init: overrides.init !== undefined ? overrides.init : true,
        recipient: overrides.recipient || '0x' + '1'.repeat(64),
        amount: overrides.amount || '1000000000',
        release_status: {
          released: overrides.released !== undefined ? overrides.released : false,
          release_after: overrides.releaseAfter || null
        }
      }
    }
  }
});

// Mock Quoter Instance for delivery pricing
export const mockQuoterInstance = (overrides: any = {}) => ({
  data: {
    content: {
      dataType: 'moveObject',
      type: '0x789::quoter::Instance',
      hasPublicTransfer: false,
      fields: {
        sui_price_in_usd: overrides.suiPriceInUsd || '80000000', // $80 in 6 decimals
        precision: overrides.precision || '1000000' // 6 decimals
      }
    }
  }
});

// Mock Quoter Registered Chain for delivery pricing
export const mockQuoterChain = (overrides: any = {}) => ({
  data: {
    content: {
      dataType: 'moveObject',
      type: '0x789::quoter::RegisteredChain',
      hasPublicTransfer: false,
      fields: {
        gas_price: overrides.gasPrice || '20000000000', // 20 gwei
        native_token_price: overrides.nativeTokenPrice || '3000000000', // $3000 in 6 decimals
        base_fee: overrides.baseFee || '50000' // $0.05 in 6 decimals
      }
    }
  }
});