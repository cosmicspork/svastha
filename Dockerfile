# Multi-stage build for the svastha relay. Relay-only: no wasm, no PWA assets
# (those deploy separately to Cloudflare). Web Push fan-out (the relay's one
# outbound call) links OpenSSL via the web-push crate's isahc/curl client, so
# the builder needs the OpenSSL headers and the runtime needs libssl + CA
# roots to speak TLS to the push services.

FROM rust:1-slim-bookworm AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY . .
RUN cargo build -p svastha-relay --release

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends libssl3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /build/target/release/svastha-relay /usr/local/bin/svastha-relay
ENV SVASTHA_RELAY_ADDR=0.0.0.0:8080 \
    SVASTHA_RELAY_DATA_DIR=/data
EXPOSE 8080
# Runs as nobody (65534:65534). /data is chowned here so the image is runnable
# standalone; when a real volume is mounted over it in production, matching its
# ownership (e.g. an fsGroup of 65534) is the deployer's job, not this image's.
RUN mkdir -p /data && chown nobody:nogroup /data
USER nobody
CMD ["svastha-relay"]
