# EVM

## Message Lifecycle (EVM)

1. **Transfer**

A client calls on [`transfer`] to initiate an NTT transfer. The client must specify at minimum, the amount of the transfer, the recipient chain, and the recipient address on the recipient chain. [`transfer`] also supports a flag to specify whether the `NttManager` should queue rate-limited transfers or revert. Clients can also include additional instructions to forward along to the Transceiver on the source chain. Depending on mode set in the initial configuration of the `NttManager` contract, transfers are either "locked" or "burned". Once the transfer has been forwarded to the Transceiver, the `NttManager` emits the `TransferSent` event.

_Events_

```solidity
/// @notice Emitted when a message is sent from the nttManager.
/// @dev Topic0
///      0x9716fe52fe4e02cf924ae28f19f5748ef59877c6496041b986fbad3dae6a8ecf
/// @param recipient The recipient of the message.
/// @param amount The amount transferred.
/// @param fee The amount of ether sent along with the tx to cover the delivery fee.
/// @param recipientChain The chain ID of the recipient.
/// @param msgSequence The unique sequence ID of the message.
event TransferSent(
    bytes32 recipient, uint256 amount, uint256 fee, uint16 recipientChain, uint64 msgSequence
);
```

```solidity
/// @notice Emitted when a message is sent from the nttManager.
/// @dev Topic0
///      0x3e6ae56314c6da8b461d872f41c6d0bb69317b9d0232805aaccfa45df1a16fa0.
/// @param digest The digest of the message.
event TransferSent(bytes32 indexed digest);
```

2. **Rate Limit**

A transfer can be rate-limited (see [here](../README.md#rate-limiting-and-cancel-flows) for more details) both on the source and destination chains. If a transfer is rate-limited on the source chain and the `shouldQueue` flag is enabled, it is added to an outbound queue. The transfer can be released after the configured `_rateLimitDuration` has expired via the [`completeOutboundQueuedTransfer`] method. The `OutboundTransferQueued` and `OutboundTransferRateLimited` events are emitted.

If the client attempts to release the transfer from the queue before the expiry of the `rateLimitDuration`, the contract reverts with a `OutboundQueuedTransferStillQueued` error.

Similarly, transfers that are rate-limited on the destination chain are added to an inbound queue. These transfers can be released from the queue via the [`completeInboundQueuedTransfer`] method. The `InboundTransferQueued` event is emitted.

If the client attempts to release the transfer from the queue before the expiry of the `rateLimitDuration`, the contract reverts with a `InboundQueuedTransferStillQueued` error.

To disable the rate-limiter, set `_rateLimitDuration` to 0 and enable the `_skipRateLimiting` field in the `NttManager` constructor. Configuring this incorrectly will throw an error.
If the rate-limiter is disabled, the inbound and outbound rate-limits can be set to 0.

_Events_

```solidity
/// @notice Emitted whenn an outbound transfer is queued.
/// @dev Topic0
///      0x69add1952a6a6b9cb86f04d05f0cb605cbb469a50ae916139d34495a9991481f.
/// @param queueSequence The location of the transfer in the queue.
event OutboundTransferQueued(uint64 queueSequence);
```

```solidity
/// @notice Emitted when an outbound transfer is rate limited.
/// @dev Topic0
///      0x754d657d1363ee47d967b415652b739bfe96d5729ccf2f26625dcdbc147db68b.
/// @param sender The initial sender of the transfer.
/// @param amount The amount to be transferred.
/// @param currentCapacity The capacity left for transfers within the 24-hour window.
event OutboundTransferRateLimited(
    address indexed sender, uint64 sequence, uint256 amount, uint256 currentCapacity
);
```

```solidity
/// @notice Emitted when an inbound transfer is queued
/// @dev Topic0
///      0x7f63c9251d82a933210c2b6d0b0f116252c3c116788120e64e8e8215df6f3162.
/// @param digest The digest of the message.
event InboundTransferQueued(bytes32 digest);
```

3. **Send**

Once the `NttManager` forwards the message to the Transceiver, the message is transmitted via the [`sendMessage`] method. The method signature is enforced by the Transceiver but transceivers are free to determine their own implementation for transmitting messages. (e.g. a message routed through the Wormhole Transceiver can be sent via standard relaying, a specialized or custom relayer, or manually published via the core bridge).

Once the message has been transmitted, the contract emits the `SendTransceiverMessage` event.

_Events_

```solidity
/// @notice Emitted when a message is sent from the transceiver.
/// @dev Topic0
///      0x53b3e029c5ead7bffc739118953883859d30b1aaa086e0dca4d0a1c99cd9c3f5.
/// @param recipientChain The chain ID of the recipient.
/// @param message The message.
event SendTransceiverMessage(
    uint16 recipientChain, TransceiverStructs.TransceiverMessage message
);
```

4. **Receive**

Once a message has been emitted by a Transceiver on the source chain, an off-chain process (e.g. a relayer) will forward the message to the corresponding Transceiver on the recipient chain. The relayer interacts with the Transceiver via an entrypoint for receiving messages. For example, the relayer will call the [`receiveWormholeMessage`] method on the `WormholeTransceiver` contract to execute the message. The `ReceiveRelayedMessage` event is emitted during this process.

This method should also forward the message to the `NttManager` on the destination chain.
Note that the the Transceiver interface does not declare a signature for this method because receiving messages is specific to each Transceiver, and a one-size-fits-all solution would be overly restrictive.

The `NttManager` contract allows an _M_ of _N_ threshold for Transceiver attestations to determine whether a message can be safely executed. For example, if the threshold requirement is 1, the message will be executed after a single Transceiver delivers a valid attestation. If the threshold requirement is 2, the message will only be executed after two Transceivers deliver valid attestations. When a message is attested to by a Transceiver, the contract emits the `MessageAttestedTo` event.

NTT implements replay protection, so if a given Transceiver attempts to deliver a message attestation twice, the contract reverts with `TransceiverAlreadyAttestedToMessage` error. NTT also implements replay protection against re-executing messages. This check also acts as reentrancy protection as well.

If a message had already been executed, the contract ends execution early and emits the `MessageAlreadyExecuted` event instead of reverting via an error. This mitigates the possibility of race conditions from transceivers attempting to deliver the same message when the threshold is less than the total number of available of Transceivers (i.e. threshold < totalTransceivers) and notifies the client (off-chain process) so they don't attempt redundant message delivery.

_Events_

```solidity
/// @notice Emitted when a relayed message is received.
/// @dev Topic0
///      0xf557dbbb087662f52c815f6c7ee350628a37a51eae9608ff840d996b65f87475
/// @param digest The digest of the message.
/// @param emitterChainId The chain ID of the emitter.
/// @param emitterAddress The address of the emitter.
event ReceivedRelayedMessage(bytes32 digest, uint16 emitterChainId, bytes32 emitterAddress);
```

```solidity
/// @notice Emitted when a message is received.
/// @dev Topic0
///     0xf6fc529540981400dc64edf649eb5e2e0eb5812a27f8c81bac2c1d317e71a5f0.
/// @param digest The digest of the message.
/// @param emitterChainId The chain ID of the emitter.
/// @param emitterAddress The address of the emitter.
/// @param sequence The sequence of the message.
event ReceivedMessage(
    bytes32 digest, uint16 emitterChainId, bytes32 emitterAddress, uint64 sequence
);
```

```solidity
/// @notice Emitted when a message has already been executed to
///         notify client of against retries.
/// @dev Topic0
///      0x4069dff8c9df7e38d2867c0910bd96fd61787695e5380281148c04932d02bef2.
/// @param sourceNttManager The address of the source nttManager.
/// @param msgHash The keccak-256 hash of the message.
event MessageAlreadyExecuted(bytes32 indexed sourceNttManager, bytes32 indexed msgHash);
```

6. **Mint or Unlock**

Once a transfer has been successfully verified, the tokens can be minted (if the mode is "burning") or unlocked (if the mode is "locking") to the recipient on the destination chain. Note that the source token decimals are bounded between 0 and `TRIMMED_DECIMALS` as enforced in the wire format. The transfer amount is untrimmed (scaled-up) if the destination chain token decimals exceed `TRIMMED_DECIMALS`. Once the appropriate number of tokens have been minted or unlocked to the recipient, the `TransferRedeemed` event is emitted.

_Events_

```solidity
/// @notice Emitted when a transfer has been redeemed
///         (either minted or unlocked on the recipient chain).
/// @dev Topic0
///      0x504e6efe18ab9eed10dc6501a417f5b12a2f7f2b1593aed9b89f9bce3cf29a91.
/// @param digest The digest of the message.
event TransferRedeemed(bytes32 indexed digest);
```

## Prerequisites

### Installation

Install Foundry tools(https://book.getfoundry.sh/getting-started/installation), which include forge, anvil and cast CLI tools.

### Build

Run the following command to install necessary dependencies and to build the smart contracts:

```shell
$ make build
```

### Test

To run the full evm test-suite run the following command:

```shell
$ make test
```

The test-suite includes unit tests, along with property-based fuzz tests, and integration-tests.

### Format

To check for format errors run the following command:

```shell
$ make lint
```

To format the files run the following command:

```shell
$ make fix-lint
```

### Gas Snapshots

```shell
$ cd evm && forge snapshot
```

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```

## Message Customization

See the [NttManager](../docs/NttManager.md) doc for wire format details.

> Note: The size of `NttManager` is significantly higher (and very close to the contract size limit) than `NttManagerNoRateLimiting`. See [No-Rate-Limiting](#no-rate-limiting) for more detail.

### NativeTokenTransfer Additional Payload

Your contract can extend `NttManagerNoRateLimiting` to provide an additional payload on the `NativeTokenTransfer` message. Override the following:

- `_prepareNativeTokenTransfer`
- `_handleAdditionalPayload`

Be sure to review the code to ensure that they are called at an appropriate place in the flow for your use case.

> Note: This is _not_ supported when RateLimiting is enabled, as this implementation does not propagate the additional payloads on queued messages. Use either with `NttManager` when `_rateLimitDuration` is set to `0` and `_skipRateLimiting` is set to `true` in the constructor or with `NttManagerNoRateLimiting`.

### Custom Manager Payloads

`NttManager` (or `NttManagerNoRateLimiting`) can also be extended to exchange other kinds of custom messages. To send custom messages, create a new public function and roughly follow the steps in `_transfer`. What exactly you need to do will vary on your use case, but in order to leverage the existing transceivers, you will roughly need to

- call `_prepareForTransfer`
- construct and encode your payload
- construct the `NttManagerMessage` payload
- call `_sendMessageToTransceivers`

On the receiving side, override `_handleMsg` and adjust its code based on your custom payload prefixes, defaulting to `_handleTransfer`.

## Deploy Wormhole NTT

### Environment Setup

Note: **All Chain IDs set in the deployment environment files and configuration files should be the Wormhole Chain ID**

Copy the sample environment file located in `env/` into the target subdirectory of your choice (e.g., `testnet` or `mainnet`) and prefix the filename with your blockchain of choice:

```
mkdir env/testnet
cp env/.env.sample env/testnet/sepolia.env
```

Do this for each blockchain network that the `NTTManager` and `WormholeTransceiver` contracts will be deployed to. Then configure each `.env` file and set the `RPC` variables.

Currently the `MAX_OUTBOUND_LIMIT` is set to zero in the sample `.env` file. This means that all outbound transfers will be queued by the rate limiter.

### Config Setup

Before deploying the contracts, navigate to the `evm/cfg` directory and copy the sample file. Make sure to preserve the existing name:

```
cd cfg

cp WormholeNttConfig.json.sample WormholeNttConfig.json
```

Configure each network to your liking (including adding/removing networks). We will eventually add the addresses of the deployed contracts to this file. Navigate back to the `evm` directory.

---

⚠️ **WARNING:** Ensure that if the `NttManager` on the source chain is configured to be in `LOCKING` mode, the corresponding `NttManager`s on the target chains are configured to be in `BURNING` mode. If not, transfers will NOT go through and user funds may be lost! Proceed with caution!

---

Currently the per-chain `inBoundLimit` is set to zero by default. This means all inbound transfers will be queued by the rate limiter. Set this value accordingly.

### Deploy

Deploy the `NttManager` and `WormholeTransceiver` contracts by running the following command for each target network:

```
bash sh/deploy_wormhole_ntt.sh -n NETWORK_TYPE -c CHAIN_NAME -k PRIVATE_KEY
```

```
# Argument examples
-n testnet, mainnet
-c avalanche, ethereum, sepolia
```

Save the deployed proxy contract addresses (see the forge script output) in the `WormholeNttConfig.json` file.

### Configuration

Once all of the contracts have been deployed and the addresses have been saved, run the following command for each target network:

```
bash sh/configure_wormhole_ntt.sh -n NETWORK_TYPE -c CHAIN_NAME -k PRIVATE_KEY
```

```
# Argument examples
-n testnet, mainnet
-c avalanche, ethereum, sepolia
```

### Additional Notes

Tokens powered by NTT in **burn** mode require the `burn` method to be present. This method is not present in the standard ERC20 interface, but is found in the `ERC20Burnable` interface.

The `mint` and `setMinter` methods found in the [`INttToken` Interface](src/interfaces/INttToken.sol) are not found in the standard `ERC20` interface.

#### No-Rate-Limiting

Although the rate limiting feature can be disabled during contract instantiation, it still occupies code space in the `NttManager` contract. If you wish to free up code space for custom development, you can instead instantiate the
`NttManagerNoRateLimiting` contract. This contract is built without the bulk of the rate limiting code. Note that the current immutable checks do not allow modifying the rate-limiting parameters during migration. This means migrating
from an instance of `NttManager` with rate-limiting enabled to `NttManagerNoRateLimiting` or vice versa is not officially supported.
