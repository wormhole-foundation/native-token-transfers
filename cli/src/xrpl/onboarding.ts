import { decodeAccountID } from "xrpl";
import type { Network } from "@wormhole-foundation/sdk-connect";

// XRPLAppOnboarding payload builders. Mirrors the reference scripts
// (xrpl-scripts/init_iou.ts, init_mpt.ts) and the SPEC app-onboarding flow:
// https://github.com/wormholelabs-xyz/ripple/blob/main/SPEC.md#app-onboarding-flow

/** "XRPL" prefix (0x5852504C) identifying an onboarding payload. */
export const XRPL_ONBOARDING_PREFIX = "5852504C";

/** MemoFormat used to publish a Wormhole message via an XRPL transfer. */
export const WORMHOLE_PUBLISH_MEMO_FORMAT = "application/x-wormhole-publish";

/** Wormhole Core (GMP) account on XRPL Testnet that Guardians watch. */
export const DEFAULT_TESTNET_CORE_ACCOUNT =
  "rpuMNy2dBzimaQHTFpXsfoCoqicgd8etQQ";

const DEFAULT_CORE_ACCOUNTS: Partial<Record<Network, string>> = {
  Testnet: DEFAULT_TESTNET_CORE_ACCOUNT,
};

/**
 * Default Wormhole Core (GMP) account for a network. Throws if there is no
 * default for that network (e.g. not deployed yet) — pass `--core-account`
 * explicitly in that case.
 */
export function getDefaultCoreAccountForNetwork(network: Network): string {
  const account = DEFAULT_CORE_ACCOUNTS[network];
  if (!account) {
    throw new Error(
      `No default Wormhole Core account for ${network}; pass --core-account`
    );
  }
  return account;
}

const TOKEN_TYPE_IOU = "01";
const TOKEN_TYPE_MPT = "02";

// Size (in bytes) the token_id portion of init_data is right-padded to.
const TOKEN_ID_PADDED_BYTES = 42;

export type TokenInit =
  | { type: "xrp" }
  | { type: "iou"; currency: string; issuer: string }
  | { type: "mpt"; mptId: string };

/** Encode a non-negative integer as a 1-byte (2 hex char) value. */
function u8Hex(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 0xff) {
    throw new Error(`value ${n} does not fit in one unsigned byte`);
  }
  return n.toString(16).padStart(2, "0");
}

const U64_MAX = (1n << 64n) - 1n;

/**
 * Encode a non-negative integer that fits in a u64 as a big-endian 8-byte
 * (16 hex char) value. Accepts a number, bigint, or decimal string.
 */
function u64Hex(n: string | bigint): string {
  let v: bigint;
  try {
    v = BigInt(n);
  } catch {
    throw new Error(`value "${n}" is not a valid integer`);
  }
  if (v < 0n || v > U64_MAX) {
    throw new Error(`value ${n} must be in the range [0, ${U64_MAX}] (u64)`);
  }
  return v.toString(16).padStart(16, "0");
}

/** Decode an XRPL r-address to its 20-byte account ID (40 hex chars). */
function accountIdHex(rAddress: string): string {
  return Buffer.from(decodeAccountID(rAddress)).toString("hex");
}

/** Right-pad a hex string to `bytes` bytes with zeros. */
function padRight(hex: string, bytes: number): string {
  const target = bytes * 2;
  if (hex.length > target) {
    throw new Error(`hex value is ${hex.length / 2} bytes, exceeds ${bytes}`);
  }
  return hex.padEnd(target, "0");
}

/**
 * Encode an IOU currency code as a 40-char hex (20-byte) value.
 * Accepts a 40-char hex code directly, or a 1-3 char ASCII code (standard
 * format: ASCII placed at bytes 12-14, zeros elsewhere).
 */
export function currencyToHex40(currency: string): string {
  if (currency.length === 40 && /^[0-9a-fA-F]{40}$/.test(currency)) {
    return currency.toLowerCase();
  }
  if (currency.length >= 1 && currency.length <= 3) {
    const buf = Buffer.alloc(20);
    for (let i = 0; i < currency.length; i++) {
      buf[12 + i] = currency.charCodeAt(i);
    }
    return buf.toString("hex");
  }
  throw new Error(
    `Invalid currency '${currency}': expected a 3-char ASCII code or a 40-char hex code`
  );
}

/**
 * Build the NTT/WTT `init_data` tail (hex, no 0x prefix):
 *  - xrp: short form — just the decimals byte.
 *  - iou: decimals byte + (0x01 + currency[20] + issuer[20]) right-padded to 42 bytes.
 *  - mpt: decimals byte + (0x02 + mpt_issuance_id[24]) right-padded to 42 bytes.
 */
export function buildInitData(decimals: number, token: TokenInit): string {
  const dec = u8Hex(decimals);
  switch (token.type) {
    case "xrp":
      return dec;
    case "iou": {
      const currency = currencyToHex40(token.currency);
      const issuer = accountIdHex(token.issuer);
      return (
        dec +
        padRight(TOKEN_TYPE_IOU + currency + issuer, TOKEN_ID_PADDED_BYTES)
      );
    }
    case "mpt": {
      if (!/^[0-9a-fA-F]{48}$/.test(token.mptId)) {
        throw new Error("expected mpt issuance id length of 48 (hex)");
      }
      return (
        dec + padRight(TOKEN_TYPE_MPT + token.mptId, TOKEN_ID_PADDED_BYTES)
      );
    }
  }
}

/**
 * Build the XRPLAppOnboarding payload (hex, no 0x prefix):
 *   prefix("XRPL")[4] + admin[20] + app(left-padded)[32] + initial_ticket[8] +
 *   ticket_count[8] + init_data
 */
export function buildOnboardingPayload(params: {
  admin: string;
  app: string;
  initialTicket: bigint;
  ticketCount: bigint;
  initData: string;
}): string {
  const adminHex = accountIdHex(params.admin);
  const appHex = Buffer.from(params.app, "utf8").toString("hex");
  if (appHex.length > 64) {
    throw new Error(`app type '${params.app}' exceeds 32 bytes`);
  }
  const appPadded = appHex.padStart(64, "0"); // left-padded to 32 bytes
  return (
    XRPL_ONBOARDING_PREFIX +
    adminHex +
    appPadded +
    u64Hex(params.initialTicket) +
    u64Hex(params.ticketCount) +
    params.initData
  );
}

/**
 * Wrap an onboarding payload into the publish MemoData: a 1-byte version (0x01)
 * + 4-byte nonce (0x00000000) + payload, uppercased.
 */
export function buildPublishMemoData(payloadHex: string): string {
  return ("01" + "00000000" + payloadHex).toUpperCase();
}
