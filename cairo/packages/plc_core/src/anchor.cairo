//! The permissionless anchor endpoint (REFERENCE.md §2, §3 component 3, §4).
//!
//! A Starknet contract holding a per-DID op chain (the recovery window) with:
//!   - `import_genesis(genesis_signed)` — verify a self-authorized genesis op, start its
//!     chain, and return the derived did:plc.
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

#[starknet::interface]
pub trait IAnchor<TContractState> {
    /// Import a genesis op; returns its did:plc. Reverts if the DID is already anchored or
    /// the op is not a valid self-authorized genesis.
    fn import_genesis(ref self: TContractState, genesis_signed: ByteArray) -> ByteArray;
    /// Append or recover onto `did`. Reverts on unknown DID, bad linkage/signature, a
    /// tombstoned fork point, or an invalid/late recovery.
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
}

#[starknet::contract]
pub mod anchor {
    use core::poseidon::poseidon_hash_span;
    use starknet::storage::{
        Map, MutableVecTrait, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
        Vec, VecTrait,
    };
    use super::IAnchor;
    use super::super::merkle::{merkle_root, sorted_leaves};
    use super::super::state::{
        OpRecord, apply_op, confirmed_head as confirmed_head_of, genesis_record, record_from_signed,
        tentative_head,
    };

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
            let (did, record) = match genesis_record(@genesis_signed, now) {
                Result::Ok(r) => r,
                Result::Err(e) => core::panic_with_felt252(e),
            };
            let key = did_key(@did);
            if self.chains.entry(key).len() != 0 {
                core::panic_with_felt252('already-anchored');
            }
            let head_cid = record.cid.clone();
            self
                .chains
                .entry(key)
                .push(StoredOp { signed: genesis_signed, created_at: now, signer_index: 0 });
            // Roster + did-string, so the commitment root can enumerate this DID.
            self.did_keys.push(key);
            self.did_strs.entry(key).write(did.clone());
            self.emit(Imported { did_key: key, head_cid });
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
            vec.push(StoredOp { signed: proposed_signed, created_at: now, signer_index });

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
    }

    #[generate_trait]
    impl Internal of InternalTrait {
        /// Build the DID→head commitment root over the whole roster. `confirmed` selects the
        /// confirmed head (past the 72h window at `now`) vs the tentative tip; DIDs with no
        /// qualifying head (no confirmed op yet) are omitted from the map. O(total ops) in
        /// hashing — a read-time view, so the recovery-window writes stay cheap (the write
        /// vs proof cost tradeoff, REFERENCE.md §4).
        fn commitment_root(self: @ContractState, confirmed: bool, now: u64) -> ByteArray {
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
            merkle_root(@sorted_leaves(entries))
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
                        @stored.signed, stored.created_at, stored.signer_index,
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
