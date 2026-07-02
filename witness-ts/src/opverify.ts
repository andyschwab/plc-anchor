//! PLC op interpretation + authorized-signer resolution — the resolver-side mirror of
//! `cairo/packages/plc_core/src/{op_decode,op_verify}.cairo`.
//!
//! Pulls the fields recovery re-derivation needs out of a directory-served operation object and
//! resolves *which* authorized rotation key signed it. Authorization is the op's embedded
//! signature verified against an allowed-key set (a genesis op's own keys, or the fork-point op's
//! keys) — never the transport (REFERENCE.md §2). The signer's index in that set is the
//! recovery-priority operand the 72h state machine consumes.

import { encodeDagCbor } from "./dagcbor.ts";
import { verifySig } from "./crypto.ts";

/** The fields of a PLC op that recovery re-derivation depends on. */
export interface OpFields {
  /** `prev` CID string, or `null` for a genesis op. */
  prev: string | null;
  /** The op's *own* declared rotation keys, priority-ordered (index 0 = highest). Legacy `create`
   * normalises to `[recoveryKey, signingKey]`; a tombstone has none. These authorise the *next*
   * op that builds on this one. */
  rotationKeys: string[];
  /** True for a `plc_tombstone` — a dead end nothing may build on. */
  tombstone: boolean;
}

/** Interpret a directory-served operation object (mirrors `op_decode.cairo`'s field extraction
 * + legacy-`create` normalisation). Returns `null` if the object isn't a structurally usable op
 * (missing/mistyped fields) — the caller treats that as an invalid op. */
export function readOp(operation: unknown): OpFields | null {
  if (typeof operation !== "object" || operation === null) return null;
  const op = operation as Record<string, unknown>;

  const type = op.type;
  if (typeof type !== "string") return null;

  // `prev` is present on every op (genesis sets it to null); a non-null prev must be a string.
  let prev: string | null;
  if (op.prev === null || op.prev === undefined) prev = null;
  else if (typeof op.prev === "string") prev = op.prev;
  else return null;

  if (type === "plc_tombstone") {
    return { prev, rotationKeys: [], tombstone: true };
  }

  if (type === "create") {
    // Legacy genesis: rotationKeys = [recoveryKey, signingKey] (recovery is higher priority).
    const { recoveryKey, signingKey } = op;
    if (typeof recoveryKey !== "string" || typeof signingKey !== "string") return null;
    return { prev, rotationKeys: [recoveryKey, signingKey], tombstone: false };
  }

  if (type === "plc_operation") {
    const rk = op.rotationKeys;
    if (!Array.isArray(rk) || rk.some((k) => typeof k !== "string")) return null;
    return { prev, rotationKeys: rk as string[], tombstone: false };
  }

  return null; // unknown op type
}

/**
 * Resolve the index of the authorized key that signed `operation`, verifying the embedded `sig`
 * over the DRISL-encoded *unsigned* op (sig field removed). The TS analog of
 * `op_verify.cairo::verify_op_authorized`: keys are tried in priority order and the first that
 * validates wins. Returns its index in `allowedKeys`, or `-1` if none does.
 */
export function verifyOpAuthorized(operation: unknown, allowedKeys: readonly string[]): number {
  if (typeof operation !== "object" || operation === null) return -1;
  const { sig, ...unsigned } = operation as Record<string, unknown>;
  if (typeof sig !== "string") return -1;
  const unsignedBytes = encodeDagCbor(unsigned);
  for (let i = 0; i < allowedKeys.length; i += 1) {
    if (verifySig(allowedKeys[i], unsignedBytes, sig)) return i;
  }
  return -1;
}
