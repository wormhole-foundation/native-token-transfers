FROM ghcr.io/foundry-rs/foundry@sha256:d9133dae61c19383b72695dc7eeca29d1e7a89f1f1b5fdfd8900c660b46b4303 as builder

WORKDIR /app
COPY foundry.toml foundry.toml
COPY lib lib
COPY src src

RUN FOUNDRY_PROFILE=prod forge build

FROM scratch AS foundry-export

COPY --from=builder /app/out .
