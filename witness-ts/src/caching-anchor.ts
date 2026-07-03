//! A per-cycle cache for the anchor's contract-wide roots (RPC cost optimization).
//!
//! `confirmedRoot()`/`tentativeRoot()` return the *same value for every DID* in a given
//! `refreshAll()` pass — a console driving N DIDs through `check()` was issuing N redundant
//! `starknet_call`s for a value that changes only once per anchoring cycle. This wraps any
//! `AnchorView` and memoizes those two reads until `reset()` is called (once per refresh cycle
//! by the caller), while `isAnchored`/`confirmedProof`/`tentativeProof` — genuinely per-DID —
//! pass straight through.

import type { AnchorView } from "./status.ts";

export class CachingAnchorView implements AnchorView {
  readonly #inner: AnchorView;
  #confirmedRoot: Promise<Uint8Array> | null = null;
  #tentativeRoot: Promise<Uint8Array> | null = null;

  constructor(inner: AnchorView) {
    this.#inner = inner;
  }

  /** Drop the cached roots so the next read fetches fresh values. Call once per refresh cycle. */
  reset(): void {
    this.#confirmedRoot = null;
    this.#tentativeRoot = null;
  }

  isAnchored(did: string): Promise<boolean> {
    return this.#inner.isAnchored(did);
  }

  confirmedProof(did: string): ReturnType<AnchorView["confirmedProof"]> {
    return this.#inner.confirmedProof(did);
  }

  tentativeProof(did: string): ReturnType<AnchorView["tentativeProof"]> {
    return this.#inner.tentativeProof(did);
  }

  confirmedRoot(): Promise<Uint8Array> {
    if (this.#confirmedRoot === null) this.#confirmedRoot = this.#inner.confirmedRoot();
    return this.#confirmedRoot;
  }

  tentativeRoot(): Promise<Uint8Array> {
    if (this.#tentativeRoot === null) this.#tentativeRoot = this.#inner.tentativeRoot();
    return this.#tentativeRoot;
  }
}
