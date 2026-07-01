# Admin console (plc.didmarc.dev). Build context: the REPO ROOT, not console/ —
# the runtime imports ../../witness-ts at startup, so both packages must keep their layout:
#   fly deploy --config console/fly.toml --dockerfile console/Dockerfile   (run from repo root)
#
# Multi-stage: stage 1 builds the Rust `ingest` binary (live feature) so the console can onboard
# on-chain (the Onboard button); stage 2 is the Node runtime with the console + witness-ts.

# ---- Stage 1: build the ingest binary (Rust workspace, live feature) --------
# Base tag pins the toolchain version; we intentionally do NOT copy rust-toolchain.toml (its
# rustfmt/clippy components would trigger a network fetch we don't need for `cargo build`).
FROM rust:1.96-slim AS ingest-build
RUN apt-get update \
  && apt-get install -y --no-install-recommends pkg-config libssl-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# The whole workspace so `-p ingest` resolves (members: ingest, oracle).
COPY Cargo.toml Cargo.lock ./
COPY ingest/ ./ingest/
COPY oracle/ ./oracle/
RUN cargo build --release --features live -p ingest

# ---- Stage 2: Node runtime -------------------------------------------------
FROM node:22-slim
# ingest makes HTTPS calls (directory + Starknet RPC): ensure CA certs + libssl at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libssl3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Preserve the sibling layout the witness import depends on.
COPY witness-ts/ ./witness-ts/
COPY console/ ./console/
COPY --from=ingest-build /src/target/release/ingest /usr/local/bin/ingest

WORKDIR /app/console
ENV NODE_ENV=production
ENV ROSTER_DB=/data/roster.db
ENV PORT=8787
# Enables the Onboard path: the onboarder shells out to this binary (see src/onboard.ts).
# The account secrets it reads (STARKNET_*) are the same Fly secrets the console uses.
ENV INGEST_COMMAND=/usr/local/bin/ingest
EXPOSE 8787

# node:sqlite needs the experimental flag (Node 22).
CMD ["node", "--experimental-sqlite", "src/main.ts"]
