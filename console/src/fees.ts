//! Fee resolution — read a Starknet tx's `actual_fee` so the console can report anchoring cost.
//!
//! ingest emits the tx hash on stdout (`ANCHORED <did> tx=<hash>`); the *cost* lives on the tx
//! receipt, which we fetch here via a plain `starknet_getTransactionReceipt` JSON-RPC call (the
//! console already has `STARKNET_RPC` for the read side). Kept tiny and dependency-free; the
//! `Fetcher` seam makes it offline-testable. Returns null on any failure so cost capture only ever
//! degrades to count-only, never breaks onboarding.

import type { FeeResolver } from "./onboard.ts";

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Parse an `actual_fee` value (hex `0x…` or decimal) into a decimal string, or null. */
export function feeToDecimal(actualFee: unknown): string | null {
  // Spec 0.6+: `{ amount, unit }`. Older shape: a bare hex string.
  const raw =
    actualFee !== null && typeof actualFee === "object"
      ? (actualFee as Record<string, unknown>).amount
      : actualFee;
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return BigInt(raw).toString();
  } catch {
    return null;
  }
}

/** Build a `FeeResolver` over a Starknet JSON-RPC endpoint. */
export function starknetFeeResolver(rpcUrl: string, fetcher: Fetcher = (u, i) => fetch(u, i)): FeeResolver {
  return async (txHash: string): Promise<string | null> => {
    const res = await fetcher(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "starknet_getTransactionReceipt",
        params: [txHash],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { actual_fee?: unknown } };
    return feeToDecimal(body.result?.actual_fee);
  };
}
