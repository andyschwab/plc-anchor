//! The permissionless anchor endpoint (REFERENCE.md §2, §3 component 3).
//!
//! A Starknet contract with one per-DID head and two entrypoints:
//!   - `import_genesis(genesis_signed)` — verify a self-authorized genesis op and record its
//!     head, returning the derived did:plc.
//!   - `submit_op(did, proposed_signed)` — append a signed op onto the DID's head.
//!
//! Authorization is the op's *embedded* signature, verified in-contract against the head's
//! rotation keys (`state`). The Starknet tx signer / fee payer is irrelevant and may be
//! anyone — that is the permissionless property (REFERENCE.md §2); native AA / paymasters are
//! for gas/UX only, never authorization.
//!
//! Storage is the head op's signed DRISL bytes per DID; the head CID, authorizing rotation
//! keys, and tombstone status all derive from it (`state::head_from_signed`), so no
//! awkward collection-in-storage. The confirmed/tentative tiers + commitment root (§4, P3.2,
//! P3.3) layer on top; this is the append spine.

#[starknet::interface]
pub trait IAnchor<TContractState> {
    /// Import a genesis op; returns its did:plc. Reverts if the DID is already anchored or
    /// the op is not a valid self-authorized genesis.
    fn import_genesis(ref self: TContractState, genesis_signed: ByteArray) -> ByteArray;
    /// Append a signed op onto `did`'s head (the `submit_op` path). Reverts on any invalid
    /// linkage / signature / unknown DID / tombstoned head.
    fn submit_op(ref self: TContractState, did: ByteArray, proposed_signed: ByteArray);
    /// The current head CID string for `did`, or "" if not anchored.
    fn head_cid(self: @TContractState, did: ByteArray) -> ByteArray;
    /// Whether `did` is anchored.
    fn is_anchored(self: @TContractState, did: ByteArray) -> bool;
}

#[starknet::contract]
pub mod anchor {
    use core::poseidon::poseidon_hash_span;
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use super::IAnchor;
    use super::super::state::{
        apply_append, head_from_signed, import_genesis as state_import_genesis,
    };

    #[storage]
    struct Storage {
        /// did_key → the head op's signed DRISL bytes. Empty == not anchored.
        heads: Map<felt252, ByteArray>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        Imported: Imported,
        Appended: Appended,
    }

    #[derive(Drop, starknet::Event)]
    struct Imported {
        #[key]
        did_key: felt252,
        head_cid: ByteArray,
    }

    #[derive(Drop, starknet::Event)]
    struct Appended {
        #[key]
        did_key: felt252,
        head_cid: ByteArray,
        signer_index: usize,
    }

    #[abi(embed_v0)]
    pub impl AnchorImpl of IAnchor<ContractState> {
        fn import_genesis(ref self: ContractState, genesis_signed: ByteArray) -> ByteArray {
            let (did, head) = match state_import_genesis(@genesis_signed) {
                Result::Ok(r) => r,
                Result::Err(e) => core::panic_with_felt252(e),
            };
            let key = did_key(@did);
            // Self-certifying genesis ⇒ the DID is a hash of these bytes; re-import is a
            // no-op at best, so reject it to keep the head write-once until a successor.
            if self.heads.read(key).len() != 0 {
                core::panic_with_felt252('already-anchored');
            }
            self.heads.write(key, genesis_signed);
            self.emit(Imported { did_key: key, head_cid: head.head_cid });
            did
        }

        fn submit_op(ref self: ContractState, did: ByteArray, proposed_signed: ByteArray) {
            let key = did_key(@did);
            let head_signed = self.heads.read(key);
            if head_signed.len() == 0 {
                core::panic_with_felt252('did-not-anchored');
            }
            let head = match head_from_signed(@head_signed) {
                Result::Ok(h) => h,
                Result::Err(e) => core::panic_with_felt252(e),
            };
            let now = starknet::get_block_timestamp();
            let (new_head, signer_index) = match apply_append(@head, @proposed_signed, now) {
                Result::Ok(r) => r,
                Result::Err(e) => core::panic_with_felt252(e),
            };
            let head_cid = new_head.head_cid;
            self.heads.write(key, proposed_signed);
            self.emit(Appended { did_key: key, head_cid, signer_index });
        }

        fn head_cid(self: @ContractState, did: ByteArray) -> ByteArray {
            let head_signed = self.heads.read(did_key(@did));
            if head_signed.len() == 0 {
                return "";
            }
            match head_from_signed(@head_signed) {
                Result::Ok(h) => h.head_cid,
                Result::Err(e) => core::panic_with_felt252(e),
            }
        }

        fn is_anchored(self: @ContractState, did: ByteArray) -> bool {
            self.heads.read(did_key(@did)).len() != 0
        }
    }

    /// Storage key for a DID: Poseidon over its serialized bytes.
    fn did_key(did: @ByteArray) -> felt252 {
        let mut out: Array<felt252> = array![];
        did.serialize(ref out);
        poseidon_hash_span(out.span())
    }
}
