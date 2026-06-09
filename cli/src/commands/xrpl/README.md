# `ntt xrpl` commands

XRP Ledger commands used when preparing an NTT deployment on XRPL. XRPL has no
smart contracts, so NTT relies on a Guardian-controlled custody model (see
[`ripple/SPEC.md`](../../../../ripple/SPEC.md) and
[`ripple/DESIGN.md`](../../../../ripple/DESIGN.md)). These commands cover the two
prerequisites: (1) creating/configuring the underlying XRPL token, and (2)
sending the `XRPLAppOnboarding` message that registers the custody account with
the Guardians.

These are **pure, single-purpose** commands — each submits exactly one XRPL
transaction. The shared XRPL plumbing (client connection, signing,
flag/metadata parsing, validation) lives in
[`../../xrpl/helpers.ts`](../../xrpl/helpers.ts), and the onboarding payload
encoding lives in [`../../xrpl/onboarding.ts`](../../xrpl/onboarding.ts).

## Commands

| Command | Signed by | XRPL transaction | Purpose |
|---|---|---|---|
| `enable-rippling` | issuer | `AccountSet(asfDefaultRipple)` | Enable DefaultRipple on an IOU issuer account |
| `trust-set` | holder | `TrustSet` | Open a trust line so a holder can receive an IOU |
| `create-mpt` | issuer | `MPTokenIssuanceCreate` | Create a Multi-Purpose Token issuance |
| `authorize-mpt` | holder | `MPTokenAuthorize` | Opt a holder into an MPT |
| `init` | custody | `Payment` + onboarding memo | Onboard a custody account to the Wormhole Core |

"Creating" an IOU is just `enable-rippling` (issuer) + `trust-set` (each holder).
An MPT is `create-mpt` (issuer) + `authorize-mpt` (each holder). Once the token
exists, `init` registers the custody account for that token with the Guardians.

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

### `init`
Sends the `XRPLAppOnboarding` message — a `Payment` to the Wormhole Core (GMP)
account carrying an onboarding memo — so the Guardians start watching the custody
account. Signed by the **custody account** being onboarded (`--seed`).

The memo carries: prefix `"XRPL"`, the `--admin` account, the `--app` type
(left-padded to 32 bytes), the ticket range (`--initial-ticket` / `--ticket-count`),
and the token `init_data` (decimals + token identifier) selected via `--token`:

| `--token` | extra args | `init_data` tail |
|---|---|---|
| `xrp` | `--decimals` (6) | `<decimals>` (short form) |
| `iou` | `--decimals`, `--currency` (3-char or 40-hex), `--issuer` | `<decimals>` + `0x01` + currency[20] + issuer[20], right-padded to 42 bytes |
| `mpt` | `--decimals`, `--mpt-id` (48-hex) | `<decimals>` + `0x02` + mpt_id[24], right-padded to 42 bytes |

Other options:
- `--core-account` — destination Wormhole Core account (default: the testnet
  account `rpuMNy2dBzimaQHTFpXsfoCoqicgd8etQQ`; set this for other networks)
- `--amount` — XRP sent with the message (default `0.000001`)
- `--seed` (or env `SEED`)

```
# XRP custody account
ntt xrpl init -n Testnet --admin r9qA... --initial-ticket 100 --ticket-count 150 \
  --token xrp --seed sEd7...

# MPT custody account
ntt xrpl init -n Testnet --admin r9qA... --initial-ticket 100 --ticket-count 150 \
  --token mpt --decimals 9 --mpt-id 00EE5E8C... --seed sEd7...
```

The memo uses `MemoFormat: application/x-wormhole-publish` and
`MemoData = 01 + 00000000 + payload`.

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

- Issuer-signed commands (`enable-rippling`, `create-mpt`) → `--issuer-seed` /
  `ISSUER_SEED`.
- Holder-/custody-signed commands (`trust-set`, `authorize-mpt`, `init`) →
  `--seed` / `SEED`.
