# NTT TypeScript SDK

The NTT TypeScript SDK is is a collection of packages that provide a simple interface for interacting with NTT contracts. The `@wormhole-foundation/sdk-route-ntt` package provides a Wormhole SDK `Route` for NTT, meant to be used with the [Router](https://github.com/wormhole-foundation/connect-sdk/blob/main/examples/src/router.ts) in the Wormhole SDK.

## Building

From this directory, install package dependencies and build contract dependencies

```bash
npm install
npm run build:deps
```

## Installation

The SDK contains multiple packages. The `@wormhole-foundation/sdk-definitions-ntt` package contains the NTT interface and types. The `@wormhole-foundation/sdk-evm-ntt` and `@wormhole-foundation/sdk-solana-ntt` packages contain the EVM and Solana implementations of the NTT interface, respectively. Install one or both of these packages, depending on which platforms you want to interact with. The `@wormhole-foundation/sdk-route-ntt` package contains the Wormhole SDK `Route` for NTT (more on this in the Usage section).

```bash
npm install @wormhole-foundation/sdk-definitions-ntt
npm install @wormhole-foundation/sdk-evm-ntt
npm install @wormhole-foundation/sdk-solana-ntt
npm install @wormhole-foundation/sdk-route-ntt
```

## Usage

For an example of using the NTT Route, refer to the [route example](examples/src/route.ts). To interact directly with the NTT protocol, see the [protocol example](examples/src/index.ts). You can also test an NTT deployment by following the demo available [here](https://github.com/wormhole-foundation/demo-ntt-ts-sdk).
