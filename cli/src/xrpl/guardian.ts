// Thin client for the Guardian / Wormholescan signed-VAA API.
//
// Ported from ripple/xrpl-client/src/integration/fetch-vaa.ts. The guardian
// watcher synthesizes a VAA from an XRPL payment; this fetches it by
// (chain, emitter, sequence) and polls until it is available.

export const DEFAULT_GUARDIAN_API = "https://api.testnet.wormholescan.io";

export const CHAIN_ID_XRPL = 66;

/**
 * Build the signed-VAA URL for a (chain, emitter, sequence) tuple.
 * emitter is a 64-char hex string (no 0x).
 */
export function signedVaaUrl(
  guardianApi: string,
  chain: number,
  emitterHex: string,
  sequence: bigint,
): string {
  return `${guardianApi}/v1/signed_vaa/${chain}/${emitterHex}/${sequence}`;
}

/** Fetch a signed VAA once; returns base64 vaaBytes or null if not yet available. */
export async function fetchSignedVaaOnce(
  url: string,
): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { vaaBytes?: string };
    return data.vaaBytes ?? null;
  } catch {
    return null;
  }
}

/** Poll the guardian API for a signed VAA until it appears or timeout. */
export async function pollSignedVaa(opts: {
  guardianApi: string;
  chain: number;
  emitterHex: string;
  sequence: bigint;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  onAttempt?: (attempt: number, url: string) => void;
}): Promise<string> {
  const {
    guardianApi,
    chain,
    emitterHex,
    sequence,
    pollIntervalMs = 5_000,
    pollTimeoutMs = 120_000,
  } = opts;
  const url = signedVaaUrl(guardianApi, chain, emitterHex, sequence);

  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < pollTimeoutMs) {
    attempt++;
    opts.onAttempt?.(attempt, url);
    const vaa = await fetchSignedVaaOnce(url);
    if (vaa) return vaa;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(
    `VAA not found after ${Math.round(pollTimeoutMs / 1000)}s (${attempt} attempts): ${url}`,
  );
}
