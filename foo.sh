#!/bin/bash

npm ci

npm i @wormhole-foundation/sdk@latest

npm r -w evm/ts @wormhole-foundation/sdk-base @wormhole-foundation/sdk-definitions @wormhole-foundation/sdk-evm @wormhole-foundation/sdk-evm-core
npm r -w sdk/definitions @wormhole-foundation/sdk-base @wormhole-foundation/sdk-definitions
npm r -w sdk/examples @wormhole-foundation/sdk
npm r -w sdk/route @wormhole-foundation/sdk-connect
npm r -w solana @wormhole-foundation/sdk-base @wormhole-foundation/sdk-definitions @wormhole-foundation/sdk-solana @wormhole-foundation/sdk-solana-core
npm r -w sui/ts @wormhole-foundation/sdk-base @wormhole-foundation/sdk-definitions @wormhole-foundation/sdk-sui @wormhole-foundation/sdk-sui-core
npm r -w stacks/ts @wormhole-foundation/sdk-base @wormhole-foundation/sdk-definitions @wormhole-foundation/sdk-stacks @wormhole-foundation/sdk-stacks-core

npm i -w evm/ts --save-peer @wormhole-foundation/sdk-base@latest @wormhole-foundation/sdk-definitions@latest @wormhole-foundation/sdk-evm@latest @wormhole-foundation/sdk-evm-core@latest
npm i -w sdk/definitions --save-peer @wormhole-foundation/sdk-base@latest @wormhole-foundation/sdk-definitions@latest
npm i -w sdk/examples @wormhole-foundation/sdk@latest
npm i -w sdk/route --save-peer @wormhole-foundation/sdk-connect@latest
npm i -w solana --save-peer @wormhole-foundation/sdk-base@latest @wormhole-foundation/sdk-definitions@latest @wormhole-foundation/sdk-solana@latest @wormhole-foundation/sdk-solana-core@latest
npm i -w sui/ts --save-peer @wormhole-foundation/sdk-base@latest @wormhole-foundation/sdk-definitions@latest @wormhole-foundation/sdk-sui@latest @wormhole-foundation/sdk-sui-core@latest
npm i -w stacks/ts --save-peer @wormhole-foundation/sdk-base@latest @wormhole-foundation/sdk-definitions@latest @wormhole-foundation/sdk-stacks@latest @wormhole-foundation/sdk-stacks-core@latest
