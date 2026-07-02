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
/// `STARKNET_ACCOUNT_PRIVATE_KEY`.
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

/// A live [`AnchorSink`] that submits each delta as a Starknet invoke v3 transaction (STRK fees)
/// and waits for acceptance.
pub struct StarknetSink {
    runtime: tokio::runtime::Runtime,
    account: Acct,
    contract: Felt,
    /// How long to wait for a submitted tx to surface a non-pending receipt.
    receipt_timeout: Duration,
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
        Ok(Self {
            runtime,
            account,
            contract: cfg.contract,
            receipt_timeout: Duration::from_secs(300),
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
            BlockId::Tag(BlockTag::PreConfirmed),
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
            BlockId::Tag(BlockTag::PreConfirmed),
        ))?;
        Ok(felts.first().copied().unwrap_or(Felt::ZERO) != Felt::ZERO)
    }

    async fn submit_and_wait(&self, call: Call, did: &str) -> Result<()> {
        let result = self
            .account
            .execute_v3(vec![call])
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
