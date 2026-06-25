# `ntt xrpl` commands

XRP Ledger commands used when preparing an NTT deployment on XRPL. XRPL has no
smart contracts, so NTT relies on a Guardian-controlled custody model. These commands cover (1)
creating/configuring the underlying XRPL token, (2) setting up the custody
account and handing it off to the manager-set multisig, and (3) operating a live
deployment (emitter derivation, VAA decoding, relaying).

Most are **pure, single-purpose** commands — each submits one XRPL transaction.
Shared plumbing lives in [`../../xrpl/helpers.ts`](../../xrpl/helpers.ts), the
onboarding payload encoding in [`../../xrpl/onboarding.ts`](../../xrpl/onboarding.ts),
and the manager-set fetch in [`../../xrpl/manager-set.ts`](../../xrpl/manager-set.ts).
The operational commands add emitter/token-id derivation
([`tokenId.ts`](../../xrpl/tokenId.ts)), VAA/payload decoding
([`payloads.ts`](../../xrpl/payloads.ts)), and the Executor/guardian clients +
request layouts ([`executor.ts`](../../xrpl/executor.ts),
[`guardian.ts`](../../xrpl/guardian.ts),
[`executorLayouts.ts`](../../xrpl/executorLayouts.ts)).

## Commands

**Token setup**

| Command           | Signed by | XRPL transaction               | Purpose                                          |
| ----------------- | --------- | ------------------------------ | ------------------------------------------------ |
| `enable-rippling` | issuer    | `AccountSet(asfDefaultRipple)` | Enable DefaultRipple on an IOU issuer account    |
| `trust-set`       | holder    | `TrustSet`                     | Open a trust line so a holder can receive an IOU |
| `create-mpt`      | issuer    | `MPTokenIssuanceCreate`        | Create a Multi-Purpose Token issuance            |
| `authorize-mpt`   | holder    | `MPTokenAuthorize`             | Opt a holder into an MPT                         |

"Creating" an IOU is just `enable-rippling` (issuer) + `trust-set` (each holder).
An MPT is `create-mpt` (issuer) + `authorize-mpt` (each holder).

**Custody-account setup** — run in order, while you still hold the account's key:

| Command           | Signed by       | XRPL transaction                  | Purpose                                                       |
| ----------------- | --------------- | --------------------------------- | ------------------------------------------------------------- |
| `set-manager`     | —               | _(none — writes deployment.json)_ | Record the custody account so later commands don't re-pass it |
| `set-token`       | —               | _(none — writes deployment.json)_ | Record the NTT token address + decimals                       |
| `fund`            | source / faucet | `Payment` / faucet                | Fund the account for a signer list + tickets                  |
| `reserve-tickets` | custody         | `TicketCreate`                    | Pre-allocate tickets                                          |
| `init`            | custody         | `Payment` + onboarding memo       | Onboard the account to the Wormhole Core                      |
| `set-signer-list` | custody         | `SignerListSet`                   | Hand off to the manager-set multisig (**irreversible-ish**)   |

**Operational** — once a deployment is live:

| Command         | Connects           | Purpose                                                                |
| --------------- | ------------------ | ---------------------------------------------------------------------- |
| `emitter`       | — _(offline)_      | Compute the XRPL transceiver emitter address for a manager + token     |
| `parse-vaa`     | — _(offline)_      | Decode an XRPL-Wormhole VAA or payload (XREL/XRFL/XADM/onboarding/NTT) |
| `relay`         | relayer + Executor | Relay a VAA emitted by an XRPL tx to its destination via the Executor  |
| `register-peer` | admin              | Register an NTT peer for the custody account (`XADM` RegisterPeer)     |
| `rotate-admin`  | admin              | Rotate the custody account's admin (`XADM` RotateAdmin)                |

`register-peer` and `rotate-admin` publish an `XADM` core message the same way as
`init` — a `Payment` to the Wormhole Core account carrying an
`application/x-wormhole-publish` memo — signed by the account's **admin**.

### `enable-rippling`

Sets the `asfDefaultRipple` flag on the issuer account so balances of its IOU can
ripple between trust lines — a prerequisite for the issuer's currency to be
usable. Signed by the **issuer**.

- `--issuer-seed` (or env `ISSUER_SEED`)

```
ntt xrpl enable-rippling -n Testnet --issuer-seed sEd7...
```

### `trust-set`

Opens a trust line from a **holder** to an issuer for a given currency, letting
that holder receive and hold the IOU up to `--limit`. Signed by the holder that
wants to receive the tokens.

- `--currency` — 3-char ASCII or 40-char hex code
- `--issuer` — issuer account address
- `--limit` — max amount the holder will hold
- `--seed` (or env `SEED`)

```
ntt xrpl trust-set -n Testnet --currency FOO --issuer r9qA... --limit 1000000 --seed sEd7...
```

### `create-mpt`

Creates a Multi-Purpose Token issuance and prints the resulting
`mpt_issuance_id` (needed for `authorize-mpt` and transfers). Signed by the
**issuer**. Parameters are validated client-side before submission.

- `--issuer-seed` (or env `ISSUER_SEED`)
- `--asset-scale` — decimal places, `0`–`255` (default `0`)
- `--max-amount` — `MaximumAmount`, a UInt64 (`≤ 2^63-1`); omitted = protocol max
- `--transfer-fee` — secondary-sale fee in tenths of a basis point, `0`–`50000`
  (`50000` = 50%); requires the `tfMPTCanTransfer` flag
- `--flags` — comma-separated MPT flags or a raw integer. Valid names:
  `tfMPTCanLock`, `tfMPTRequireAuth`, `tfMPTCanEscrow`, `tfMPTCanTrade`,
  `tfMPTCanTransfer`, `tfMPTCanClawback`
- `--metadata-json` — inline JSON or a path to a `.json` file (hex-encoded into
  `MPTokenMetadata`; `≤ 1024` bytes; see XLS-89 for the recommended schema)

```
ntt xrpl create-mpt -n Testnet --asset-scale 9 --max-amount 10000000000000 \
  --flags tfMPTCanTransfer --issuer-seed sEd7...
```

### `authorize-mpt`

A **holder** opts into an MPT so they can hold it. Signed by the account that
wants to receive the issuer's MPT.

- `--mpt-id` — MPT issuance ID (48-char hex, from `create-mpt`)
- `--seed` (or env `SEED`)

```
ntt xrpl authorize-mpt -n Testnet --mpt-id 00EE5E8C... --seed sEd7...
```

### `set-manager`

Records the chosen custody account in the deployment file (`xrpl.manager`) so the
other custody commands can default `--account` to it. No XRPL transaction.

- `--account` (required) — custody r-address
- `--path` — deployment file (default `deployment.json`)

```
ntt xrpl set-manager --account r9qA...
```

### `set-token`

Records the deployment's NTT token in the deployment file (`xrpl.token` +
`xrpl.decimals`). Native XRP is recorded as `"native"`; IOU/MPT identifiers are
validated and normalized with the Wormhole SDK's XRPL address conventions
(`XrplAddress` from `@wormhole-foundation/sdk-xrpl`). No XRPL transaction.

- `--token` (required) — `native` for native XRP, an IOU `CODE.rIssuer`, or a
  48-char hex MPT issuance id
- `--decimals` (required) — token decimals on XRPL (e.g. `6` for XRP), `0`–`255`
- `--path` — deployment file (default `deployment.json`)

```
ntt xrpl set-token --token native --decimals 6                                  # native XRP
ntt xrpl set-token --token FOO.rBa2jdUu8S2ZzaCJv8y1Lx9Pdrns51hJj --decimals 9   # IOU
ntt xrpl set-token --token 00EE5E8C9F... --decimals 9                           # MPT
```

### `fund`

Funds the custody account with enough XRP to cover the reserve for a signer list
plus tickets. The default `--amount` is computed from the ledger's live reserve
settings: `base + inc × (tickets + 1) + buffer`.

- `--account` — target (defaults to `xrpl.manager`)
- `--amount` — XRP to fund (default: computed)
- `--tickets` — ticket count to size the reserve for (default 200)
- `--faucet` — use the testnet/devnet faucet to fund `--account` directly
- `--from-seed` (env `FUNDER_SEED`) — funding source for a `Payment` (any network)

```
ntt xrpl fund -n Testnet --account r9qA... --faucet                         # faucet
ntt xrpl fund -n Mainnet --account r9qA... --amount 50 --from-seed sEd7...  # payment
```

### `reserve-tickets`

Pre-allocates tickets on the custody account (`TicketCreate`), signed by the
creator before hand-off. Tickets decouple Guardian signing from sequence order.

- `--count` — number of tickets, `1`–`250` (default 200)
- `--issuer-seed` (or env `ISSUER_SEED`)

```
ntt xrpl reserve-tickets -n Testnet --count 200 --issuer-seed sEd7...
```

### `init`

Sends the `XRPLAppOnboarding` message — a `Payment` to the Wormhole Core (GMP)
account carrying an onboarding memo — so the Guardians start watching the custody
account. Signed by the **custody account** being onboarded (`--issuer-seed`).

The memo carries: prefix `"XRPL"`, the `--admin` account, the app type (always
`"NTT"` — this tool doesn't onboard WTT/CORE — left-padded to 32 bytes), the
ticket range (`--initial-ticket` / `--ticket-count`), and the token `init_data`
(decimals + token identifier) selected via `--token`:

| `--token` | extra args                                                | `init_data` tail                                                            |
| --------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `xrp`     | `--decimals` (6)                                          | `<decimals>` (short form)                                                   |
| `iou`     | `--decimals`, `--currency` (3-char or 40-hex), `--issuer` | `<decimals>` + `0x01` + currency[20] + issuer[20], right-padded to 42 bytes |
| `mpt`     | `--decimals`, `--mpt-id` (48-hex)                         | `<decimals>` + `0x02` + mpt_id[24], right-padded to 42 bytes                |

Other options:

- `--core-account` — destination Wormhole Core account. Defaults to the
  per-network account (Testnet only for now); required on networks without a
  configured default.
- `--amount` — XRP sent with the message (default `0.000001`)
- `--issuer-seed` (or env `ISSUER_SEED`)

```
# XRP custody account
ntt xrpl init -n Testnet --admin r9qA... --initial-ticket 100 --ticket-count 150 \
  --token xrp --issuer-seed sEd7...

# MPT custody account
ntt xrpl init -n Testnet --admin r9qA... --initial-ticket 100 --ticket-count 150 \
  --token mpt --decimals 9 --mpt-id 00EE5E8C... --issuer-seed sEd7...
```

The memo uses `MemoFormat: application/x-wormhole-publish` and
`MemoData = 01 + 00000000 + payload`.

### `set-signer-list`

Replaces single-key control with the manager-set multisig (`SignerListSet`). The
signer set is either fetched from the delegated-manager-set EVM contract or given
explicitly. **This is the hand-off** — it prompts for confirmation unless `--yes`.
(The master key stays enabled until disabled separately.)

Fetch from EVM — the quorum is the manager-set threshold (not overridable):

- `--manager-chain-id` (default 66), `--manager-set-index` (default `latest`,
  resolved on-chain), `--rpc-eth`, `--delegated-manager-set-addr`

Explicit signers:

- `--signers` — comma-separated r-addresses; `--quorum` (required)

Common: `--issuer-seed` (or env `ISSUER_SEED`), `--yes`.

```
# from the latest manager set on an EVM chain
ntt xrpl set-signer-list -n Testnet \
  --rpc-eth https://... --delegated-manager-set-addr 0x... --issuer-seed sEd7...

# explicit signers
ntt xrpl set-signer-list -n Testnet --signers r1,r2,r3 --quorum 2 --issuer-seed sEd7...
```

### `emitter`

Computes an XRPL emitter address for a custody account. Offline (no XRPL/RPC
connection). Two kinds, selected with `--kind` (default `transceiver`):

- `transceiver` — the Wormhole NTT transceiver emitter,
  `keccak256("ntt" + manager[32] + tokenId[32])`. Use the printed `0x…` value
  with `ntt manual set-transceiver-peer`. Requires `--token`.
- `generated` — the emitter the watcher uses for the account's automated
  messages (acks such as XACK/XTCF): `"XRPL"[4] + 00×8 + account[20]`. This
  namespace is distinct from a core publish (`00×12 + account`), so such
  messages can't be forged through the core bridge. Useful for looking the
  resulting VAA up by `(chain, emitter, sequence)`. `--token` is ignored.

- `--manager` (required) — custody account (r-address or 20-byte hex)
- `--kind` — `transceiver` (default) | `generated`
- `--token` — `xrp` | `iou` | `mpt` (required for `--kind transceiver`)
- `--currency`, `--issuer` [`--token iou`]; `--mpt-id` [`--token mpt`]

```
ntt xrpl emitter --manager rfeMQr71KJQwNUbRwGTgCfVLoUVdWuvyny --token xrp
ntt xrpl emitter --manager rnv8... --token iou --currency FOO --issuer rnv8...
ntt xrpl emitter --manager rfeMQr71KJQwNUbRwGTgCfVLoUVdWuvyny --kind generated
```

### `parse-vaa`

Decodes an XRPL-Wormhole VAA envelope and its inner payload (XREL release, XRFL
ticket-refill, XADM admin, XRPL onboarding, or a wrapped NTT transfer). Offline.

- `<vaa>` (positional) — hex bytes, with or without `0x`
- `--payload-only` — treat the input as a bare payload instead of a full VAA

```
ntt xrpl parse-vaa 01000000...                 # full VAA + payload
ntt xrpl parse-vaa 5852504c... --payload-only  # bare payload
```

### `relay`

Relays a VAA emitted by an XRPL transaction to its destination via the w7
Executor: looks up the tx → derives emitter/sequence → polls the guardian for the
signed VAA → fetches an Executor quote → submits a `Payment` to the Executor
carrying an `application/x-executor-request` memo → triggers indexing. Signed by
the relaying account (`--seed`).

- `--tx-hash` (required) — XRPL tx that emitted the VAA
- `--dst-chain` (required) — destination chain (name or id)
- `--request-type` — `ern1` (NTT transfer) or `erv1` (onboarding / register-peer)
- `--dst-addr` — destination address (hex32; recipient NTT manager for `ern1`)
- `--src-manager` / `--manager` — source NTT manager emitter (hex32), or derive it
  from the manager r-address/hex
- `--token` (+ `--currency`/`--issuer`/`--mpt-id`) — defaults to the token inferred
  from the tx's delivered amount
- `--executor` (required) — Executor XRPL address to pay
- `--executor-api`, `--guardian-api` — API base URLs. Default to the per-network
  values (Testnet only for now); required on networks without a configured default.
- `--gas-limit`, `--msg-value`, `--relay-instructions` — relay sizing
- `--poll-interval`, `--poll-timeout` — VAA polling (ms)
- `--seed` (or env `SEED`)

```
ntt xrpl relay -n Testnet --tx-hash <hash> --dst-chain Solana --executor r… \
  --request-type ern1 --src-manager 0x… --dst-addr 0x… --seed sEd7...
```

### `register-peer`

Registers an NTT peer (a transceiver emitter on another chain) for the custody
account by publishing an `XADM` RegisterPeer (`0x01`) core message. Signed by the
**admin** (`--admin-seed`).

- `--manager` — custody account (default: `xrpl.manager` from the deployment file)
- `--peer-chain` (required) — peer chain (Wormhole name or numeric id)
- `--peer-address` (required) — peer transceiver emitter, 32-byte hex
- `--core-account` — Wormhole Core account (default: the testnet account)
- `--amount` — XRP sent with the message (default `0.000001`)
- `--admin-seed` (or env `ADMIN_SEED`)

```
ntt xrpl register-peer -n Testnet --peer-chain Solana --peer-address 0x… --admin-seed sEd7...
```

### `rotate-admin`

Rotates the custody account's admin by publishing an `XADM` RotateAdmin (`0x02`)
core message. Signed by the **current admin** (`--admin-seed`).

- `--manager` — custody account (default: `xrpl.manager` from the deployment file)
- `--new-admin` (required) — new admin r-address
- `--core-account`, `--amount` — as for `register-peer`
- `--admin-seed` (or env `ADMIN_SEED`); `--yes`

```
ntt xrpl rotate-admin -n Testnet --new-admin r9qA... --admin-seed sEd7...
```

## deployment.json

`set-manager` records the custody account in a dedicated top-level `xrpl` section
(kept out of `chains`, which expects a full NTT config):

```json
{
  "network": "Testnet",
  "chains": { … },
  "xrpl": { "manager": "r9qA...", "token": "native", "decimals": 6 }
}
```

`fund`, `reserve-tickets`, and `set-signer-list` read `xrpl.manager` as the
default account when `--account` is omitted. `set-token` records the optional
`token` and `decimals` — the token (`"native"` for native XRP, an IOU
`CODE.rIssuer`, or a 48-char hex MPT issuance id) and its decimals on XRPL.

## Common options

Every subcommand accepts:

- `-n, --network` (required) — `Mainnet` | `Testnet` | `Devnet`. Selects a default
  public XRPL WebSocket endpoint.
- `--rpc` — override the endpoint. Resolution order: `--rpc` > `overrides.json`
  (`chains.Xrpl.rpc`) > the network default.
- `--algorithm` — `ed25519` | `secp256k1`. Forces the key algorithm used to derive
  the wallet from the seed (default: xrpl auto-detects from the seed prefix).

## Seeds

Seeds are read from the flag, falling back to an environment variable so they
need not appear in shell history:

- Issuer/custody-creator commands (`enable-rippling`, `create-mpt`,
  `reserve-tickets`, `init`, `set-signer-list`) → `--issuer-seed` / `ISSUER_SEED`.
- Holder & operational commands (`trust-set`, `authorize-mpt`, `relay`) →
  `--seed` / `SEED`.
- Admin commands (`register-peer`, `rotate-admin`) → `--admin-seed` / `ADMIN_SEED`.
- `fund`'s `Payment` source → `--from-seed` / `FUNDER_SEED`.
- `set-manager` takes no seed — just `--account`.
