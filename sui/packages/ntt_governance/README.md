# NTT Governance for Sui

Wormhole governance contract that receives guardian-signed VAAs and executes
admin operations on NTT via the existing `AdminCap` interface. Deployed as a
separate package that stores the NTT `AdminCap` and `UpgradeCap`.

## Why one governance per NTT

On EVM, a single governance contract uses `call(callData)` to invoke arbitrary
functions on any governed contract — one governance instance governs many
contracts. On Solana, `invoke_signed()` provides similar capability via CPI.

Sui intentionally prohibits dynamic dispatch. Every cross-module call must be
resolved at compile time with explicit type parameters and module paths. Since
each NTT deployment is a separate package with its own `State<T>`, the
governance package must import a specific `ntt` package at compile time. There
is no way to write a generic governance contract that works with arbitrary NTT
deployments. Each NTT deployment requires its own governance package.

## VAA wire format

This contract uses the `GeneralPurposeGovernance` module identifier, shared
with the EVM and Solana governance contracts. The Wormhole governance packet
standard defines the envelope; the payload is platform-specific.

```
Envelope (handled by governance_message):
  MODULE  (32 bytes, "GeneralPurposeGovernance" left-padded)
  ACTION  (1 byte,  SUI_CALL = 3)
  CHAIN   (2 bytes, Sui chain ID)

Payload (parsed by this module):
  GOVERNANCE_ID (32 bytes) | NTT_ACTION (1 byte) | ACTION_DATA (variable)
```

The governance action indices across runtimes:

| Action      | Value | Runtime |
| ----------- | ----- | ------- |
| UNDEFINED   | 0     | —       |
| EVM_CALL    | 1     | EVM     |
| SOLANA_CALL | 2     | Solana  |
| SUI_CALL    | 3     | Sui     |

Each runtime only accepts its own action index. The `NTT_ACTION` byte in the
payload identifies the specific NTT admin operation (1-11, see table below).

## VAA verification flow

The verification flow in `verify_and_consume`:

1. Create a `DecreeTicket` with module `GeneralPurposeGovernance` and action `SUI_CALL`
2. Call `governance_message::verify_vaa` — checks guardian signatures, emitter
   chain, emitter contract, module name, and action
3. Call `governance_message::take_payload` — consumes the VAA digest into
   `ConsumedVAAs` for replay protection and returns the inner payload
4. Parse the payload: strip the 32-byte `GOVERNANCE_ID` (asserting it matches
   this `GovernanceState` object's ID) and extract the `NTT_ACTION` byte
5. Return a `GovernanceDecree` hot-potato with the NTT action and remaining payload

## GovernanceDecree hot-potato

`GovernanceDecree` has no `drop` ability — it must be consumed by an
`execute_*` function in the same transaction. Each `execute_*` function
destructures the decree, asserts the action ID matches, and parses the
action-specific payload.

The alternative design — a single `execute` function that calls
`verify_and_dispatch` inline — would make payload parsing untestable without
constructing guardian-signed VAAs in tests. By separating verification from
dispatch, the `new_decree` test helper can construct decrees directly, letting
tests exercise all 11 payload parsers and their edge cases (truncation,
trailing bytes, type mismatches) without VAA infrastructure.

The hot-potato pattern preserves the same security guarantee: a decree
can only be created by `verify_and_consume` (in production) and must be
consumed in the same transaction.

## GovernanceState singleton

`GovernanceState` is created by `init()`, which runs exactly once at package
publish and creates a shared object with its own `ConsumedVAAs` set.

If the constructor were public, anyone could create additional
`GovernanceState` instances. Each instance would have its own independent
`ConsumedVAAs`, allowing the same VAA to be replayed against multiple
instances. The `init()`-only pattern ensures exactly one instance exists per
package deployment.

## Capability storage

Capabilities (`AdminCap`, `UpgradeCap`) are stored as dynamic object fields
rather than direct struct fields.

Direct struct fields would wrap the capabilities inside `GovernanceState`,
removing them from the top-level object store. This makes them invisible to
off-chain tools (explorers, indexers) and prevents `transfer::public_receive`
from working — they can't be transferred out without a custom extraction
function.

Dynamic object fields preserve each capability's identity as a top-level
object. This means:

- Off-chain tools can discover which caps a governance instance holds
- Capabilities can be extracted with `ofield::remove` and transferred via
  `transfer::public_transfer` for ownership handoff
- The standard `Receiving<T>` / `public_receive` pattern works for ingestion

## Deployment flow

```
1. sui client publish  →  init() creates shared GovernanceState
2. sui client transfer-object AdminCap     --to <GovernanceState address>
   sui client transfer-object UpgradeCap   --to <GovernanceState address>
3. PTB: governance::receive_admin_cap(gov, admin_receiving)
        governance::receive_upgrade_cap(gov, upgrade_receiving)
```

The `receive_admin_cap` / `receive_upgrade_cap` functions are permissionless —
anyone can call them. This is safe because the capability must already have
been transferred to the `GovernanceState`'s address; `public_receive` enforces
this. A governance instance without caps is inert: action handlers abort with
`EFieldDoesNotExist` from dynamic object field access until caps are received.

`receive_upgrade_cap` does not perform an explicit runtime package check. The
type system already guarantees correctness: `ntt::upgrades::UpgradeCap` is
bound to the specific NTT package at compile time, `public_receive` enforces
exact type matching (package ID is part of the type identity), and
`ntt::upgrades::new_upgrade_cap` validates the inner `sui::package::UpgradeCap`
via `assert_package_upgrade_cap` at creation time.

After receiving caps, all admin operations require a guardian-signed VAA.

## Ownership transfer (governance handoff)

To migrate from governance A to governance B (e.g., upgrading the governance
contract itself):

```
Tx 1: Publish new governance package → creates GovernanceState B
Tx 2: VAA → verify_and_consume(gov_a) → execute_transfer_ownership(gov_a, decree)
       (caps are transferred to gov_b's address)
Tx 3: governance_b::receive_admin_cap(gov_b, ...)
       governance_b::receive_upgrade_cap(gov_b, ...)
```

After tx 2, governance A is inert (no caps). After tx 3, governance B controls
the NTT deployment.

WARNING: `execute_transfer_ownership` sends caps to the raw address in the VAA
payload with no on-chain validation. An incorrect address permanently loses
admin control. Operators must verify the address in the governance proposal.

**Partial receive before transfer:** If a capability has been transferred to
GovA's address but `receive_*` has not been called when
`execute_transfer_ownership` fires, GovA only transfers the caps it has stored
as dynamic object fields. The unreceived cap remains owned by GovA's address.
This is recoverable: `receive_*` is permissionless, so the unreceived cap can
be accepted after the fact, then a second governance VAA can transfer it.
Operators should still ensure both caps are received before initiating
ownership transfer to avoid the extra governance round-trip.

## Upgrade flow

NTT package upgrades use a two-phase hot-potato pattern matching Wormhole's
own upgrade mechanism:

```
PTB:
  1. vaa::parse_and_verify(wh_state, vaa_bytes, clock)  →  VAA
  2. governance::verify_and_consume(gov, wh_state, vaa)  →  GovernanceDecree
  3. governance::execute_authorize_upgrade(gov, decree)   →  UpgradeTicket
  4. sui::package::upgrade(ticket, modules, deps, policy) →  UpgradeReceipt
  5. governance::execute_commit_upgrade<T>(gov, ntt_state, receipt)
```

Steps 3-5 must occur in a single PTB. The `UpgradeTicket` and
`UpgradeReceipt` are hot-potatoes that enforce this. `execute_commit_upgrade`
does not require a separate VAA — authorisation was established in step 3.

## NTT actions (payload-level)

The `NTT_ACTION` byte in the payload identifies the specific operation.
`ACTION_DATA` format depends on the action:

| #   | Action              | ACTION_DATA                                                                         |
| --- | ------------------- | ----------------------------------------------------------------------------------- |
| 1   | SetPeer             | `chain_id (u16) \| peer_address (32) \| token_decimals (u8) \| inbound_limit (u64)` |
| 2   | SetThreshold        | `threshold (u8)`                                                                    |
| 3   | SetOutboundLimit    | `limit (u64)`                                                                       |
| 4   | SetInboundLimit     | `chain_id (u16) \| limit (u64)`                                                     |
| 5   | Pause               | _(empty)_                                                                           |
| 6   | Unpause             | _(empty)_                                                                           |
| 7   | RegisterTransceiver | `state_object_id (32) \| type_name_len (u16) \| type_name (utf8)`                   |
| 8   | EnableTransceiver   | `transceiver_id (u8)`                                                               |
| 9   | DisableTransceiver  | `transceiver_id (u8)`                                                               |
| 10  | AuthorizeUpgrade    | `digest (32)`                                                                       |
| 11  | TransferOwnership   | `new_owner (32)`                                                                    |

The full payload parsed by this module is:
`GOVERNANCE_ID (32) | NTT_ACTION (1) | ACTION_DATA`. The `GOVERNANCE_ID` and
`NTT_ACTION` are stripped by `verify_and_consume` before the action-specific
data reaches `execute_*`.

## Security: governance package UpgradeCap

This package's own `sui::package::UpgradeCap` (created at publish) is NOT
stored or governed here. Whoever holds it can upgrade this module without
guardian approval — potentially modifying VAA verification, adding backdoors,
or extracting stored capabilities.

After deployment, operators MUST either:

1. Make the governance package immutable (`sui client upgrade --policy immutable`), or
2. Transfer its UpgradeCap to a trusted multisig or separate governance mechanism

Failure to secure the governance UpgradeCap undermines the entire trust model.

## Design decisions

| Decision                                               | Rationale                                                                                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Separate package (not inline in NTT)                   | Governance can be added to existing NTT deployments without upgrading NTT                                  |
| One governance per NTT                                 | Sui prohibits dynamic dispatch; governance must import specific NTT package types at compile time          |
| Hot-potato decree                                      | Separates verification from dispatch, enabling test coverage of payload parsers without VAA infrastructure |
| `init()` singleton                                     | Prevents VAA replay via duplicate instances with independent `ConsumedVAAs`                                |
| Dynamic object fields for caps                         | Preserves off-chain discoverability and enables extraction for ownership transfer                          |
| `GovernanceActionExecuted` event                       | On-chain audit trail; includes action ID and VAA digest                                                    |
| No governance over own UpgradeCap                      | Circular dependency; must be secured externally                                                            |
| `type_name::with_defining_ids` for RegisterTransceiver | Runtime type verification ensures PTB type parameter matches VAA-authorised type                           |
| `GOVERNANCE_ID` prefix in payload                      | Per-instance targeting; prevents a VAA intended for one NTT governance from being replayed against another |
