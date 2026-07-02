//! The permissionless anchor endpoint (REFERENCE.md §2, §3 component 3, §4).
//!
//! A Starknet contract holding a per-DID op chain (the recovery window) with:
//!   - `import_genesis(genesis_signed)` — verify a self-authorized genesis op, start its
//!     chain, and return the derived did:plc.
//!   - `import(chain)` — anchor a DID with existing history in one call: replay genesis +
//!     each successor (the resolved linear chain) and store it.
//!   - `submit_op(did, proposed_signed)` — append OR recover: the op may extend the head or
//!     fork at an earlier op, nullifying what followed, subject to the 72h higher-priority
//!     rule (`state::apply_op`).
//!   - views: `head_cid` / `tentative_head` (the tip), `confirmed_head` (immutable past the
//!     window — §4), `is_anchored`.
//!
//! Authorization is the op's *embedded* signature, verified in-contract against the relevant
//! op's rotation keys (`state`). The Starknet tx signer / fee payer is irrelevant and may be
//! anyone — the permissionless property (REFERENCE.md §2); native AA / paymasters are for
//! gas/UX only, never authorization.
//!
//! Each chain entry stores the op's signed DRISL bytes + its anchored timestamp + signer
//! index; the CID, rotation keys, and tombstone status all derive from the bytes
//! (`state::record_from_signed`). `now` is the block timestamp in ms (seconds × 1000) — the
//! pragmatic createdAt the 72h window uses (§1, §4).

use crate::merkle::ProofStep;

#[starknet::interface]
pub trait IAnchor<TContractState> {
    /// Import a genesis op; returns its did:plc. Reverts if the DID is already anchored or
    /// the op is not a valid self-authorized genesis.
    fn import_genesis(ref self: TContractState, genesis_signed: ByteArray) -> ByteArray;
    /// Import a DID's existing history in one call: `chain[0]` is the genesis op and
    /// `chain[1..]` its successors in order (the *resolved* linear history — every op links
    /// to its immediate predecessor). Verifies genesis (self-authorized) then each successor
    /// (`prev == head`, signed by the head's rotation keys), and stores the chain. Returns
    /// the derived did:plc. Reverts on an empty chain, an already-anchored DID, an invalid
    /// genesis, a broken link/signature, or a forking successor (`import-fork` — pass the
    /// resolved chain, not an unadjudicated fork). Every op is stamped with the import block
    /// time (the pragmatic `createdAt`, §1/§4): `createdAt` is not part of the signed op, so
    /// the anchor uses its own observation time. A freshly imported chain is therefore
    /// tentative until the anchor has observed it for 72h. Imported ops are marked **settled**:
    /// a later `submit_op` recovery may not nullify them (`recovery-of-imported`), because their
    /// import-time stamp is not their real authored time and honoring a recovery there would
    /// re-open a long-closed window (SECURITY-TODO 4a). This is the onboarding path.
    fn import(ref self: TContractState, chain: Array<ByteArray>) -> ByteArray;
    /// Append or recover onto `did`. The op is observed **live** (not settled): its block-time
    /// stamp approximates its real authored time, so the 72h recovery window applies to it.
    /// Reverts on unknown DID, bad linkage/signature, a tombstoned fork point, an invalid/late
    /// recovery, or a recovery that would nullify imported/settled history (`recovery-of-imported`).
    fn submit_op(ref self: TContractState, did: ByteArray, proposed_signed: ByteArray);
    /// The current head (tentative tip) CID string for `did`, or "" if not anchored.
    fn head_cid(self: @TContractState, did: ByteArray) -> ByteArray;
    /// The confirmed head CID (immutable past the 72h window), or "" if all ops are still
    /// tentative / the DID is not anchored.
    fn confirmed_head(self: @TContractState, did: ByteArray) -> ByteArray;
    /// Whether `did` is anchored.
    fn is_anchored(self: @TContractState, did: ByteArray) -> bool;
    /// The 32-byte sha256-Merkle commitment over the **tentative** DID→head map (every
    /// anchored DID's current tip). `sha256("")` when nothing is anchored. The format is
    /// `merkle` (resolvers verify a DID against this with an inclusion proof).
    fn tentative_root(self: @TContractState) -> ByteArray;
    /// The commitment over the **confirmed** DID→head map: only DIDs with at least one op
    /// past the 72h window, mapped to their confirmed head (§4). Immutable history; the root
    /// a cautious resolver pins.
    fn confirmed_root(self: @TContractState) -> ByteArray;
    /// Inclusion proof for `did`'s **tentative** head against `tentative_root()`: returns
    /// `(head_cid, steps)`. A resolver rebuilds the leaf as `sha256(0x00 ‖ did ‖ head_cid)`
    /// and walks `steps` to recompute the root, comparing it to a `tentative_root()` it
    /// fetched independently (the proof server stays untrusted). Returns `("", [])` if `did`
    /// is not anchored. The proof is root-specific — use this against the tentative root only.
    fn tentative_proof(self: @TContractState, did: ByteArray) -> (ByteArray, Array<ProofStep>);
    /// Inclusion proof for `did`'s **confirmed** head against `confirmed_root()`. Returns
    /// `("", [])` if `did` has no confirmed head yet (all ops still within the 72h window).
    fn confirmed_proof(self: @TContractState, did: ByteArray) -> (ByteArray, Array<ProofStep>);
}

#[starknet::contract]
pub mod anchor {
    use core::poseidon::poseidon_hash_span;
    use starknet::storage::{
        Map, MutableVecTrait, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
        Vec, VecTrait,
    };
    use super::super::merkle::{leaves_of, merkle_proof, merkle_root, sort_entries, sorted_leaves};
    use super::super::state::{
        OpRecord, apply_op, confirmed_head as confirmed_head_of, genesis_record, record_from_signed,
        tentative_head,
    };
    use super::{IAnchor, ProofStep};

    #[storage]
    struct Storage {
        /// did_key → the per-DID op chain (genesis … head). Empty == not anchored.
        chains: Map<felt252, Vec<StoredOp>>,
        /// Append-only roster of anchored did_keys, so the commitment root can enumerate the
        /// map (a `Map` is not iterable). Each DID is pushed once, at genesis import.
        did_keys: Vec<felt252>,
        /// did_key → its did:plc string — the leaf preimage needs the DID itself, not just
        /// its storage hash.
        did_strs: Map<felt252, ByteArray>,
    }

    /// A chain entry: the op's signed bytes plus the metadata kept alongside it.
    #[derive(Drop, Serde, starknet::Store)]
    struct StoredOp {
        signed: ByteArray,
        created_at: u64,
        signer_index: usize,
        /// Provenance (SECURITY-TODO 4a): `true` for ops that entered via `import`/
        /// `import_genesis` (settled backfill), `false` for ops observed live via `submit_op`.
        /// A recovery may not nullify an imported op — see `state::apply_op`.
        imported: bool,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        Imported: Imported,
        Applied: Applied,
    }

    #[derive(Drop, starknet::Event)]
    struct Imported {
        #[key]
        did_key: felt252,
        head_cid: ByteArray,
    }

    #[derive(Drop, starknet::Event)]
    struct Applied {
        #[key]
        did_key: felt252,
        head_cid: ByteArray,
        signer_index: usize,
        nullified_count: usize,
    }

    #[abi(embed_v0)]
    pub impl AnchorImpl of IAnchor<ContractState> {
        fn import_genesis(ref self: ContractState, genesis_signed: ByteArray) -> ByteArray {
            let now = now_ms();
            let (key, did, record) = self.store_genesis(@genesis_signed, now);
            self.emit(Imported { did_key: key, head_cid: record.cid.clone() });
            did
        }

        fn import(ref self: ContractState, chain: Array<ByteArray>) -> ByteArray {
            if chain.len() == 0 {
                core::panic_with_felt252('empty-chain');
            }
            let now = now_ms();
            // Genesis seeds the DID and the running chain we replay successors against.
            let (key, did, genesis_rec) = self.store_genesis(chain.at(0), now);
            let mut records: Array<OpRecord> = array![genesis_rec];

            let mut i: usize = 1;
            while i < chain.len() {
                let signed = chain.at(i);
                let outcome = match apply_op(@records, signed, now) {
                    Result::Ok(o) => o,
                    Result::Err(e) => core::panic_with_felt252(e),
                };
                // A resolved history is pure appends; a successor that forks earlier (and so
                // would nullify ops) is not a clean import — reject it.
                if outcome.nullified_count != 0 {
                    core::panic_with_felt252('import-fork');
                }
                let signer_index = outcome.new_record.signer_index;
                self
                    .chains
                    .entry(key)
                    .push(
                        StoredOp {
                            signed: signed.clone(), created_at: now, signer_index, imported: true,
                        },
                    );
                records.append(outcome.new_record);
                i += 1;
            }

            self.emit(Imported { did_key: key, head_cid: tentative_head(@records) });
            did
        }

        fn submit_op(ref self: ContractState, did: ByteArray, proposed_signed: ByteArray) {
            let key = did_key(@did);
            let chain = self.load_chain(key);
            if chain.len() == 0 {
                core::panic_with_felt252('did-not-anchored');
            }
            let now = now_ms();
            let outcome = match apply_op(@chain, @proposed_signed, now) {
                Result::Ok(o) => o,
                Result::Err(e) => core::panic_with_felt252(e),
            };
            let head_cid = outcome.new_record.cid.clone();
            let signer_index = outcome.new_record.signer_index;
            let nullified_count = outcome.nullified_count;

            // Truncate the stored chain to the fork point, then append the new op.
            let vec = self.chains.entry(key);
            let keep = outcome.fork_index + 1;
            while vec.len().try_into().unwrap() > keep {
                let _ = vec.pop();
            }
            // Observed live: `submit_op` is the only path that stamps `imported: false`, so the
            // 72h recovery window is measured against a block time that approximates this op's
            // real authored time (SECURITY-TODO 4a). Truncation only ever removes live ops (a
            // recovery cannot fork below an imported op), so the imported prefix stays intact.
            vec
                .push(
                    StoredOp {
                        signed: proposed_signed, created_at: now, signer_index, imported: false,
                    },
                );

            self.emit(Applied { did_key: key, head_cid, signer_index, nullified_count });
        }

        fn head_cid(self: @ContractState, did: ByteArray) -> ByteArray {
            tentative_head(@self.load_chain(did_key(@did)))
        }

        fn confirmed_head(self: @ContractState, did: ByteArray) -> ByteArray {
            confirmed_head_of(@self.load_chain(did_key(@did)), now_ms())
        }

        fn is_anchored(self: @ContractState, did: ByteArray) -> bool {
            self.chains.entry(did_key(@did)).len() != 0
        }

        fn tentative_root(self: @ContractState) -> ByteArray {
            self.commitment_root(false, 0)
        }

        fn confirmed_root(self: @ContractState) -> ByteArray {
            self.commitment_root(true, now_ms())
        }

        fn tentative_proof(self: @ContractState, did: ByteArray) -> (ByteArray, Array<ProofStep>) {
            self.tier_proof(did, false, 0)
        }

        fn confirmed_proof(self: @ContractState, did: ByteArray) -> (ByteArray, Array<ProofStep>) {
            self.tier_proof(did, true, now_ms())
        }
    }

    #[generate_trait]
    impl Internal of InternalTrait {
        /// Verify a genesis op, register the DID (chain seed + roster + did-string), and
        /// return `(key, did, genesis_record)`. Shared by `import_genesis` and `import`.
        /// Reverts if the op is not a valid self-authorized genesis or the DID already exists.
        fn store_genesis(
            ref self: ContractState, genesis_signed: @ByteArray, now: u64,
        ) -> (felt252, ByteArray, OpRecord) {
            let (did, record) = match genesis_record(genesis_signed, now) {
                Result::Ok(r) => r,
                Result::Err(e) => core::panic_with_felt252(e),
            };
            let key = did_key(@did);
            if self.chains.entry(key).len() != 0 {
                core::panic_with_felt252('already-anchored');
            }
            self
                .chains
                .entry(key)
                .push(
                    StoredOp {
                        signed: genesis_signed.clone(),
                        created_at: now,
                        signer_index: 0,
                        imported: true,
                    },
                );
            // Roster + did-string, so the commitment root can enumerate this DID.
            self.did_keys.push(key);
            self.did_strs.entry(key).write(did.clone());
            (key, did, record)
        }

        /// Build the DID→head commitment root over the whole roster. `confirmed` selects the
        /// confirmed head (past the 72h window at `now`) vs the tentative tip; DIDs with no
        /// qualifying head (no confirmed op yet) are omitted from the map. O(total ops) in
        /// hashing — a read-time view, so the recovery-window writes stay cheap (the write
        /// vs proof cost tradeoff, REFERENCE.md §4).
        fn commitment_root(self: @ContractState, confirmed: bool, now: u64) -> ByteArray {
            merkle_root(@sorted_leaves(self.collect_entries(confirmed, now)))
        }

        /// The `{did → head}` map at one tier: every anchored DID whose selected head is
        /// non-empty (`confirmed` → the head past the 72h window at `now`, else the tentative
        /// tip), in roster order. The shared substrate of both the root and the inclusion
        /// proof, so they commit to the identical entry set. O(total ops) — a read-time view.
        fn collect_entries(
            self: @ContractState, confirmed: bool, now: u64,
        ) -> Array<(ByteArray, ByteArray)> {
            let n = self.did_keys.len();
            let mut entries: Array<(ByteArray, ByteArray)> = array![];
            let mut i: u64 = 0;
            while i < n {
                let key = self.did_keys.at(i).read();
                let chain = self.load_chain(key);
                let head = if confirmed {
                    confirmed_head_of(@chain, now)
                } else {
                    tentative_head(@chain)
                };
                if head.len() != 0 {
                    entries.append((self.did_strs.entry(key).read(), head));
                }
                i += 1;
            }
            entries
        }

        /// Inclusion proof for `did` at one tier: collect the same entry set the root commits
        /// to, sort it canonically, locate `did`'s leaf, and return `(head, merkle_proof)`.
        /// `("", [])` if `did` has no head at this tier (not anchored, or no confirmed op
        /// yet). Sorting once and deriving the leaves from the sorted entries keeps the proof
        /// path and the root in lockstep (`merkle`).
        fn tier_proof(
            self: @ContractState, did: ByteArray, confirmed: bool, now: u64,
        ) -> (ByteArray, Array<ProofStep>) {
            let sorted = sort_entries(self.collect_entries(confirmed, now));
            let m = sorted.len();
            let mut idx = 0;
            let mut head_out: ByteArray = "";
            let mut found = false;
            let mut i = 0;
            while i < m {
                let (d, h) = sorted.at(i).clone();
                if d == did {
                    idx = i;
                    head_out = h;
                    found = true;
                    break;
                }
                i += 1;
            }
            if !found {
                return ("", array![]);
            }
            (head_out, merkle_proof(@leaves_of(@sorted), idx))
        }

        /// Materialize the stored chain as `OpRecord`s (CID + rotation keys decoded from each
        /// op's bytes).
        fn load_chain(self: @ContractState, key: felt252) -> Array<OpRecord> {
            let vec = self.chains.entry(key);
            let n = vec.len();
            let mut out: Array<OpRecord> = array![];
            let mut i: u64 = 0;
            while i < n {
                let stored = vec.at(i).read();
                let record =
                    match record_from_signed(
                        @stored.signed, stored.created_at, stored.signer_index, stored.imported,
                    ) {
                    Result::Ok(r) => r,
                    Result::Err(e) => core::panic_with_felt252(e),
                };
                out.append(record);
                i += 1;
            }
            out
        }
    }

    /// Block timestamp in milliseconds (seconds × 1000) — the pragmatic createdAt the 72h
    /// window measures against (§1, §4).
    fn now_ms() -> u64 {
        starknet::get_block_timestamp() * 1000
    }

    /// Storage key for a DID: Poseidon over its serialized bytes.
    fn did_key(did: @ByteArray) -> felt252 {
        let mut out: Array<felt252> = array![];
        did.serialize(ref out);
        poseidon_hash_span(out.span())
    }
}
