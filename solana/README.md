# Solana

## Design Overview

### Message Lifecycle (Solana)

1. **Transfer**

A client calls the [transfer_lock] or [transfer_burn] instruction based on whether the program is in "locking" or "burning" mode. The program mode is set during initialization. When transferring, the client must specify the amount of the transfer, the recipient chain, the recipient address on the recipient chain, and the boolean flag `should_queue` to specify whether the transfer should be queued if it hits the outbound rate limit. If `should_queue` is set to false, the transfer reverts instead of queuing if the rate limit were to be hit.

> Using the wrong transfer instruction, i.e. [`transfer_lock`] for a program that is in "burning" mode, will result in `InvalidMode` error.

Depending on the mode and instruction, the following will be produced in the program logs:

```
Program log: Instruction: TransferLock
Program log: Instruction: TransferBurn
```

Outbound transfers are always added into an Outbox via the `insert_into_outbox` method. This method checks the transfer against the configured outbound rate limit amount to determine whether the transfer should be rate limited. An `OutboxItem` is a Solana Account which holds details of the outbound transfer. If no rate limit is hit, the transfer can be released from the Outbox immediately. If a rate limit is hit, the transfer can only be released from the Outbox after the rate limit delay duration has expired.

2. **Rate Limit**

The program checks rate limits via the `consume_or_delay` function during the transfer process. The Solana rate limiting logic is equivalent to the EVM rate limiting logic.

If the transfer amount fits within the current capacity:

- Reduce the current capacity.
- Refill the inbound capacity for the destination chain.
- Add the transfer to the outbox with `release_timestamp` set to the current timestamp, so it can be released immediately.

If the transfer amount does not fit within the current capacity:

- If `should_queue = true`, add the transfer to the outbox with `release_timestamp` set to the current timestamp plus the configured `RATE_LIMIT_DURATION`.
- If `should_queue = false`, revert with a `TransferExceedsRateLimit` error.

3. **Send**

The caller then needs to request each Transceiver to send messages via the [`release_outbound`] instruction. To execute this instruction, the caller needs to pass the account of the Outbox item to be released. The instruction will then verify that the Transceiver is one of the specified senders for the message. Transceivers then send the messages based on the verification backend they are using.

For example, the Wormhole Transceiver will send by calling [`post_message`] on the Wormhole program, so that the Wormhole Guardians can observe and verify the message.

> When `revert_on_delay` is true, the transaction will revert if the release timestamp has not been reached. When `revert_on_delay` is false, the transaction succeeds, but the outbound release is not performed.

The following will be produced in the program logs:

```
Program log: Instruction: ReleaseOutbound
```

4. **Receive**

Similar to EVM, Transceivers vary in how they receive messages, since message relaying and verification methods may differ between implementations.

The Wormhole Transceiver receives a verified Wormhole message on Solana via the [`receive_message`] entrypoint instruction. Callers can use the [`receive_wormhole_message`] Anchor library function to execute this instruction. The instruction verifies the Wormhole VAA and stores it in a `VerifiedTransceiverMessage` account.

The following will be produced in the program logs:

```
Program log: Instruction: ReceiveMessage
```

[`redeem`] checks the inbound rate limit and places the message in an Inbox. The logic works the same as the outbound rate limit we mentioned previously.

The following will be produced in the program logs:

```
Program log: Instruction: Redeem
```

5. **Mint or Unlock**

The inbound transfer is released and the tokens are unlocked or minted to the recipient (depending on the mode) through either [`release_inbound_mint`] (if the mode is `burning`) or [`release_inbound_unlock`] (if the mode is `locking`). Similar to transfer, using the wrong transfer instruction, i.e. [`release_inbound_mint`] for a program that is in "locking" mode, will result in `InvalidMode` error.

> When `revert_on_delay` is true, the transaction will revert if the release timestamp has not been reached. When `revert_on_delay` is false, the transaction succeeds, but the minting/unlocking is not performed.

Depending on the mode and instruction, the following will be produced in the program logs:

```
Program log: Instruction: ReleaseInboundMint
Program log: Instruction: ReleaseInboundUnlock
```

## Trust Model

Version 4 changes the Solana program from a single-instance model to a multi-instance model. This section describes the instances, the isolation between them, and the authorities that an operator must trust.

### Instances

In version 3, one program held one NTT deployment. The program ID was the manager identity in each message.

In version 4, one program can hold many NTT deployments. Each deployment is an _instance_. An instance is a `Config` account. The operator supplies a new keypair for this account. The operator signs the [`initialize`] instruction with this keypair. The program does not derive the `Config` account as a PDA.

The public key of the `Config` account is the manager identity of the instance. A peer on another chain registers this key as the Solana manager address. The program writes this key into each outbound message. The program checks this key on each inbound message.

Version 4 conforms to the NTT specification. The wire format does not change. The manager identity is still a 32-byte address. Therefore an operator can register a version 4 instance into an existing NTT mesh. The peers on the foreign chains do not need a contract upgrade. Each foreign chain registers the `Config` key as a new peer.

> The operator chooses the `Config` keypair. Therefore two instances in the same program are fully independent. One program can hold many tokens and many owners at the same time.

### Isolation between instances

The program keeps the state of each instance separate. Every per-instance account holds the `Config` key in its PDA seeds. This rule applies to the rate limits, the peers, the registered transceivers, the token authority, the session authority, the emitter, and the inbox items.

The program computes each address from the seeds. Therefore an account of one instance cannot take the place of an account of another instance. The program rejects a wrong account.

The program also binds each message and each inbox or outbox item to its instance:

- [`receive_message`] accepts a VAA only when the `recipient_ntt_manager` field equals the `Config` key. The program rejects a VAA that names a different instance.
- [`redeem`] checks the `transceiver_message` seeds against the `Config` key.
- [`release_inbound_mint`] and [`release_inbound_unlock`] accept an inbox item only when the stored `config` field equals the `Config` key. An inbox item from one instance cannot release funds from another instance.
- [`release_outbound`] accepts an outbox item only when the `manager` field equals the `Config` key. A transceiver of one instance cannot release an outbox item of another instance.

> These checks are necessary because two instances can manage the same token mint. Without these checks, a message or an item from one instance could move funds through another instance.

### Instance ownership and the program upgrade authority

Version 4 separates two authorities. Version 3 held these two authorities together.

The _instance owner_ is the `owner` field of the `Config` account. The owner controls one instance. The owner can set the peers, set the threshold, pause the instance, and transfer the ownership. A transfer of ownership changes the data in the `Config` account. The [`transfer_ownership`] and [`claim_ownership`] instructions do not touch the BPF loader.

The _program upgrade authority_ is the BPF loader upgrade authority of the program. This authority can replace the program code. New code applies to every instance in the program at the same time.

> In version 3, one party held both the instance ownership and the program upgrade authority. In version 4, the two are independent. An instance owner has no control over the program code. The program upgrade authority has no ownership of an instance.

### What an operator must trust

All instances in one program run the same code. Therefore the party that holds the program upgrade authority can change the behavior of every instance. This party can mint tokens, unlock custody, or stop transfers for all instances.

An operator that deploys an instance into a shared program must trust the party that holds the program upgrade authority. To reduce this trust, do one of these steps after the deployment:

- Set the program upgrade authority to `null`. The program becomes immutable.
- Give the program upgrade authority to a multisig or a governance program. All tenants must accept this party.

An instance owner does not need to trust the other instance owners. The isolation rules limit each owner to one instance.

## Message Customization

See the [NttManager](../docs/NttManager.md) doc for wire format details.

### NativeTokenTransfer Additional Payload

Modify [transfer.rs](./programs/example-native-token-transfers/src/transfer.rs) and replace the `EmptyPayload` with your own custom struct. See [ntt.rs](./modules/ntt-messages/src/ntt.rs) for an example. It is highly encouraged to use a 4-byte prefix for your payload.

The additional payload field should then have your custom struct available everywhere `NativeTokenTransfer<Payload>` is used. Due to typing, parsing, and account allocation restrictions, this implementation expects that _all_ `NativeTokenTransfer` payloads for your contract adhere to your custom struct definition.

You can then modify [release_outbound.rs](./programs/example-native-token-transfers/src/transceivers/wormhole/instructions/release_outbound.rs) and [redeem.rs](./programs/example-native-token-transfers/src/instructions/redeem.rs) to generate and process the additional payload.

## SPL Multisig Support

Using [SPL Multisig](https://docs.rs/spl-token/latest/spl_token/state/struct.Multisig.html), you can enable multiple minters on Solana. For example, this allows NTT to burn/mint tokens without being the only authority to do so, i.e. the asset issuer can also retain mint authority.

1. **Create valid SPL Multisig**

The SPL Multisig should meet the following criteria to qualify as a valid mint authority for NTT:

- Number of signers required ([m](https://docs.rs/spl-token/latest/spl_token/state/struct.Multisig.html#structfield.m)) should be `1`
- One of the [signers](https://docs.rs/spl-token/latest/spl_token/state/struct.Multisig.html#structfield.signers) must be the `token_authority` PDA

2. **Set valid SPL Multisig as mint authority**

You can set the created multisig as the mint authority via the [`accept_token_authority`] instruction.

> If the current mint authority is also an SPL Multisig, use the [`accept_token_authority_from_multisig`] instruction instead.

3. **Pass the SPL Multisig mint authority as `multisig_token_authority`**

To initialize NTT, use the [`initialize`] instruction but pass in the SPL Multisig mint authority as the `multisig_token_authority` account.

In `burning` mode, to release the inbound transfer and the mint tokens to the recipient, use the [`release_inbound_mint`] instruction but pass in the SPL Multisig mint authority as the `multisig_token_authority` account.

## Prerequisites

### Installation

Ensure that you are using the correct version of the Solana and Anchor CLI tools by consulting `Anchor.toml`.

```toml
[toolchain]
anchor_version = "0.29.0"
solana_version = "1.18.26"
```

Install the toolchain listed in `rust-toolchain`. You can verify this by running:

```sh
rustup show
```

Install [`jq`](https://jqlang.github.io/jq/) and [`tsx`](https://www.npmjs.com/package/tsx) globally as they are required by build scripts.

### Build

Run the following command to install necessary dependencies and to build the programs:

```sh
make build
```

#### Verifiable Builds

For building verifiably, make sure [`solana-verify`](https://crates.io/crates/solana-verify) is installed and Docker is installed and running.

Run the following command to build the program binaries deterministically for `mainnet`:

```sh
make artifacts-mainnet
```

> This will produce the generated artifacts in the `artifacts-mainnet` directory.

For Solana devnet builds, or local testing builds, use the following commands:

```sh
make artifacts-solana-devnet
make artifacts-tilt-devnet
```

### Test

Run the following command to generate the IDL and run the full Solana test-suite:

```sh
make test
```

The test-suite includes cargo unit tests and Anchor integration tests.

### Format

Run the following command to check for lint errors:

```sh
make lint
```

Run the following command to fix lint errors:

```sh
make fix-lint
```
