FROM oven/bun:1.3.4-alpine@sha256:1d653098bf847813e26adb2435f932b7cfa3c132a7e25dd5216dbb1f67dbd118 AS base

RUN apk add --no-cache make python3 gcc g++ jq

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
# Remove workspace entries that aren't in Docker context (bun is strict about missing dirs)
# Use bun install (not bun ci) since modified package.json won't match lockfile
RUN jq '.workspaces = [.workspaces[] | select(. != "cli" and . != "sui/ts")]' package.json > /tmp/package.json && mv /tmp/package.json package.json
RUN --mount=type=cache,uid=1000,gid=1000,target=/home/node/.bun \
  bun install

# Build packages directly (can't use --filter since workspaces are modified)
RUN cd sdk/definitions && bun run build
RUN cd evm/ts && bun run build
RUN cd solana && bun run build
RUN cd sdk/route && bun run build
RUN cd evm/ts && bun run generate:test

WORKDIR /usr/src/sdk
