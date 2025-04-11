FROM --platform=linux/amd64 ghcr.io/foundry-rs/foundry:v1.0.0@sha256:d12a373ec950de170d5461014ef9320ba0fb6e0db6f87835999d0fcf3820370e as builder

WORKDIR /app
COPY foundry.toml foundry.toml
COPY lib lib
COPY src src
COPY ts ts

RUN FOUNDRY_PROFILE=prod forge build

FROM scratch AS foundry-export

COPY --from=builder /app/out .
COPY --from=builder /app/ts ts
