// XRPL client + wallet helpers for the `ntt xrpl` commands.
//
// Mirrors ripple/xrpl-client/src/integration/config.ts: the signing key comes
// from `--seed` or the XRPL_SEED env var, and we default to the secp256k1
// algorithm (matching the existing scripts). The wallet/seed is the admin.

import { Client, Wallet } from "xrpl";
import _ECDSA from "xrpl/dist/npm/ECDSA.js";

// ESM/CJS interop: the default export may be double-wrapped.
const ECDSA = (_ECDSA as any).default ?? _ECDSA;

export const DEFAULT_XRPL_RPC = "wss://s.altnet.rippletest.net:51233";

/**
 * Build an XRPL Wallet from a seed (flag) or the XRPL_SEED env var.
 *
 * @param seed - seed from a `--seed` flag (takes precedence over env)
 * @param secp256k1 - use secp256k1 (default true, matching the scripts); set
 *   false for ed25519 seeds.
 */
export function getXrplWallet(seed?: string, secp256k1 = true): Wallet {
  const s = seed ?? process.env.XRPL_SEED;
  if (!s) {
    throw new Error(
      "XRPL seed required: pass --seed or set XRPL_SEED in the environment",
    );
  }
  return secp256k1
    ? Wallet.fromSeed(s, { algorithm: ECDSA.secp256k1 })
    : Wallet.fromSeed(s);
}

/**
 * Run `fn` with a connected XRPL client, disconnecting afterwards unless a
 * client was provided by the caller.
 */
export async function withXrplClient<T>(
  rpc: string,
  fn: (client: Client) => Promise<T>,
  providedClient?: Client,
): Promise<T> {
  const client = providedClient ?? new Client(rpc);
  const ownsClient = !providedClient;
  if (ownsClient) await client.connect();
  try {
    return await fn(client);
  } finally {
    if (ownsClient && client.isConnected()) await client.disconnect();
  }
}
