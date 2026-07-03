//! The permissionless anchor endpoint — **verify-on-read** (REFERENCE.md §1, §2, §3
//! component 3; docs/ONCHAIN-REARCH-PLAN.md).
//!
//! A Starknet contract holding a per-DID **append-only log of op bytes**, block-timestamped.
//! It does **no** signature/CID verification and no fork adjudication: those moved to the
//! read side (the witness re-derives the whole chain from these bytes — `witness-ts`), because
//! on-chain EC verification was ~100% of the measured cost while the op log already
//! self-certifies. The contract's job shrank to *store what was submitted, stamp it with block
//! time + provenance, and expose it.*
//!
//!   - `import_genesis(genesis_signed)` — store a genesis op, keyed by its derived did:plc, and
//!     return the DID. (The DID is `did:plc:` + base32(sha256(signed))[..24] — a hash, not EC
//!     crypto; it only *keys storage / names the DID*, it does not verify the op.)
//!   - `import(chain)` — store a DID's resolved history in one call (`chain[0]` = genesis).
//!     Every stored op is marked **settled** (`imported: true`).
//!   - `submit_op(did, proposed_signed)` — append one op, observed **live** (`imported:
//!     false`). No linkage/fork logic: a superseding op is simply appended, exactly like a
//!     directory audit log; the reader adjudicates recovery/nullification (72h higher-priority
//!     rule + recovery-of-imported) from the bytes + block-time stamps.
//!   - views: `is_anchored(did)` and `chain(did)` — the raw ops + their block-time stamps +
//!     provenance, everything a reader needs to validate independently.
//!
//! **Non-equivocation** is preserved (identical bytes for everyone on the public chain);
//! **validity** is a read-side property (the reader rejects a bogus chain — sigs won't verify /
//! won't link — so a bad entry is rejected *by readers*, not by the contract). The
//! block-timestamp stamp is the anchor's **independent clock** the 72h window measures against
//! (`createdAt` is not in the signed op; §1, §4), and it is the contract's — not the
//! submitter's — so the confirmed head a reader derives is still independent of the directory.
//!
//! Writes are permissionless (the Starknet tx signer / fee payer may be anyone; §2). A writer
//! can store unverified/garbage ops, but they are rejected read-side and cost the writer gas;
//! bulk storage-spam mitigation (operator-gating or fee friction) is off-chain policy for V1
//! (the permissionless write path is a backstop, not the V1 headline; §1a).

#[starknet::interface]
pub trait IAnchor<TContractState> {
    /// Store a genesis op; returns its did:plc. Reverts if the DID is already anchored. The op
    /// is **not** verified here — the reader validates it (a non-genesis / unauthorized op
    /// stored as "genesis" simply reads back `absent`, since the reader re-derives the DID from
    /// the bytes and re-checks self-authorization). Marked settled (`imported: true`).
    fn import_genesis(ref self: TContractState, genesis_signed: ByteArray) -> ByteArray;
    /// Store a DID's history in one call: `chain[0]` is the genesis op and `chain[1..]` its
    /// successors in order. The DID is derived from `chain[0]`. Every op is marked **settled**
    /// (`imported: true`), so a later `submit_op` recovery may not nullify it read-side
    /// (`recovery-of-imported`; SECURITY-TODO 4a) — their import-time block stamp is not their
    /// real authored time. No linkage/signature check: the reader validates the resolved chain.
    /// Returns the derived did:plc. Reverts on an empty chain or an already-anchored DID. This
    /// is the onboarding path.
    fn import(ref self: TContractState, chain: Array<ByteArray>) -> ByteArray;
    /// Append one op to `did`, observed **live** (`imported: false`) — its block-time stamp
    /// approximates its real authored time, so the reader's 72h recovery window applies to it.
    /// The op is appended verbatim (a recovery/fork is just another appended entry; the reader
    /// re-derives which ops are live). Reverts only if the DID is not anchored.
    fn submit_op(ref self: TContractState, did: ByteArray, proposed_signed: ByteArray);
    /// Whether `did` is anchored (has at least one stored op).
    fn is_anchored(self: @TContractState, did: ByteArray) -> bool;
    /// The full stored op log for `did` (oldest-first, including any superseded ops), each with
    /// its block-time stamp (ms) and provenance flag. `[]` if not anchored. This is the reader's
    /// sole input from the anchor: it recomputes each op's CID from `signed`, cross-references
    /// the op body content-addressed, re-derives the live chain + confirmed head (72h window
    /// against `created_at`), and compares to the directory. RPC-trusted for the bytes (finding
    /// 4c: a trustless read needs a Starknet storage proof against the L1-settled state root).
    fn chain(self: @TContractState, did: ByteArray) -> Array<OpEntry>;
}

/// One stored op as returned by `chain`: the signed DRISL bytes, the Starknet block time (ms)
/// when it was stored (the anchor's independent observation clock the 72h window uses), and
/// whether it entered settled (`import`/`import_genesis`) or live (`submit_op`).
#[derive(Drop, Serde)]
pub struct OpEntry {
    pub signed: ByteArray,
    pub created_at: u64,
    pub imported: bool,
}

#[starknet::contract]
pub mod anchor {
    use core::poseidon::poseidon_hash_span;
    use drisl::cid::derive_did_fragment;
    use starknet::storage::{
        Map, MutableVecTrait, StoragePathEntry, StoragePointerReadAccess, Vec, VecTrait,
    };
    use super::{IAnchor, OpEntry};

    #[storage]
    struct Storage {
        /// did_key → the per-DID append-only op log (genesis … tip). Empty == not anchored.
        chains: Map<felt252, Vec<StoredOp>>,
    }

    /// A stored log entry: the op's signed bytes + the block time it was stored + provenance.
    /// No verification-derived fields (CID / signer index / rotation keys): the reader
    /// recomputes those from `signed`.
    #[derive(Drop, Serde, starknet::Store)]
    struct StoredOp {
        signed: ByteArray,
        created_at: u64,
        /// `true` for ops stored via `import`/`import_genesis` (settled backfill), `false` for
        /// ops observed live via `submit_op`. The reader refuses a recovery that nullifies an
        /// imported op (SECURITY-TODO 4a).
        imported: bool,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        Stored: Stored,
    }

    /// Emitted once per store call, keyed by DID, carrying how many ops the log now holds — a
    /// cheap index for off-chain followers (no head CID: the contract does not derive it).
    #[derive(Drop, starknet::Event)]
    struct Stored {
        #[key]
        did_key: felt252,
        op_count: usize,
        imported: bool,
    }

    #[abi(embed_v0)]
    pub impl AnchorImpl of IAnchor<ContractState> {
        fn import_genesis(ref self: ContractState, genesis_signed: ByteArray) -> ByteArray {
            let did = did_of_genesis(@genesis_signed);
            let key = self.seed_did(@did);
            self.push_op(key, genesis_signed, true);
            did
        }

        fn import(ref self: ContractState, chain: Array<ByteArray>) -> ByteArray {
            if chain.len() == 0 {
                core::panic_with_felt252('empty-chain');
            }
            let did = did_of_genesis(chain.at(0));
            let key = self.seed_did(@did);
            let mut i: usize = 0;
            while i < chain.len() {
                // `chain.at(i).clone()` — store each op verbatim, settled.
                self.push_op(key, chain.at(i).clone(), true);
                i += 1;
            }
            did
        }

        fn submit_op(ref self: ContractState, did: ByteArray, proposed_signed: ByteArray) {
            let key = did_key(@did);
            if self.chains.entry(key).len() == 0 {
                core::panic_with_felt252('did-not-anchored');
            }
            self.push_op(key, proposed_signed, false);
        }

        fn is_anchored(self: @ContractState, did: ByteArray) -> bool {
            self.chains.entry(did_key(@did)).len() != 0
        }

        fn chain(self: @ContractState, did: ByteArray) -> Array<OpEntry> {
            let vec = self.chains.entry(did_key(@did));
            let n = vec.len();
            let mut out: Array<OpEntry> = array![];
            let mut i: u64 = 0;
            while i < n {
                let stored = vec.at(i).read();
                out
                    .append(
                        OpEntry {
                            signed: stored.signed,
                            created_at: stored.created_at,
                            imported: stored.imported,
                        },
                    );
                i += 1;
            }
            out
        }
    }

    #[generate_trait]
    impl Internal of InternalTrait {
        /// Register a fresh DID (revert if it already has any stored op). Returns its storage key.
        fn seed_did(ref self: ContractState, did: @ByteArray) -> felt252 {
            let key = did_key(did);
            if self.chains.entry(key).len() != 0 {
                core::panic_with_felt252('already-anchored');
            }
            key
        }

        /// Append one op to a DID's log with the current block time and the given provenance,
        /// and emit the running op count.
        fn push_op(ref self: ContractState, key: felt252, signed: ByteArray, imported: bool) {
            self.chains.entry(key).push(StoredOp { signed, created_at: now_ms(), imported });
            self
                .emit(
                    Stored {
                        did_key: key,
                        op_count: self.chains.entry(key).len().try_into().unwrap(),
                        imported,
                    },
                );
        }
    }

    /// The did:plc for a genesis op: `did:plc:` + base32(sha256(signed))[..24]. A hash of the
    /// bytes (no EC crypto, no decode) — it names/keys the DID; it does not verify the op.
    fn did_of_genesis(genesis_signed: @ByteArray) -> ByteArray {
        let mut did: ByteArray = "did:plc:";
        did.append(@derive_did_fragment(genesis_signed));
        did
    }

    /// Block timestamp in milliseconds (seconds × 1000) — the anchor's independent observation
    /// clock the read-side 72h window measures against (§1, §4).
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
