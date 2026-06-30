# Admin console (plc.didmarc.dev). Build context: the REPO ROOT, not console/ —
# the runtime imports ../../witness-ts at startup, so both packages must keep their layout:
#   fly deploy --config console/fly.toml --dockerfile console/Dockerfile   (run from repo root)
#
# Node-only image: roster curation, the discover-scan, and the status dashboard need no native
# build. On-chain *onboarding* (INGEST_COMMAND) shells out to the Rust `ingest` binary; baking
# it in is a multi-stage follow-up (FROM rust:1.96 → cargo build --release --features live -p
# ingest → COPY the binary here, then set INGEST_COMMAND=/app/ingest). Until then the deployed
# console curates + watches; onboarding runs from a box that has ingest.
FROM node:22-slim

WORKDIR /app
# Preserve the sibling layout the witness import depends on.
COPY witness-ts/ ./witness-ts/
COPY console/ ./console/

WORKDIR /app/console
ENV NODE_ENV=production
ENV ROSTER_DB=/data/roster.db
ENV PORT=8787
EXPOSE 8787

# node:sqlite needs the experimental flag (Node 22).
CMD ["node", "--experimental-sqlite", "src/main.ts"]
