# Multi-stage build for the svastha relay. Relay-only: no wasm, no PWA assets
# (those deploy separately to Cloudflare). Pure-Rust crypto and no outbound
# calls, so there is no OpenSSL/libcurl/ca-certificates dependency to carry.

FROM rust:1-slim-bookworm AS builder
WORKDIR /build
COPY . .
RUN cargo build -p svastha-relay --release

FROM debian:bookworm-slim
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
