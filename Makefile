# PLC Anchor — single coordination point across the toolchains.
# Each toolchain (Scarb, Cargo, npm) keeps its own manifest/lockfile; this Makefile is the
# only thing that knows about all of them. See CLAUDE.md.
#
# Assumes the toolchains are on PATH (run `make setup`, then restart your shell or
# `source ~/.zshrc`). CI installs them per-job.

.DEFAULT_GOAL := help
.PHONY: help setup cairo-build cairo-test rust-build rust-test conformance fmt ci clean

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

setup: ## Install/refresh toolchain deps (asdf tools, cargo, npm)
	@command -v asdf >/dev/null && asdf install || echo "asdf not found — see CLAUDE.md install notes"
	cargo fetch
	@echo "setup: toolchains ready (restart shell if asdf shims were just added)"

# ---- Cairo (Scarb workspace) -------------------------------------------------
cairo-build: ## Build the Cairo workspace (drisl, plc_core)
	cd cairo && scarb build

cairo-test: ## Run snforge tests (incl. DASL conformance fixtures; reports gas)
	cd cairo && snforge test

# ---- Rust (Cargo workspace) --------------------------------------------------
rust-build: ## Build the Rust workspace (ingest, oracle)
	cargo build --workspace

rust-test: ## Test + lint the Rust workspace
	cargo fmt --check
	cargo clippy --workspace -- -D warnings
	cargo test --workspace

# ---- Conformance / differential harness --------------------------------------
conformance: ## Three-way DRISL/CID agreement (Cairo vs Rust oracle vs TS sidecar)
	cd cairo && snforge test --package drisl
	cargo run -q -p oracle
	node conformance/src/check.mjs

# ---- Aggregate ---------------------------------------------------------------
fmt: ## Format Rust + Cairo
	cargo fmt
	cd cairo && scarb fmt

ci: cairo-build cairo-test rust-test conformance ## Everything CI runs

clean: ## Remove build artifacts
	cargo clean
	cd cairo && scarb clean || true
