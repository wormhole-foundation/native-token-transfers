// Shared yargs option definitions for `ntt xrpl` commands.

import { DEFAULT_XRPL_RPC } from "./client";
import { DEFAULT_GUARDIAN_API } from "./guardian";
import { DEFAULT_EXECUTOR_API } from "./executor";

export const xrplOptions = {
  seed: {
    describe: "XRPL seed (or set XRPL_SEED). The seed holder is the admin.",
    type: "string" as const,
  },
  ed25519: {
    describe: "Treat the seed as ed25519 (default: secp256k1)",
    type: "boolean" as const,
    default: false,
  },
  rpc: {
    describe: "XRPL WebSocket RPC URL",
    type: "string" as const,
    default: DEFAULT_XRPL_RPC,
  },
  guardianApi: {
    describe: "Guardian / Wormholescan API base URL",
    type: "string" as const,
    default: DEFAULT_GUARDIAN_API,
  },
  executorApi: {
    describe: "Executor API base URL",
    type: "string" as const,
    default: DEFAULT_EXECUTOR_API,
  },
  executor: {
    describe: "Executor XRPL address (rAddress) to send the request payment to",
    type: "string" as const,
  },
  token: {
    describe: "XRPL token type",
    type: "string" as const,
    choices: ["xrp", "iou", "mpt"] as const,
  },
  currency: {
    describe: "IOU currency code (3-4 char ASCII or 40-char hex)",
    type: "string" as const,
  },
  issuer: {
    describe: "IOU issuer r-address",
    type: "string" as const,
  },
  mptId: {
    describe: "MPT issuance ID (48-char hex)",
    type: "string" as const,
  },
  manager: {
    describe: "XRPL NTT manager / custody account (rAddress or 20-byte hex)",
    type: "string" as const,
  },
  gasLimit: {
    describe: "Relay gas limit",
    type: "string" as const,
    default: "250000",
  },
  msgValue: {
    describe: "Relay msg value (drops)",
    type: "string" as const,
    default: "0",
  },
  relayInstructions: {
    describe: "Pre-encoded relay instructions hex (overrides gas-limit/msg-value)",
    type: "string" as const,
  },
  pollInterval: {
    describe: "VAA poll interval (ms)",
    type: "number" as const,
    default: 5_000,
  },
  pollTimeout: {
    describe: "VAA poll timeout (ms)",
    type: "number" as const,
    default: 120_000,
  },
} as const;
