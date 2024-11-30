FROM --platform=linux/amd64 ghcr.io/foundry-rs/foundry@sha256:8b843eb65cc7b155303b316f65d27173c862b37719dc095ef3a2ef27ce8d3c00 as builder

WORKDIR /app
COPY foundry.toml foundry.toml
COPY lib lib
COPY src src
COPY ts ts

RUN FOUNDRY_PROFILE=prod forge build

FROM scratch AS foundry-export

COPY --from=builder /app/out .
COPY --from=builder /app/ts ts
