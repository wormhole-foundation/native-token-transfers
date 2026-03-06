import { Layout } from "@wormhole-foundation/sdk-base";
import { prefixItem } from "@wormhole-foundation/sdk-definitions-ntt";

export const nttTransferLayout = [
  prefixItem([0x99, 0x4e, 0x54, 0x54]),
  { name: "recipient_ntt_manager_address", binary: "bytes", size: 32 },
  { name: "recipient_address", binary: "bytes", size: 32 },
  { name: "recipient_chain", binary: "uint", size: 2 },
  { name: "from_decimals", binary: "uint", size: 1 },
  { name: "to_decimals", binary: "uint", size: 1 },
] as const satisfies Layout;

// NTT v1 prefix (0x45524E31)
export const executorRequestLayout = [
  prefixItem([0x45, 0x52, 0x4e, 0x31]),
  { name: "srcChain", binary: "uint", size: 2 },
  { name: "srcManager", binary: "bytes", size: 32 },
  { name: "messageId", binary: "uint", size: 32 },
] as const satisfies Layout;

export const requestForExecutionLayout = [
  // version = 0
  {
    name: "version",
    binary: "bytes",
    custom: Uint8Array.from([0x00]),
    omit: true,
  },
  { name: "dstChain", binary: "uint", size: 2 },
  { name: "dstAddr", binary: "bytes", size: 32 },
  { name: "refundAddr", binary: "bytes", size: 20 },
  { name: "signedQuote", binary: "bytes", lengthSize: 2 },
  { name: "requestBytes", binary: "bytes", lengthSize: 2 },
  { name: "relayInstructions", binary: "bytes", lengthSize: 2 },
] as const satisfies Layout;
