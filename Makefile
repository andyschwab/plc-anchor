# PLC Anchor — single coordination point across the toolchains.
# Each toolchain (Scarb, Cargo, npm) keeps its own manifest/lockfile; this Makefile is the
# only thing that knows about all of them. See CLAUDE.md.
#
# Assumes the toolchains are on PATH (run `make setup`, then restart your shell or
# `source ~/.zshrc`). CI installs them per-job.

.DEFAULT_GOAL := help
.PHONY: help setup gen-vectors gen-vectors-check gen-plc-corpus gen-plc-vectors gen-plc-vectors-check gen-op-verify-vectors gen-op-verify-vectors-check gen-recovery-vectors gen-recovery-vectors-check gen-merkle-vectors gen-merkle-vectors-check gen-selectors gen-selectors-check gen-adversarial-scenarios gen-adversarial-scenarios-check cairo-build cairo-test deploy deploy-sepolia wallet-create wallet-deploy wallet-info rust-build rust-test witness-test console-test adversarial adversarial-check adversarial-live conformance fmt ci clean test-backend test-snforge test-offline

# Cairo test backend (see cairo/TESTING.md). The committed default is `offline`
# (Scarb's builtin `cairo-test`, no registry needed); a real dev box can switch to
# `snforge`. CAIRO_TEST auto-detects the runner from the active manifest so the
# `cairo-test`/`conformance` targets work under either backend, unchanged.
CAIRO_TEST := $(shell grep -q '^snforge_std' cairo/Scarb.toml && echo 'snforge test' || echo 'scarb cairo-test')

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

setup: ## Install/refresh toolchain deps (asdf tools, cargo, npm)
	@command -v asdf >/dev/null && asdf install || echo "asdf not found — see CLAUDE.md install notes"
	cargo fetch
	@echo "setup: toolchains ready (restart shell if asdf shims were just added)"

# ---- Conformance codegen -----------------------------------------------------
# The Cairo VM has no filesystem at test time, so the DASL vectors are compiled into a
# generated Cairo table. The JSON under conformance/vectors stays the source of truth; the
# table is committed (so `scarb test` is self-contained) and `scarb fmt`-normalized so it
# is both drift-checkable and fmt-clean. Run this whenever the vectors change.
gen-vectors: ## Regenerate + format the Cairo conformance table from conformance/vectors
	node conformance/src/gen-cairo-vectors.mjs
	cd cairo && scarb fmt

gen-vectors-check: gen-vectors ## Fail if the generated table drifted from the JSON (CI gate)
	git diff --exit-code -- cairo/packages/drisl/tests/vectors_generated.cairo

gen-plc-corpus: ## (Re)generate PLC-op corpus from @did-plc/lib; commit the result
	cd conformance && node src/gen-plc-corpus.mjs

gen-plc-vectors: ## Re-validate corpus and regenerate the Cairo PLC-op vector table
	cd conformance && node src/gen-plc-vectors.mjs
	cd cairo && scarb fmt

gen-plc-vectors-check: gen-plc-vectors ## Fail if the Cairo PLC-op vector table drifted (CI gate)
	git diff --exit-code -- cairo/packages/drisl/tests/plc_vectors_generated.cairo

gen-op-verify-vectors: ## Re-validate corpus and regenerate the Cairo op_verify/op_decode vector table
	cd conformance && node src/gen-op-verify-vectors.mjs
	cd cairo && scarb fmt

gen-op-verify-vectors-check: gen-op-verify-vectors ## Fail if the op_verify/op_decode vector table drifted (CI gate)
	git diff --exit-code -- cairo/packages/plc_core/tests/op_verify_vectors_generated.cairo

gen-recovery-vectors: ## Regenerate the 72h-recovery decision vector table (ground-truthed vs @did-plc/lib)
	cd conformance && node src/gen-recovery-vectors.mjs
	cd cairo && scarb fmt

gen-recovery-vectors-check: gen-recovery-vectors ## Fail if the recovery vector table drifted (CI gate)
	git diff --exit-code -- cairo/packages/plc_core/tests/recovery_vectors_generated.cairo

gen-merkle-vectors: ## Regenerate the DID→head Merkle commitment vectors (Cairo + TS JSON; raw node:crypto sha256)
	cd conformance && node src/gen-merkle-vectors.mjs
	cd cairo && scarb fmt

gen-merkle-vectors-check: gen-merkle-vectors ## Fail if either Merkle vector consumer drifted (CI gate)
	git diff --exit-code -- cairo/packages/plc_core/tests/merkle_vectors_generated.cairo \
		witness-ts/test/vectors/merkle-vectors.json

gen-selectors: ## Regenerate witness-ts Starknet selectors from the `starknet` crate (needs the `live` deps)
	cargo run -p ingest --example gen_selectors --features live

gen-selectors-check: gen-selectors ## Fail if the pinned selectors drifted (gated CI: e2e-sepolia has the live deps)
	git diff --exit-code -- witness-ts/src/selectors.ts

gen-adversarial-scenarios: ## Regenerate the adversarial scenario fixture (real chains + commitments, ground-truthed vs @did-plc/lib)
	cd conformance && node src/gen-adversarial-scenarios.mjs

gen-adversarial-scenarios-check: gen-adversarial-scenarios ## Fail if the adversarial fixture drifted (CI gate)
	git diff --exit-code -- adversarial/scenarios.generated.json

# ---- Cairo (Scarb workspace) -------------------------------------------------
cairo-build: ## Build the Cairo workspace (drisl, plc_core)
	cd cairo && scarb build

deploy: ## Declare + deploy the anchor to NETWORK=sepolia|mainnet (local; needs sncast + keyed STARKNET_RPC). NOT upgradeable → new address
	NETWORK=$(NETWORK) scripts/deploy.sh

deploy-sepolia: ## Alias: deploy to Sepolia (== make deploy NETWORK=sepolia)
	NETWORK=sepolia scripts/deploy.sh

wallet-create: ## Create the operator wallet for NETWORK=sepolia|mainnet (then fund the printed address)
	NETWORK=$(NETWORK) scripts/wallet.sh create

wallet-deploy: ## Deploy the operator account on-chain for NETWORK (after funding it)
	NETWORK=$(NETWORK) scripts/wallet.sh deploy

wallet-info: ## Show accounts + operator balance for NETWORK=sepolia|mainnet
	NETWORK=$(NETWORK) scripts/wallet.sh list
	NETWORK=$(NETWORK) scripts/wallet.sh balance

cairo-test: ## Run Cairo tests (drisl conformance + plc_core op_verify gate; reports gas estimates)
	cd cairo && $(CAIRO_TEST)

test-offline: ## Switch the Cairo test backend to `cairo-test` (offline; no registry)
	cairo/scripts/test-backend.sh offline

test-snforge: ## Switch the Cairo test backend to real `snforge` (needs network)
	cairo/scripts/test-backend.sh snforge

test-backend: ## Show which Cairo test backend is active
	@cairo/scripts/test-backend.sh status

# ---- Rust (Cargo workspace) --------------------------------------------------
rust-build: ## Build the Rust workspace (ingest, oracle)
	cargo build --workspace

rust-test: ## Test + lint the Rust workspace
	cargo fmt --check
	cargo clippy --workspace -- -D warnings
	cargo test --workspace

# ---- Witness library (TypeScript) --------------------------------------------
witness-test: ## Run the witness-ts library tests (Node-native TS; no install needed)
	cd witness-ts && node --test

# ---- Admin console (TypeScript) ----------------------------------------------
console-test: ## Run the admin-console tests (Node-native TS; node:sqlite needs --experimental-sqlite)
	cd console && node --experimental-sqlite --test

# ---- Adversarial validation (DIDMARC attack/fork scenarios) ------------------
# Real signed did:plc chains + a malicious-mirror DirectorySource + the real witness check().
# The offline suite is the CI pass/fail gate; the report is the engineer-facing narrative
# artifact (docs/ADVERSARIAL-REPORT.md).
adversarial: ## Run the adversarial scenario suite and regenerate docs/ADVERSARIAL-REPORT.md
	cd adversarial && node --test
	node adversarial/report.ts

adversarial-check: ## CI gate: scenarios behave as specified AND the committed report is current
	cd adversarial && node --test
	node adversarial/report.ts --stdout >/dev/null
	node adversarial/report.ts
	git diff --exit-code -- docs/ADVERSARIAL-REPORT.md

adversarial-live: ## Gated live adversarial read vs Sepolia (real anchor + HTTP malicious mirror); needs WITNESS_LIVE_RPC [+ WITNESS_LIVE_DID]
	cd adversarial && node --test live.test.ts

# ---- Conformance / differential harness --------------------------------------
conformance: ## Three-way DRISL/CID agreement (Cairo vs Rust oracle vs TS sidecar)
	cd cairo && $(CAIRO_TEST) --package drisl
	cargo run -q -p oracle
	node conformance/src/check.mjs

# ---- Aggregate ---------------------------------------------------------------
fmt: ## Format Rust + Cairo
	cargo fmt
	cd cairo && scarb fmt

ci: gen-vectors-check gen-plc-vectors-check gen-op-verify-vectors-check gen-recovery-vectors-check gen-merkle-vectors-check gen-adversarial-scenarios-check cairo-build cairo-test rust-test witness-test console-test adversarial-check conformance ## Everything CI runs

clean: ## Remove build artifacts
	cargo clean
	cd cairo && scarb clean || true
