# Transceiver

## Overview

The Transceiver is intended to offer a protocol-agnostic interface for sending and receiving cross-chain messages. For Native Token Transfers, this entails initiating attestation generation on the source chain, verifying the resulting attestation on the destination chain, and delivering the message to the associated `NttManager`.

In the provided implementations ([EVM](/evm/src/Transceiver/Transceiver.sol)/[SVM](/solana/programs/ntt-transceiver/src/wormhole/)), Transceivers are intended to have a many-to-one relationship with Managers.

## Message Specification

### TransceiverMessage

NttManager message emitted by a Transceiver implementation. Each message includes a Transceiver-specified 4-byte prefix. This should be a constant value, set by a protocol-specific Transceiver implementation, that identifies the payload as an NTT Transceiver emitted payload.

```go
[4]byte  prefix
[32]byte source_ntt_manager_address
[32]byte recipient_ntt_manager_address
uint16   ntt_manager_payload_length
[]byte   ntt_manager_payload
uint16   transceiver_payload_length
[]byte   transceiver_payload
```

### Wormhole Transceiver

#### TransceiverMessage

```go
prefix = 0x9945FF10
```

#### Initialize Transceiver

```go
[4]byte  prefix = 0x9c23bd3b // bytes4(keccak256("WormholeTransceiverInit"))
[32]byte ntt_manager_address // address of the associated manager
uint8    ntt_manager_mode    // the locking/burning mode of the associated manager
[32]byte token_address       // address of the associated manager's token
uint8    token_decimals      // the number of decimals for that token
```

Mode is an enum.

```
Locking = 0
Burning = 1
```

#### Transceiver (Peer) Registration

```go
[4]byte  prefix = 0x18fc67c2 // bytes4(keccak256("WormholePeerRegistration"))
uint16   peer_chain_id       // Wormhole Chain ID of the foreign peer transceiver
[32]byte peer_address        // the address of the foreign peer transceiver
```
