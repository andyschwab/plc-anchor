//! Live Starknet [`AnchorSink`]: submits verified deltas to the deployed `anchor` contract.
//!
//! Genesis deltas call `import_genesis(signed)`, appends call `submit_op(did, signed)`
//! (REFERENCE.md §3). The signing key here authorizes only the *Starknet transaction* (it pays
//! gas); it is NOT the PLC authorization — that is the op's embedded signature, verified
//! in-contract against the DID's rotation keys (REFERENCE.md §2). So the fee payer may be anyone:
//! the permissionless property.
//!
//! Gated behind the `live` cargo feature so the default build and the offline consensus tests
//! pull no async runtime / Starknet client. `apply` blocks on a current-thread tokio runtime and
//! waits for each tx to be accepted, so a later op for the same DID observes the prior state.

use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use starknet::accounts::{Account, ConnectedAccount, ExecutionEncoding, SingleOwnerAccount};
use starknet::core::types::{BlockId, BlockTag, Call, ExecutionResult, Felt, StarknetError};
use starknet::core::utils::get_selector_from_name;
use starknet::providers::jsonrpc::HttpTransport;
use starknet::providers::{JsonRpcClient, Provider, ProviderError, Url};
use starknet::signers::{LocalWallet, SigningKey};

use crate::sink::{AnchorSink, Delta};

/// Connection + identity for the live sink, read from the environment so secrets never touch the
/// repo: `STARKNET_RPC`, `ANCHOR_CONTRACT_ADDRESS`, `STARKNET_ACCOUNT_ADDRESS`,
/// `STARKNET_ACCOUNT_PRIVATE_KEY`. Optional tuning (read in `StarknetSink::new`):
/// `STARKNET_MAX_L2_GAS` — the per-tx L2 gas ceiling the sink keeps requests under
/// (default 1.2e9; see `DEFAULT_MAX_L2_GAS`).
pub struct StarknetConfig {
    /// JSON-RPC endpoint (spec 0.10.x).
    pub rpc_url: String,
    /// Deployed `anchor` contract address.
    pub contract: Felt,
    /// Fee-paying account address (gas only — not PLC authorization).
    pub account_address: Felt,
    /// Fee-paying account signing key.
    pub private_key: Felt,
}

impl StarknetConfig {
    /// Build config from the environment variables documented on the struct.
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            rpc_url: env_var("STARKNET_RPC")?,
            contract: felt_env("ANCHOR_CONTRACT_ADDRESS")?,
            account_address: felt_env("STARKNET_ACCOUNT_ADDRESS")?,
            private_key: felt_env("STARKNET_ACCOUNT_PRIVATE_KEY")?,
        })
    }
}

fn env_var(key: &str) -> Result<String> {
    std::env::var(key).with_context(|| format!("{key} must be set for the live sink"))
}

fn felt_env(key: &str) -> Result<Felt> {
    Felt::from_hex(&env_var(key)?).with_context(|| format!("{key} must be a 0x-hex felt"))
}

type Acct = SingleOwnerAccount<JsonRpcClient<HttpTransport>, LocalWallet>;

/// The sequencer's per-transaction L2 gas ceiling (Sepolia rejects above ~1.21e9). We keep the
/// requested max L2 gas under this. A multi-op `import` re-verifies every op's signature
/// in-contract, so its L2 gas is large; the account crate's default 1.5× estimate margin overshoots
/// the cap even when the (deterministic) actual usage fits. Override with `STARKNET_MAX_L2_GAS`.
const DEFAULT_MAX_L2_GAS: u64 = 1_200_000_000;
/// Margin applied over the fee estimate before clamping at the cap (headroom for estimate/block
/// drift; execution gas is otherwise deterministic).
const GAS_ESTIMATE_MARGIN: f64 = 1.3;

/// A live [`AnchorSink`] that submits each delta as a Starknet invoke v3 transaction (STRK fees)
/// and waits for acceptance.
pub struct StarknetSink {
    runtime: tokio::runtime::Runtime,
    account: Acct,
    contract: Felt,
    /// How long to wait for a submitted tx to surface a non-pending receipt.
    receipt_timeout: Duration,
    /// Per-tx L2 gas ceiling we keep the requested max under (`STARKNET_MAX_L2_GAS`).
    max_l2_gas: u64,
}

impl StarknetSink {
    /// Connect to the chain and prepare the fee-paying account. Fetches the chain id up front.
    pub fn new(cfg: StarknetConfig) -> Result<Self> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("build tokio runtime")?;
        let url = Url::parse(&cfg.rpc_url).context("parse STARKNET_RPC url")?;
        let provider = JsonRpcClient::new(HttpTransport::new(url));
        let chain_id = runtime
            .block_on(provider.chain_id())
            .context("fetch chain id (is STARKNET_RPC reachable?)")?;
        let signer = LocalWallet::from(SigningKey::from_secret_scalar(cfg.private_key));
        let mut account = SingleOwnerAccount::new(
            provider,
            signer,
            cfg.account_address,
            chain_id,
            ExecutionEncoding::New,
        );
        // Estimate against the pending block so back-to-back submits see the prior tx's nonce.
        account.set_block_id(BlockId::Tag(BlockTag::PreConfirmed));
        let max_l2_gas = std::env::var("STARKNET_MAX_L2_GAS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(DEFAULT_MAX_L2_GAS);
        Ok(Self {
            runtime,
            account,
            contract: cfg.contract,
            receipt_timeout: Duration::from_secs(300),
            max_l2_gas,
        })
    }

    /// Override the receipt-wait timeout (default 300s).
    pub fn with_receipt_timeout(mut self, timeout: Duration) -> Self {
        self.receipt_timeout = timeout;
        self
    }

    /// The deployed contract this sink targets.
    pub fn contract(&self) -> Felt {
        self.contract
    }

    /// Read a `ByteArray`-returning view (e.g. `head_cid`, `tentative_root`) as raw bytes.
    /// Exposed for the E2E harness to assert on-chain effects.
    pub fn call_byte_array_view(&self, function: &str, args: &[u8]) -> Result<Vec<u8>> {
        use starknet::core::types::FunctionCall;
        let calldata = if args.is_empty() {
            Vec::new()
        } else {
            byte_array_calldata(args)
        };
        let felts = self.runtime.block_on(self.account.provider().call(
            FunctionCall {
                contract_address: self.contract,
                entry_point_selector: get_selector_from_name(function)?,
                calldata,
            },
            // Read the latest ACCEPTED block, not pre-confirmed. These are post-acceptance
            // confirmation reads; a pre-confirmed snapshot on some nodes is internally
            // inconsistent (a storage `Map` slot updated while the `Vec`-length slot backing
            // `tentative_root` still reads stale), which surfaced a spurious empty root.
            BlockId::Tag(BlockTag::Latest),
        ))?;
        byte_array_from_felts(&felts)
    }

    /// Read the `is_anchored(did)` bool view.
    pub fn is_anchored(&self, did: &str) -> Result<bool> {
        use starknet::core::types::FunctionCall;
        let felts = self.runtime.block_on(self.account.provider().call(
            FunctionCall {
                contract_address: self.contract,
                entry_point_selector: get_selector_from_name("is_anchored")?,
                calldata: byte_array_calldata(did.as_bytes()),
            },
            // Latest accepted block — consistent snapshot (see `call_byte_array_view`).
            BlockId::Tag(BlockTag::Latest),
        ))?;
        Ok(felts.first().copied().unwrap_or(Felt::ZERO) != Felt::ZERO)
    }

    /// Poll `is_anchored` at the latest accepted block until a just-submitted tx surfaces there, or
    /// a short bound elapses. `wait_for_acceptance` returns on a `Succeeded` receipt, which can
    /// briefly precede the tx appearing at `latest` (the confirmation reads target `latest`, not the
    /// internally-inconsistent pre-confirmed snapshot). Returns whether it became visible.
    pub fn wait_anchored(&self, did: &str) -> Result<bool> {
        let poll = Duration::from_secs(3);
        let bound = Duration::from_secs(90);
        let mut waited = Duration::ZERO;
        loop {
            if self.is_anchored(did)? {
                return Ok(true);
            }
            if waited >= bound {
                return Ok(false);
            }
            std::thread::sleep(poll);
            waited += poll;
        }
    }

    async fn submit_and_wait(&self, call: Call, did: &str) -> Result<()> {
        let exec = self.account.execute_v3(vec![call]);

        // Set explicit v3 resource bounds so the requested max L2 gas stays under the sequencer's
        // per-tx ceiling. A multi-op `import` re-verifies every op's signature in-contract, so its
        // L2 gas is large; the crate's default 1.5× estimate margin overshoots the cap even when
        // the deterministic actual usage would fit. We estimate, apply a smaller margin, and clamp
        // L2 gas at the cap. Gas *prices* are left unset — `send()` derives them from the block.
        let est = exec
            .estimate_fee()
            .await
            .map_err(|e| anyhow!("estimate fee for {did}: {e}"))?;
        if est.l2_gas_consumed > self.max_l2_gas {
            bail!(
                "{did}: this transaction needs {} L2 gas, over the per-tx cap {}. If the network's \
                 real per-tx limit is higher, raise STARKNET_MAX_L2_GAS. Otherwise the chain is \
                 too long to `import` in one transaction — a batched settled-import entrypoint \
                 (import_append) would be needed; see the follow-up in docs/HISTORY.md.",
                est.l2_gas_consumed,
                self.max_l2_gas
            );
        }
        let bump = |g: u64| ((g as f64) * GAS_ESTIMATE_MARGIN) as u64;
        let l2_gas = bump(est.l2_gas_consumed).min(self.max_l2_gas);
        let result = exec
            .l1_gas(bump(est.l1_gas_consumed))
            .l2_gas(l2_gas)
            .l1_data_gas(bump(est.l1_data_gas_consumed))
            .send()
            .await
            .map_err(|e| anyhow!("submit tx for {did}: {e}"))?;
        let hash = result.transaction_hash;
        eprintln!("ingest: submitted {did} as tx {hash:#x}");
        self.wait_for_acceptance(hash, did).await
    }

    async fn wait_for_acceptance(&self, hash: Felt, did: &str) -> Result<()> {
        let poll = Duration::from_secs(3);
        let mut waited = Duration::ZERO;
        loop {
            match self.account.provider().get_transaction_receipt(hash).await {
                Ok(receipt) => match receipt.receipt.execution_result() {
                    ExecutionResult::Succeeded => {
                        eprintln!("ingest: accepted {did} (tx {hash:#x})");
                        return Ok(());
                    }
                    ExecutionResult::Reverted { reason } => {
                        bail!("tx {hash:#x} for {did} reverted: {reason}")
                    }
                },
                Err(ProviderError::StarknetError(StarknetError::TransactionHashNotFound)) => {
                    // Not yet visible to this node — keep waiting.
                }
                Err(e) => return Err(anyhow!("receipt for {hash:#x} ({did}): {e}")),
            }
            if waited >= self.receipt_timeout {
                bail!(
                    "tx {hash:#x} for {did} not accepted within {}s",
                    self.receipt_timeout.as_secs()
                );
            }
            tokio::time::sleep(poll).await;
            waited += poll;
        }
    }
}

impl AnchorSink for StarknetSink {
    fn apply(&mut self, delta: &Delta) -> Result<()> {
        let call = match delta {
            Delta::Genesis { signed, .. } => Call {
                to: self.contract,
                selector: get_selector_from_name("import_genesis")?,
                calldata: byte_array_calldata(signed),
            },
            Delta::Append { did, signed } => {
                let mut calldata = byte_array_calldata(did.as_bytes());
                calldata.extend(byte_array_calldata(signed));
                Call {
                    to: self.contract,
                    selector: get_selector_from_name("submit_op")?,
                    calldata,
                }
            }
            Delta::Import { ops, .. } => {
                // `import(chain: Array<ByteArray>)` — calldata is the array length followed by each
                // op's ByteArray serialization, in order (genesis first). Marks the whole chain
                // settled on-chain (SECURITY-TODO 4a).
                let mut calldata = vec![Felt::from(ops.len())];
                for op in ops {
                    calldata.extend(byte_array_calldata(op));
                }
                Call {
                    to: self.contract,
                    selector: get_selector_from_name("import")?,
                    calldata,
                }
            }
        };
        self.runtime
            .block_on(self.submit_and_wait(call, delta.did()))
    }
}

/// Serialize bytes into a Cairo `ByteArray`'s calldata felts:
/// `[num_full_words, word_0, …, word_{n-1}, pending_word, pending_word_len]`, where each full
/// word is 31 bytes big-endian and the pending word is the trailing `len % 31` bytes big-endian
/// (RFC-agnostic — this is Cairo's `core::byte_array::ByteArray` serde, confirmed against the
/// contract's `tentative_root` output).
fn byte_array_calldata(bytes: &[u8]) -> Vec<Felt> {
    let full = bytes.len() / 31;
    let rem = bytes.len() % 31;
    let mut out = Vec::with_capacity(full + 3);
    out.push(Felt::from(full));
    for i in 0..full {
        out.push(Felt::from_bytes_be_slice(&bytes[i * 31..i * 31 + 31]));
    }
    out.push(Felt::from_bytes_be_slice(&bytes[full * 31..]));
    out.push(Felt::from(rem));
    out
}

/// Inverse of [`byte_array_calldata`] for view returns.
fn byte_array_from_felts(felts: &[Felt]) -> Result<Vec<u8>> {
    if felts.len() < 2 {
        bail!("ByteArray return too short: {} felts", felts.len());
    }
    let full: usize = felts[0]
        .try_into()
        .map_err(|_| anyhow!("ByteArray word count overflow"))?;
    if felts.len() != full + 3 {
        bail!(
            "ByteArray length mismatch: header says {full} words, got {} felts",
            felts.len()
        );
    }
    let pending_len: usize = felts[full + 2]
        .try_into()
        .map_err(|_| anyhow!("ByteArray pending len overflow"))?;
    let mut out = Vec::with_capacity(full * 31 + pending_len);
    for word in &felts[1..=full] {
        // Each full word is exactly 31 bytes, big-endian (drop the leading zero byte of 32).
        out.extend_from_slice(&word.to_bytes_be()[1..]);
    }
    if pending_len > 0 {
        let pending = felts[full + 1].to_bytes_be();
        out.extend_from_slice(&pending[32 - pending_len..]);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_array_roundtrip() {
        for case in [
            vec![],
            vec![0x55],
            (0..31u8).collect::<Vec<_>>(),
            (0..32u8).collect::<Vec<_>>(),
            (0..70u8).collect::<Vec<_>>(),
        ] {
            let felts = byte_array_calldata(&case);
            let back = byte_array_from_felts(&felts).expect("decode");
            assert_eq!(back, case, "roundtrip for {}-byte input", case.len());
        }
    }

    #[test]
    fn empty_byte_array_is_three_zeros() {
        assert_eq!(
            byte_array_calldata(&[]),
            vec![Felt::ZERO, Felt::ZERO, Felt::ZERO]
        );
    }

    #[test]
    fn sha256_empty_root_shape() {
        // The 32-byte sha256("") root the contract returns: 1 full word + 1 pending byte (0x55).
        let root = hex_literal_e3b0();
        let felts = byte_array_calldata(&root);
        assert_eq!(felts.len(), 4, "32 bytes => [1, word, pending, 1]");
        assert_eq!(felts[0], Felt::ONE);
        assert_eq!(felts[3], Felt::ONE);
        assert_eq!(felts[2], Felt::from(0x55u8));
    }

    fn hex_literal_e3b0() -> Vec<u8> {
        // sha256("") = e3b0c442…b855
        let s = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }
}
