import type { Network } from "@wormhole-foundation/sdk-connect";
import {
  RequestPrefix,
  relayInstructionsLayout,
  serializeLayout,
} from "@wormhole-foundation/sdk-connect";
import type { CustomConversion, DeriveType, Layout } from "binary-layout";
import { deserialize, serialize } from "binary-layout";
import { ethers } from "ethers";

const DEFAULT_EXECUTOR_API = "https://executor-testnet.labsapis.com";

const DEFAULT_EXECUTOR_APIS: Partial<Record<Network, string>> = {
  Testnet: DEFAULT_EXECUTOR_API,
};

export function getDefaultExecutorApiForNetwork(network: Network): string {
  const api = DEFAULT_EXECUTOR_APIS[network];
  if (!api) {
    throw new Error(
      `No default Executor API for ${network}; pass --executor-api`
    );
  }
  return api;
}

export const hexConversion = {
  to: (encoded: Uint8Array) => ethers.hexlify(encoded) as `0x${string}`,
  from: (decoded: `0x${string}`) => ethers.getBytes(decoded),
} as const satisfies CustomConversion<Uint8Array, `0x${string}`>;

// ── Request (the per-protocol payload) ─────────────────────────────────────

export const vaaV1RequestLayout = [
  { name: "chain", binary: "uint", size: 2 },
  { name: "address", binary: "bytes", size: 32, custom: hexConversion },
  { name: "sequence", binary: "uint", size: 8 },
] as const satisfies Layout;

export type VAAv1Request = DeriveType<typeof vaaV1RequestLayout>;

export const nttV1RequestLayout = [
  { name: "srcChain", binary: "uint", size: 2 },
  { name: "srcManager", binary: "bytes", size: 32, custom: hexConversion },
  { name: "messageId", binary: "bytes", size: 32, custom: hexConversion },
] as const satisfies Layout;

export type NTTv1Request = DeriveType<typeof nttV1RequestLayout>;

export const requestLayout = [
  {
    name: "request",
    binary: "switch",
    idSize: 4,
    idTag: "prefix",
    layouts: [
      [[0x45525631, RequestPrefix.ERV1], vaaV1RequestLayout],
      [[0x45524e31, RequestPrefix.ERN1], nttV1RequestLayout],
    ],
  },
] as const satisfies Layout;

export type RequestLayout = DeriveType<typeof requestLayout>;

export function serializeRequest(instruction: RequestLayout): `0x${string}` {
  return ethers.hexlify(serialize(requestLayout, instruction)) as `0x${string}`;
}

export function deserializeRequest(requestBytes: `0x${string}`): RequestLayout {
  return deserialize(requestLayout, ethers.getBytes(requestBytes));
}

// ── RequestForExecution envelope (version 0) ───────────────────────────────
// The signed-quote, request, and relay-instruction blobs are embedded as raw
// length-prefixed bytes (already serialized by their respective layouts), so the
// envelope stays decoupled from those sub-layouts — the signed quote is the exact
// bytes the Executor signed, and the relay instructions / request are built via
// the SDK / request layout respectively.

export const REQUEST_FOR_EXECUTION_VERSION_0 = 0;

const requestForExecutionV0Layout = [
  { name: "dstChain", binary: "uint", size: 2 },
  { name: "dstAddr", binary: "bytes", size: 32, custom: hexConversion },
  { name: "refundAddr", binary: "bytes", size: 20, custom: hexConversion },
  {
    name: "signedQuote",
    binary: "bytes",
    lengthSize: 2,
    custom: hexConversion,
  },
  {
    name: "requestBytes",
    binary: "bytes",
    lengthSize: 2,
    custom: hexConversion,
  },
  {
    name: "relayInstructions",
    binary: "bytes",
    lengthSize: 2,
    custom: hexConversion,
  },
] as const satisfies Layout;

export const requestForExecutionLayout = [
  {
    name: "payload",
    binary: "switch",
    idSize: 1,
    idTag: "version",
    layouts: [
      [[REQUEST_FOR_EXECUTION_VERSION_0, 0], requestForExecutionV0Layout],
    ],
  },
] as const satisfies Layout;

export type RequestForExecution = DeriveType<typeof requestForExecutionLayout>;

export function serializeRequestForExecution(
  request: RequestForExecution
): `0x${string}` {
  return ethers.hexlify(
    serialize(requestForExecutionLayout, request)
  ) as `0x${string}`;
}

// ── Gas instruction helper ─────────────────────────────────────────────────
// Built via the SDK relay-instruction layout (byte-identical to the previous
// hand-rolled encoding).

export function buildGasInstructionHex(
  gasLimit: bigint,
  msgValue: bigint
): `0x${string}` {
  return ethers.hexlify(
    serializeLayout(relayInstructionsLayout, {
      requests: [{ request: { type: "GasInstruction", gasLimit, msgValue } }],
    })
  ) as `0x${string}`;
}
