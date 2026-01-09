FROM oven/bun:1.3.4-alpine@sha256:1d653098bf847813e26adb2435f932b7cfa3c132a7e25dd5216dbb1f67dbd118 AS base

# Install Node alongside Bun - Jest has compatibility issues with Bun's runtime
RUN apk add --no-cache make python3 gcc g++ jq nodejs npm

WORKDIR /usr/src/

COPY --from=ntt-solana-contract /usr/src/solana/ts solana/ts
COPY --from=ntt-solana-contract /usr/src/solana/package.json solana/package.json
COPY --from=ntt-solana-contract /usr/src/solana/tsconfig.esm.json solana/tsconfig.esm.json
COPY --from=ntt-solana-contract /usr/src/solana/tsconfig.cjs.json solana/tsconfig.cjs.json
COPY --from=ntt-solana-contract /usr/src/solana/target/idl solana/target/idl
COPY --from=ntt-solana-contract /usr/src/solana/target/types solana/target/types

COPY --from=ntt-evm-contract ts evm/ts
COPY --from=ntt-evm-contract . evm/out

RUN rm -rf evm/out/ts

COPY . ./

# Create dummy package.json for workspaces not in Docker context
# This allows bun ci to work with frozen lockfile (no dependency drift)
RUN mkdir -p cli sui/ts && \
    echo '{"name":"@wormhole-foundation/ntt-cli","version":"0.0.0"}' > cli/package.json && \
    echo '{"name":"@wormhole-foundation/sdk-sui-ntt","version":"0.0.0"}' > sui/ts/package.json

RUN --mount=type=cache,uid=1000,gid=1000,target=/home/node/.bun \
  bun ci

# Build packages directly (can't use --filter since workspaces are modified)
RUN cd sdk/definitions && bun run build
RUN cd evm/ts && bun run build
RUN cd solana && bun run build
RUN cd sdk/route && bun run build
RUN cd evm/ts && bun run generate:test

WORKDIR /usr/src/sdk
