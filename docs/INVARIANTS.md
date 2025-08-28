# Native Token Transfers (NTT) Security Invariants

> [!NOTE]  
> This document is intended to assist developers, auditors, and security researchers assess the security of NTT
> implementations. It should aid in understanding the security constraints of the system and can act as a checklist
> for porting NTT to new environments.

> [!IMPORTANT]  
> Identifying a missing invariant in an NTT implementation is not sufficient for claiming a bug bounty.
> A real issue must be identified in line with the documented policy on ImmuneFi.

## Token Supply Conservation

### INV-001: Global Token Supply Conservation

- **Invariant**: The total supply of tokens across all chains must remain constant during transfers
- **Description**: When tokens are burned on the source chain, an equivalent amount must be minted on the destination chain, and vice versa
- **Enforcement**: Burn/mint mechanisms with balance validation
- **Error Codes**: `BadAmountAfterTransfer`, `BadAmountAfterBurn` (Solana)
- **Code Reference**: `ERC20Burnable(token).burn(amount)` (EVM), treasury cap operations (Sui)

### INV-002: No Double Spending

- **Invariant**: Each cross-chain transfer message can only be redeemed once
- **Description**: Prevents replay attacks where the same transfer message could be processed multiple times
- **Enforcement**: Message hash tracking, VAA consumption, inbox key uniqueness
- **Error Codes**: `TransferAlreadyRedeemed` (Solana), `ETransferAlreadyRedeemed` (Sui)
- **Code Reference**: `_isMessageExecuted()` (EVM), PDA derivation (Solana), `InboxKey` structure (Sui)

## Cross-Chain Message Integrity

### INV-003: Message Authentication

- **Invariant**: All cross-chain messages must be cryptographically verified before processing
- **Description**: Messages must contain valid signatures from authorized guardians/validators
- **Enforcement**: Wormhole guardian signature verification, VAA validation
- **Error Codes**: `InvalidTransceiverPeer`, `InvalidNttManagerPeer` (Solana)
- **Code Reference**: `isVAAConsumed(vm.hash)` (EVM), Wormhole integration (all chains)

### INV-004: Message Ordering and Nonce Validation

- **Invariant**: Messages must be processed in the correct order with valid nonces
- **Description**: Prevents out-of-order execution that could lead to inconsistent state
- **Enforcement**: Sequence number validation, message ID tracking
- **Error Codes**: `MessageAlreadySent` (Solana)
- **Code Reference**: `_useMessageSequence()` (EVM), `next_sequence` tracking (Sui)

### INV-005: Message Sequences Cannot Be Reused

- **Invariant**: Messages must have unique message sequences (per sender) that cannot be reused
- **Description**: Prevents replays of previous messages
- **Enforcement**: Sequence number validation
- **Error Codes**: `MessageAlreadySent` (Solana)
- **Code Reference**: `_useMessageSequence()` (EVM), `next_sequence` tracking (Sui)

### INV-006: Message Hash Integrity

- **Invariant**: Message hashes must accurately represent message content
- **Description**: Prevents tampering with message data during transmission
- **Enforcement**: Cryptographic hash verification and digest tracking
- **Error Codes**: Hash mismatch detection in message processing
- **Code Reference**: `nttManagerMessageDigest()` (EVM), VAA hash validation

## Access Control and Authorization

### INV-007: Owner-Only Administrative Functions

- **Invariant**: Critical administrative functions can only be called by authorized owners
- **Description**: Functions like pause, upgrade, and configuration changes require proper authorization
- **Enforcement**: Role-based access control (EVM), account constraints (Solana), capability-based (Sui)
- **Error Codes**: `InvalidPendingOwner` (Solana), `EInvalidAuthType` (Sui)
- **Code Reference**: `onlyOwner` modifier (EVM), `has_one = owner` (Solana), `AdminCap` requirement (Sui)

### INV-008: Transceiver Authorization

- **Invariant**: Only registered and enabled transceivers can send/receive messages
- **Description**: Prevents unauthorized message sources from affecting the protocol
- **Enforcement**: Transceiver registration and enablement bitmap checks
- **Error Codes**: `DisabledTransceiver`, `InvalidTransceiverProgram` (Solana)
- **Code Reference**: `_getEnabledTransceiversStorage()` (EVM), transceiver registry validation (all chains)

## Rate Limiting and Threshold Controls

### INV-009: Outbound Rate Limiting

- **Invariant**: Token transfers must respect configured rate limits per time window
- **Description**: Prevents large-scale token draining attacks
- **Enforcement**: Time-based capacity tracking with configurable limits and queuing
- **Error Codes**: `TransferExceedsRateLimit` (Solana), `ETransferExceedsRateLimit` (Sui)
- **Code Reference**: `RateLimiter.sol` (EVM), rate limit integration (Solana), `RateLimitState` (Sui)

### INV-010: Inbound Rate Limiting

- **Invariant**: Incoming transfers must respect rate limits to prevent flooding
- **Description**: Protects against malicious actors overwhelming the system
- **Enforcement**: Inbound rate limiting with queue management
- **Error Codes**: Rate limit validation in transfer processing
- **Code Reference**: `_enqueueInboundTransfer()` (EVM), integrated validation (Solana/Sui)

### INV-011: Rate Limit Adjusted by Backflow

- **Invariant**: Incoming flow should free up capacity for outgoing flow
- **Description**: Backflow mechanisms optimize rate limit capacity utilization
- **Enforcement**: Rate limit adjustment calculations based on transfer direction
- **Code Reference**: `_enqueueOrConsumeInboundRateLimit()` (EVM)

## Attestation and Verification

### INV-012: Multi-Transceiver Attestation Threshold

- **Invariant**: Messages must be attested by a minimum number of enabled transceivers
- **Description**: Ensures redundancy and prevents single points of failure
- **Enforcement**: Bitmap-based vote counting against configurable threshold
- **Error Codes**: `TransferNotApproved` (Solana)
- **Code Reference**: `isMessageApproved()` (EVM), bitmap voting (Solana), `count_enabled_votes()` (Sui)

### INV-013: Valid Attestation Signatures

- **Invariant**: All attestations must contain valid cryptographic signatures
- **Description**: Prevents forged attestations from unauthorized sources
- **Enforcement**: Cryptographic signature verification through Wormhole
- **Error Codes**: Signature validation in transceiver logic
- **Code Reference**: Wormhole guardian verification (all chains)

## Emergency Controls and Pause Mechanisms

### INV-014: Pause Functionality

- **Invariant**: The protocol must be pausable in emergency situations
- **Description**: Allows immediate halt of operations if vulnerabilities are discovered
- **Enforcement**: Pause state with operation blocking modifiers/constraints
- **Error Codes**: `Paused` (Solana), **MISSING** (Sui)
- **Code Reference**: 
  - `whenNotPaused` modifier (EVM)
  - `NotPausedConfig` constraint (Solana)
  - `paused` field in `State` struct (Sui)

### INV-015: Pause Authority Restrictions

- **Invariant**: Only authorized entities can pause/unpause the protocol
- **Description**: Prevents unauthorized disruption of service
- **Enforcement**: Access control on pause actions
- **Error Codes**: `NotPaused` (Solana), `EPaused` (Sui)
- **Code Reference**: 
  - `onlyOwnerOrPauser` (EVM) -- supports pausing by both Owner and Pauser roles
  - owner constraint (Solana), 
  - `AdminCap` (Sui)

## Upgrade Safety

### INV-016: Upgrade Authorization

- **Invariant**: Contract upgrades must be authorized by proper governance
- **Description**: Prevents unauthorized code changes that could compromise security
- **Enforcement**: Upgrade capability restrictions and authorization checks
- **Error Codes**: Authorization validation in upgrade functions
- **Code Reference**: `onlyOwner` upgrade (EVM), governance controls (Solana), `UpgradeCap` (Sui)

### INV-017: Upgrade Compatibility

- **Invariant**: Upgrades must maintain storage layout and interface compatibility
- **Description**: Prevents storage corruption and interface breaking changes
- **Enforcement**: Storage gap patterns, version checking, compatibility validation
- **Error Codes**: `EVersionMismatch` (Sui)
- **Code Reference**: OpenZeppelin patterns (EVM), `VersionGated` checks (Sui)

## Chain and Protocol Validation

### INV-018: Token Decimals Consistency

- **Invariant**: Token decimal handling must be consistent across chains
- **Description**: Prevents precision loss or incorrect token amounts during transfers
- **Enforcement**: Decimal normalization and trimmed amount calculations
- **Error Codes**: `OverflowExponent`, `OverflowScaledAmount` (Solana)
- **Code Reference**: `TrimmedAmount` library (all chains), decimal conversion logic

### INV-019: Chain ID Validation

- **Invariant**: Operations must validate correct destination chain
- **Description**: Ensures transfers are processed on the intended target chain
- **Enforcement**: Chain ID matching in message processing
- **Error Codes**: `InvalidChainId` (Solana), `EWrongDestinationChain` (Sui)
- **Code Reference**: `if (nativeTokenTransfer.toChain != chainId) revert InvalidTargetChain();`

### INV-020: Fee Payment Validation

- **Invariant**: All cross-chain transfers must pay required fees
- **Description**: Ensures economic sustainability and prevents spam
- **Enforcement**: Fee calculation and payment verification before message sending
- **Error Codes**: `DeliveryPaymentTooLow` (EVM)
- **Code Reference**: `_quoteDeliveryPrice()` and payment validation

## Peer Management

### INV-021: Peer Management

- **Invariant**: NTT Manager's peers must not be registered on the same chainID as the NTT Manager
- **Description**: Peers refer to NTT Managers on other chains; peers must not register each other on the same chain as they are operating on
- **Enforcement**: Assertions in peer configuration flows
- **Code Reference**: `NttManager.sol setPeer()` (EVM)

## Transceiver Management

### INV-022: Transceiver Registration Requirement

- **Invariant**: A transceiver can be enabled only when it is also registered
- **Description**: It is invalid for an enabled transceiver to be unregistered
- **Enforcement**: Assertions on transceiver management code paths
- **Code Reference**: `TransceiverRegistry.sol` (EVM)

### INV-023: Attestation Threshold Bounds

- **Invariant**: `threshold <= number_of_enabled_transceivers && threshold > 0`
- **Description**: Attestation threshold must not exceed available transceivers and must be positive
- **Enforcement**: Explicit bounds checking in threshold setting functions
- **Error Codes**: `ThresholdTooHigh`, `ZeroThreshold` (EVM/Solana), **MISSING VALIDATION** (Sui)
- **Code Reference**: `_checkThresholdInvariants()` (EVM), error enforcement (Solana), `EThresholdTooHigh` (Sui)

### INV-024: Non-Zero Threshold Requirement

- **Invariant**: When transceivers are registered, threshold must be greater than zero
- **Description**: Prevents configuration where messages cannot be approved due to zero threshold
- **Enforcement**: Zero threshold validation when transceivers exist
- **Error Codes**: `ZeroThreshold` (EVM/Solana), `EZeroThreshold` (Sui)
- **Code Reference**: `if (numTransceivers.registered > 0 && threshold == 0) revert ZeroThreshold();`

### INV-025: Minimum Transceiver Requirement

- **Invariant**: At least one transceiver must be enabled for operations
- **Description**: Prevents operations when no transceivers are available to process messages
- **Enforcement**: Enabled transceiver count validation before operations
- **Error Codes**: `NoEnabledTransceivers` (EVM), `NoRegisteredTransceivers` (Solana)
- **Code Reference**: `if (numEnabledTransceivers == 0) revert NoEnabledTransceivers();`

## Timing and Release Controls

### INV-026: Release Timing Validation

- **Invariant**: Transfers can only be released after rate limit delay expires
- **Description**: Enforces time-based delays for rate-limited transfers
- **Enforcement**: Timestamp validation before transfer release
- **Error Codes**: `CantReleaseYet` (Solana), `ECantReleaseYet` (Sui)
- **Code Reference**: Rate limiter queue system with timestamp checks, `try_release()` functions

### INV-027: Transfer Redemption Controls

- **Invariant**: Transfers must be properly approved and not already redeemed before processing
- **Description**: Prevents unauthorized or duplicate transfer redemptions
- **Enforcement**: Approval status and redemption state validation
- **Error Codes**: `TransferCannotBeRedeemed`, `TransferAlreadyRedeemed` (Solana), `ETransferCannotBeRedeemed`, `ETransferAlreadyRedeemed` (Sui)
- **Code Reference**: Inbox item status tracking, redemption state management

## Message Size Constraints

### INV-028: Payload Length Limitation

- **Invariant**: NttManagerMessages and AdditionalPayloads must not exceed uint16 in size
- **Description**: Prevents unbounded message sizes that could cause processing issues
- **Enforcement**: Assertions in encoding logic
- **Error Codes**: `PayloadTooLong` (EVM)
- **Code Reference**: `TransceiverStructs.sol` (EVM), implementation of `Writable` trait for `NativeTokenTransfer` (Solana)

### INV-029: Transceiver Instruction Length Limitation

- **Invariant**: Individual transceiver instruction payloads must not exceed uint8 in size
- **Description**: Prevents unbounded message sizes that could cause processing issues
- **Enforcement**: Assertions in encoding logic
- **Error Codes**: `PayloadTooLong` (EVM)
- **Code Reference**: `encodeTransceiverInstruction()` (EVM)
