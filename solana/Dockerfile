FROM backpackapp/build:v0.29.0@sha256:9aee169b2d8b89b4a4243419ae35c176773136e78d751b3e439eff692c9c1293 AS anchor

WORKDIR /usr/src/solana/

COPY solana/Anchor.toml Anchor.toml
COPY solana/Cargo.lock Cargo.lock
COPY solana/Cargo.toml Cargo.toml
COPY solana/modules modules
COPY solana/programs programs
COPY solana/tests tests
COPY solana/rust-toolchain rust-toolchain

ENV RUST_BACKTRACE=1

FROM anchor AS builder

RUN mkdir -p /opt/solana/deps

RUN --mount=type=cache,target=/opt/solana/deps/target,id=build_anchor_ntt_target \
    --mount=type=cache,target=/usr/local/cargo/registry,id=cargo_registry \
    --mount=type=cache,target=.anchor,id=anchor_cache \
    anchor build --arch sbf -- --no-default-features --features tilt-devnet

RUN cp ./target/sbf-solana-solana/release/example_native_token_transfers.so /opt/solana/deps/example_native_token_transfers.so
RUN cp ./target/sbf-solana-solana/release/wormhole_governance.so /opt/solana/deps/wormhole_governance.so
RUN cp ./target/sbf-solana-solana/release/ntt_transceiver.so /opt/solana/deps/ntt_transceiver.so

RUN --mount=type=cache,target=/opt/solana/deps/target,id=build_anchor_ntt_target \
    --mount=type=cache,target=/usr/local/cargo/registry,id=cargo_registry \
    --mount=type=cache,target=.anchor,id=anchor_cache \
    anchor build --arch sbf -- --no-default-features --features tilt-devnet2

RUN cp ./target/sbf-solana-solana/release/example_native_token_transfers.so /opt/solana/deps/example_native_token_transfers_2.so
RUN cp ./target/sbf-solana-solana/release/ntt_transceiver.so /opt/solana/deps/ntt_transceiver_2.so


COPY solana/tilt /opt/solana/deps

COPY sdk ../sdk
COPY solana/ts ts
COPY solana/package.json package.json
COPY solana/tsconfig.esm.json tsconfig.esm.json
COPY solana/tsconfig.cjs.json tsconfig.cjs.json
COPY solana/tsconfig.anchor.json tsconfig.anchor.json
COPY solana/Makefile Makefile
COPY solana/scripts scripts

RUN make target/idl/example_native_token_transfers.json

FROM scratch AS export

COPY --from=builder /opt/solana/deps /opt/solana/deps
COPY --from=builder /usr/src/solana/ts /usr/src/solana/ts
COPY --from=builder /usr/src/solana/package.json /usr/src/solana/package.json
COPY --from=builder /usr/src/solana/tsconfig.esm.json /usr/src/solana/tsconfig.esm.json
COPY --from=builder /usr/src/solana/tsconfig.cjs.json /usr/src/solana/tsconfig.cjs.json
COPY --from=builder /usr/src/solana/target/idl  /usr/src/solana/target/idl
COPY --from=builder /usr/src/solana/target/types /usr/src/solana/target/types

FROM oven/bun:1.3.4-alpine@sha256:1d653098bf847813e26adb2435f932b7cfa3c132a7e25dd5216dbb1f67dbd118 AS governance

WORKDIR /app

RUN apk add --no-cache make python3 gcc g++ jq

COPY tsconfig.json tsconfig.json
COPY tsconfig.cjs.json tsconfig.cjs.json
COPY tsconfig.esm.json tsconfig.esm.json
# Strip workspaces from package.json (bun is strict about missing workspace dirs, npm wasn't)
COPY package.json /tmp/package.json
RUN jq 'del(.workspaces)' /tmp/package.json > package.json
COPY bun.lock bun.lock
COPY bunfig.toml bunfig.toml
COPY sdk sdk
RUN bun ci
RUN bun run build

WORKDIR /app/solana
COPY solana/ts ts

ENTRYPOINT [ "bunx", "tsx" ]
