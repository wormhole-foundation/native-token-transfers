FROM --platform=linux/amd64 ghcr.io/foundry-rs/foundry@sha256:ee6dd5a073585b40b49a7da83140e2bc7d4a0283de1d7d7dc4cea709c85e1933 as builder

WORKDIR /app
COPY foundry.toml foundry.toml
COPY lib lib
COPY src src
COPY ts ts

RUN FOUNDRY_PROFILE=prod forge build

FROM scratch AS foundry-export

COPY --from=builder /app/out .
COPY --from=builder /app/ts ts
