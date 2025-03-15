# NTT cli

## Prerequisites

- [bun](https://bun.sh/docs/installation)

Depending on the platforms you will deploy on:
- [foundry](https://book.getfoundry.sh/) (evm)
- [anchor](https://book.anchor-lang.com/getting_started/installation.html) (solana)

## Installation

Run

``` bash
curl -fsSL https://raw.githubusercontent.com/wormhole-foundation/example-native-token-transfers/main/cli/install.sh | bash
```

The installer will put the `ntt` binary in `$HOME/.bun/bin`, so make sure that directory is included in your `$PATH`. Once `ntt` is installed, it can be updated to the latest release any time by running

``` bash
ntt update
```

Or to a specific branch by running

``` bash
ntt update --branch foo
```

## Development

The easiest way to work on the CLI is to first install using the script above, then clone the repo, and run

``` bash
ntt update --path path/to/ntt/repo
```
