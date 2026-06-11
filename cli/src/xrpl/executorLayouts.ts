// Executor RequestForExecution layouts (binary-layout).
//
// Ported from ripple/xrpl-client/src/integration/executorLayouts.ts and
// w7-executor/src/layouts/requestForExecution.ts. Adds ERV1 (VAA_V1) on top of
// the ERN1 (NTT_V1) request the integration reference shipped, so the CLI can
// relay both NTT transfers and XRPL-originated core VAAs (onboarding /
// register-peer) to the Sequencer.

import type { CustomConversion, DeriveType, Layout } from "binary-layout";
import { deserialize, serialize } from "binary-layout";
import { ethers } from "ethers";

export const hexConversion = {
  to: (encoded: Uint8Array) => ethers.hexlify(encoded) as `0x${string}`,
  from: (decoded: `0x${string}`) => ethers.getBytes(decoded),
} as const satisfies CustomConversion<Uint8Array, `0x${string}`>;

export const dateConversion = {
  to: (encoded: bigint) => new Date(Number(encoded * 1000n)),
  from: (decoded: Date) => BigInt(decoded.getTime()) / 1000n,
} as const satisfies CustomConversion<bigint, Date>;

// ── Signed quote ─────────────────────────────────────────────────────────

export const EQ01_PREFIX = 0x45513031;
export const EQ02_PREFIX = 0x45513032;

const sharedQuoteBody = [
  { name: "quoterAddress", binary: "bytes", size: 20, custom: hexConversion },
  { name: "payeeAddress", binary: "bytes", size: 32, custom: hexConversion },
  { name: "srcChain", binary: "uint", size: 2 },
  { name: "dstChain", binary: "uint", size: 2 },
  { name: "expiryTime", binary: "uint", size: 8, custom: dateConversion },
  { name: "baseFee", binary: "uint", size: 8 },
  { name: "dstGasPrice", binary: "uint", size: 8 },
  { name: "srcPrice", binary: "uint", size: 8 },
  { name: "dstPrice", binary: "uint", size: 8 },
] as const;

export const signedQuoteLayout = [
  {
    name: "quote",
    binary: "switch",
    idSize: 4,
    idTag: "prefix",
    layouts: [
      [
        [EQ01_PREFIX, "EQ01"],
        [
          ...sharedQuoteBody,
          { name: "signature", binary: "bytes", size: 65, custom: hexConversion },
        ],
      ],
      [[EQ02_PREFIX, "EQ02"], sharedQuoteBody],
    ],
  },
] as const satisfies Layout;

export type SignedQuote = DeriveType<typeof signedQuoteLayout>;

export function deserializeSignedQuote(
  signedQuoteBytes: `0x${string}`,
): SignedQuote {
  return deserialize(signedQuoteLayout, ethers.getBytes(signedQuoteBytes));
}

// ── Relay instructions ─────────────────────────────────────────────────────

export const gasInstructionLayout = [
  { name: "gasLimit", binary: "uint", size: 16 },
  { name: "msgValue", binary: "uint", size: 16 },
] as const satisfies Layout;

export const gasDropOffInstructionLayout = [
  { name: "dropOff", binary: "uint", size: 16 },
  { name: "recipient", binary: "bytes", size: 32, custom: hexConversion },
] as const satisfies Layout;

export const relayInstructionLayout = [
  {
    name: "request",
    binary: "switch",
    idSize: 1,
    idTag: "type",
    layouts: [
      [[1, "GasInstruction"], gasInstructionLayout],
      [[2, "GasDropOffInstruction"], gasDropOffInstructionLayout],
    ],
  },
] as const satisfies Layout;

export const relayInstructionsLayout = [
  { name: "requests", binary: "array", layout: relayInstructionLayout },
] as const satisfies Layout;

export type RelayInstructions = DeriveType<typeof relayInstructionsLayout>;

/** Decode a relay-instructions hex blob into structured form. */
export function deserializeRelayInstructions(
  hex: `0x${string}`,
): RelayInstructions {
  return deserialize(relayInstructionsLayout, ethers.getBytes(hex));
}

// ── Request (the per-protocol payload) ─────────────────────────────────────

export enum RequestPrefix {
  ERV1 = "ERV1", // VAA_V1   (chain + emitter + sequence) — onboarding / register-peer → Sequencer
  ERN1 = "ERN1", // NTT_V1   (srcChain + srcManager + messageId) — NTT transfer
}

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

export const REQUEST_FOR_EXECUTION_VERSION_0 = 0;

const requestForExecutionV0Layout = [
  { name: "dstChain", binary: "uint", size: 2 },
  { name: "dstAddr", binary: "bytes", size: 32, custom: hexConversion },
  { name: "refundAddr", binary: "bytes", size: 20, custom: hexConversion },
  { name: "signedQuote", binary: "bytes", lengthSize: 2, layout: signedQuoteLayout },
  { name: "requestBytes", binary: "bytes", lengthSize: 2, layout: requestLayout },
  {
    name: "relayInstructions",
    binary: "bytes",
    lengthSize: 2,
    layout: relayInstructionsLayout,
  },
] as const satisfies Layout;

export const requestForExecutionLayout = [
  {
    name: "payload",
    binary: "switch",
    idSize: 1,
    idTag: "version",
    layouts: [[[REQUEST_FOR_EXECUTION_VERSION_0, 0], requestForExecutionV0Layout]],
  },
] as const satisfies Layout;

export type RequestForExecution = DeriveType<typeof requestForExecutionLayout>;

export function serializeRequestForExecution(
  request: RequestForExecution,
): `0x${string}` {
  return ethers.hexlify(serialize(requestForExecutionLayout, request)) as `0x${string}`;
}

export function deserializeRequestForExecution(
  data: `0x${string}`,
): RequestForExecution {
  return deserialize(requestForExecutionLayout, ethers.getBytes(data));
}

/**
 * Encode a GasInstruction relay instruction to hex.
 * Format: 0x01 + gasLimit(16 bytes BE) + msgValue(16 bytes BE)
 */
export function buildGasInstructionHex(
  gasLimit: bigint,
  msgValue: bigint,
): `0x${string}` {
  const buf = Buffer.alloc(33);
  buf[0] = 0x01; // GasInstruction type ID
  buf.writeBigUInt64BE(0n, 1); // upper 8 bytes of 16-byte gasLimit
  buf.writeBigUInt64BE(gasLimit, 9);
  buf.writeBigUInt64BE(0n, 17); // upper 8 bytes of 16-byte msgValue
  buf.writeBigUInt64BE(msgValue, 25);
  return `0x${buf.toString("hex")}`;
}
