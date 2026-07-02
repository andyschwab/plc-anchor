//! Auth seam for the console — a pluggable `Authenticator` gate over the mutating routes.
//!
//! This is **Layer-2 access control** (who may curate the roster / trigger the on-chain spend),
//! *not* contract authorization. On-chain authz stays the op's embedded signature and the fee
//! payer is irrelevant — the permissionless property (REFERENCE.md §2). Gating this admin UI is a
//! separate concern and does not touch that.
//!
//! The seam is the point: the shared-secret MVP here can be swapped for wallet-signature
//! ("sign-in with Starknet") verification without touching the routes — only `login`/`verify`
//! change. `SharedSecretAuth` mints a short-lived HMAC session from a single operator secret, so
//! a leaked request expires and the long-lived secret never rides on every call.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface Session {
  token: string;
  /** epoch ms after which the token is rejected. */
  expiresAt: number;
}

export interface Authenticator {
  /** Mint a session from a login body, or null if the credential is wrong/missing. */
  login(body: unknown): Session | null;
  /** True iff the request carries a currently-valid session credential. */
  verify(req: IncomingMessage): boolean;
}

/** Shared-secret auth: one operator secret exchanged for a short-lived HMAC-signed bearer token.
 * The token is `${expiresAt}.${base64url(HMAC-SHA256(secret, expiresAt))}` — stateless, so there
 * is no session store; validity is a signature check plus an expiry check. */
export class SharedSecretAuth implements Authenticator {
  readonly #secret: string;
  readonly #ttlMs: number;
  /** Per-process key for constant-time string compares that don't leak length. */
  readonly #cmpKey: Buffer;

  constructor(secret: string, ttlMs = 3_600_000) {
    if (!secret) throw new Error("SharedSecretAuth requires a non-empty secret");
    this.#secret = secret;
    this.#ttlMs = ttlMs;
    this.#cmpKey = randomBytes(32);
  }

  login(body: unknown): Session | null {
    const provided = body !== null && typeof body === "object"
      ? (body as Record<string, unknown>).secret
      : undefined;
    if (typeof provided !== "string" || !this.#eq(provided, this.#secret)) return null;
    const expiresAt = Date.now() + this.#ttlMs;
    return { token: this.#mint(expiresAt), expiresAt };
  }

  verify(req: IncomingMessage): boolean {
    const token = bearer(req);
    return token !== null && this.#check(token);
  }

  #mint(expiresAt: number): string {
    const payload = String(expiresAt);
    return `${payload}.${this.#sign(payload)}`;
  }

  #check(token: string): boolean {
    const dot = token.indexOf(".");
    if (dot <= 0) return false;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!this.#eq(sig, this.#sign(payload))) return false;
    const exp = Number(payload);
    return Number.isFinite(exp) && exp > Date.now();
  }

  #sign(payload: string): string {
    return createHmac("sha256", this.#secret).update(payload).digest("base64url");
  }

  /** Constant-time equality that also hides length (compares HMACs, not raw bytes). */
  #eq(a: string, b: string): boolean {
    const ha = createHmac("sha256", this.#cmpKey).update(a).digest();
    const hb = createHmac("sha256", this.#cmpKey).update(b).digest();
    return timingSafeEqual(ha, hb);
  }
}

/** Extract a `Authorization: Bearer <token>` header, or null. */
function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}
