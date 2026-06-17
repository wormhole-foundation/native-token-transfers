# `ntt xrpl` commands

Low-level XRP Ledger token-setup commands used when preparing an NTT deployment
on XRPL. XRPL has no smart contracts, so NTT relies on a Guardian-controlled
custody model (see [`ripple/SPEC.md`](../../../../ripple/SPEC.md) and
[`ripple/DESIGN.md`](../../../../ripple/DESIGN.md)). Before that onboarding can
happen, an operator must create/configure the underlying XRPL token.

These are **pure, single-purpose** commands — each submits exactly one kind of
XRPL transaction. The XRPL plumbing they share (client connection, signing,
flag/metadata parsing, validation) lives in
[`../../xrpl/helpers.ts`](../../xrpl/helpers.ts).

## Commands

| Command | Signed by | XRPL transaction | Purpose |
|---|---|---|---|
| `enable-rippling` | issuer | `AccountSet(asfDefaultRipple)` | Enable DefaultRipple on an IOU issuer account |
| `trust-set` | holder | `TrustSet` | Open a trust line so a holder can receive an IOU |
| `create-mpt` | issuer | `MPTokenIssuanceCreate` | Create a Multi-Purpose Token issuance |
| `authorize-mpt` | holder | `MPTokenAuthorize` | Opt a holder into an MPT |

"Creating" an IOU is just `enable-rippling` (issuer) + `trust-set` (each holder).
An MPT is `create-mpt` (issuer) + `authorize-mpt` (each holder).

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
- Holder-signed commands (`trust-set`, `authorize-mpt`) → `--seed` / `SEED`.
