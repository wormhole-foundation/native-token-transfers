# M Token Portal - Sui Spoke Implementation

This directory contains the Sui implementation of M Token **Spoke Portal**, which extends Native Token Transfers (NTT) for M Token cross-chain functionality.

## Architecture

In the M^0 multichain model:
- **Ethereum = Hub Portal** (exclusive hub, lock-and-release)
- **Sui = Spoke Portal** (mint-and-burn, receives from Hub)

```
┌─────────────────┐    
│ Ethereum Hub    │────────┐
│   Portal        │        │
│ (lock-release)  │        │
└─────────────────┘        │
                           │
         ┌─────────────────▼┐
         │   Sui Spoke     │
         │   Portal        │
         │ (mint-burn)     │
         └─────────────────┘
                 │
         ┌─────────────────┐
         │   NTT State     │
         │   (Wrapped)     │
         └─────────────────┘
```

## Modules

### Core Portal Modules

1. **`spoke_portal.move`** - Main Sui Spoke Portal
   - Receives M Token transfers from Ethereum Hub (with index updates)
   - Processes custom messages from Hub Portal (index/key/list updates)
   - Burns tokens on outbound, mints on inbound
   - Integrates with Sui M Token and Registrar

2. **`payload_encoder.move`** - Custom payload encoding/decoding
   - Index transfers (`M0IT`)
   - Key transfers (`M0KT`)
   - List updates (`M0LU`) 
   - Compatible with Ethereum Hub Portal Solidity implementation

3. **`transceiver.move`** - Transceiver interface for SDK compatibility

## Key Features

### Custom Message Types

The Portal extends NTT with 4 payload types:

| Type | Prefix | Description |
|------|--------|-------------|
| Token | `NTT\x00` | Standard NTT token transfer |
| Index | `M0IT` | M Token index update |
| Key | `M0KT` | Registrar key update |
| List | `M0LU` | Registrar list update |

### M Token Integration

- **Index Propagation**: M Token index is included in all transfers
- **Earning Management**: Hub Portal controls earning enable/disable
- **Registrar Sync**: Key/value and list updates from Hub to Spokes
- **Solana Support**: Special handling for Solana merkle tree integration

### Cross-Chain Flow

#### Outbound Transfer (Sui → Ethereum Hub)
```move
1. prepare_m_token_transfer() // Add current M index to payload
2. transfer_m_token()         // Execute burn via NTT
3. Wormhole message sent     // Hub receives, releases locked tokens
```

#### Inbound Processing (Ethereum Hub → Sui)
```move  
1. attest_message()          // NTT attestation + custom payload extraction
2. release_transfer()        // Complete token mint 
3. receive_custom_payload()  // Process M-specific updates (index/key/list)
```

## Usage Example

### Spoke Portal Setup (Sui)
```move
// Initialize Sui Spoke Portal with NTT state
let (spoke_portal, admin_cap) = sui_m::spoke_portal::new(
    ntt_state,
    registrar_id,
    ctx
);

// Transfer M Tokens to Ethereum Hub
let (ticket, dust) = sui_m::spoke_portal::prepare_m_token_transfer(
    &spoke_portal,
    coins,
    coin_meta,
    ethereum_chain_id, // Always Hub
    recipient,
    false
);

sui_m::spoke_portal::transfer_m_token(
    &mut spoke_portal,
    version_gated,
    coin_meta,
    ticket,
    clock,
    ctx
);

// Process incoming custom messages from Ethereum Hub
sui_m::spoke_portal::receive_custom_payload(
    &mut spoke_portal,
    &mut registrar,
    message_id,
    payload_type,
    payload,
    ctx
);
```

## Integration with NTT

The Portal modules wrap NTT functionality:

- **State Management**: `portal.ntt_state` wraps `NttState<MToken>`
- **Transfer Logic**: Calls underlying `ntt::transfer_*` functions
- **Message Handling**: Uses NTT's `ValidatedTransceiverMessage` pattern
- **PTB Communication**: Manager ↔ Transceiver via permissioned structs

## Deployment

1. Deploy NTT state for M Token on Sui
2. Deploy Sui Spoke Portal contract
3. Register Portal as NTT manager
4. Configure Ethereum Hub as peer
5. Set up Wormhole transceiver integration between Sui and Ethereum

## TODO Items

The current implementation has several placeholder functions that need completion:

- [ ] M Token index integration (`get_current_m_index`)
- [ ] Custom message sending (`send_custom_message`)
- [ ] Solana zero-amount transfers (`send_m_token_index_to_solana`)
- [ ] Payload parsing integration with NTT message flow
- [ ] Address conversion utilities (`bytes_to_address`)
- [ ] Chain ID verification helpers
- [ ] Integration with actual M Token contract methods
- [ ] Merkle tree builder interface for Solana

## Security Considerations

- Portal contracts wrap NTT state - ensure proper access control
- Custom payload validation must match Solidity implementation exactly
- Message replay protection handled by underlying NTT
- Transceiver authentication via phantom types
- Rate limiting and threshold voting via NTT mechanisms