// Thin client for the w7-executor public HTTP API (/v0).
//
// Endpoints used (w7-executor/src/api):
//   POST /v0/quote      { srcChain, dstChain, relayInstructions } → { signedQuote, estimatedCost }
//   POST /v0/status/tx  { chainId, txHash } → RelayTransaction[]   (also triggers indexing)
//
// There is NO "submit request" endpoint: a relay request IS an XRPL Payment
// carrying an `application/x-executor-request` memo. After submitting that
// Payment, call submitStatusTx to trigger indexing and poll status.

export const DEFAULT_EXECUTOR_API = "https://executor-testnet.labsapis.com";

export interface QuoteResponse {
  signedQuote: `0x${string}`;
  estimatedCost: string; // drops (stringified)
}

/** POST /v0/quote — fetch a signed quote + estimated cost for a relay. */
export async function fetchQuote(opts: {
  executorApi: string;
  srcChain: number;
  dstChain: number;
  relayInstructions: `0x${string}`;
}): Promise<QuoteResponse> {
  const res = await fetch(`${opts.executorApi}/v0/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      srcChain: opts.srcChain,
      dstChain: opts.dstChain,
      relayInstructions: opts.relayInstructions,
    }),
  });
  if (!res.ok) {
    throw new Error(`Quote API ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    signedQuote?: `0x${string}`;
    estimatedCost?: string;
  };
  if (!data.signedQuote || !data.estimatedCost) {
    throw new Error("Quote response missing signedQuote or estimatedCost");
  }
  return { signedQuote: data.signedQuote, estimatedCost: data.estimatedCost };
}

export interface RelayTransaction {
  id?: string;
  status?: string;
  failureCause?: string;
  failureMessage?: string;
  txs?: { txHash: string; chainId: number }[];
  [k: string]: unknown;
}

/**
 * POST /v0/status/tx — trigger indexing of `txHash` and return its relay status.
 * `chainId` is the chain the request was emitted on (66 for XRPL).
 */
export async function submitStatusTx(opts: {
  executorApi: string;
  chainId: number;
  txHash: string;
}): Promise<RelayTransaction[]> {
  const res = await fetch(`${opts.executorApi}/v0/status/tx`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chainId: opts.chainId, txHash: opts.txHash }),
  });
  if (!res.ok) {
    throw new Error(`Status API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as RelayTransaction[];
}
