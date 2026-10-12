FROM rust:1.93.0-trixie@sha256:bbde3ca426faeebab3eb58b8005d3d6da70607817a14bb92a55c94611d4d905f

RUN rustup target add wasm32-unknown-unknown \
    && rustup component add clippy rustfmt \
    && apt-get update \
    && apt-get install -y --no-install-recommends jq \
    && rm -rf /var/lib/apt/lists/*
