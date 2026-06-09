// Token ID encoding/decoding for XRPL tokens (XRP, IOUs, MPTs)
//
// Ported from ripple/xrpl-client/src/token-id.ts, which mirrors the Guardian
// watcher (node/pkg/watchers/xrpl/parse.go) and the Solana Sequencer
// (XrplTokenId in state.rs). Keep these in sync.
//
// Emitter format (32 bytes, for the Wormhole VAA emitter address):
//   keccak256("ntt"[3] || padLeft(manager[20], 32)[32] || tokenId32[32])
//   where tokenId32 is:
//     XRP: 32 zeros
//     IOU: 0x01 || last 31 bytes of keccak256(currency[20] || issuer[20])
//     MPT: 0x02 || 7 zeros || 24-byte issuance ID

import { decodeAccountID, encodeAccountID } from "ripple-address-codec";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concat, keccak256, padHex, toHex } from "viem";

export type TokenType = "XRP" | "IOU" | "MPT";

export const TOKEN_TYPE_XRP = 0x00;
export const TOKEN_TYPE_IOU = 0x01;
export const TOKEN_TYPE_MPT = 0x02;

export interface XrpToken {
  type: "XRP";
}

export interface IouToken {
  type: "IOU";
  currency: Buffer; // 20 bytes
  issuer: Buffer; // 20 bytes (account ID)
}

export interface MptToken {
  type: "MPT";
  issuanceId: Buffer; // 24 bytes
}

export type TokenId = XrpToken | IouToken | MptToken;

/** Create an XRP token identifier. */
export function xrpToken(): XrpToken {
  return { type: "XRP" };
}

/**
 * Create an IOU token identifier.
 *
 * @param currency - Currency code (3-4 char ASCII or 40-char hex)
 * @param issuer - Issuer r-address or 20-byte account ID
 */
export function iouToken(currency: string, issuer: string | Buffer): IouToken {
  return {
    type: "IOU",
    currency: encodeCurrency(currency),
    issuer:
      typeof issuer === "string"
        ? Buffer.from(decodeAccountID(issuer))
        : issuer,
  };
}

/**
 * Create an MPT token identifier.
 *
 * @param issuanceId - 24-byte MPT issuance ID (48-char hex string or Buffer)
 */
export function mptToken(issuanceId: string | Buffer): MptToken {
  const idBuf =
    typeof issuanceId === "string"
      ? Buffer.from(issuanceId.replace(/^0x/, ""), "hex")
      : issuanceId;
  if (idBuf.length !== 24) {
    throw new Error(`MPT issuance ID must be 24 bytes, got ${idBuf.length}`);
  }
  return { type: "MPT", issuanceId: idBuf };
}

/**
 * Encode a currency code to 20 bytes.
 *
 * - 3-4 char ASCII codes: ASCII in bytes 12-14(15), byte 0 must be 0x00.
 * - 40-char hex codes: stored as-is (20 bytes).
 *
 * "XRP" is not a valid IOU currency code.
 */
export function encodeCurrency(currency: string): Buffer {
  const buf = Buffer.alloc(20);

  if (currency.length === 40 && /^[0-9A-Fa-f]+$/.test(currency)) {
    const decoded = Buffer.from(currency, "hex");
    if (decoded.length !== 20) {
      throw new Error(
        `Invalid currency hex: expected 20 bytes, got ${decoded.length}`,
      );
    }
    return decoded;
  } else if (currency.length >= 3 && currency.length <= 4) {
    if (currency.toUpperCase() === "XRP") {
      throw new Error("XRP is not a valid IOU currency code");
    }
    for (let i = 0; i < currency.length; i++) {
      buf[12 + i] = currency.charCodeAt(i);
    }
    return buf;
  }
  throw new Error(
    `Invalid currency code: must be 3-4 ASCII chars or 40-char hex, got "${currency}"`,
  );
}

/** Decode a 20-byte currency code to a display string. */
export function decodeCurrency(buf: Buffer): string {
  if (buf.length !== 20) {
    throw new Error(`Currency must be 20 bytes, got ${buf.length}`);
  }
  if (buf[0] === 0x00) {
    let code = "";
    for (let i = 12; i < 15; i++) {
      if (buf[i] !== 0) code += String.fromCharCode(buf[i]);
    }
    if (code.length > 0) return code;
  }
  return buf.toString("hex").toUpperCase();
}

/** Human-readable token id (for display). */
export function formatTokenId(token: TokenId): string {
  switch (token.type) {
    case "XRP":
      return "XRP";
    case "IOU":
      return `${decodeCurrency(token.currency)}/${encodeAccountID(token.issuer)}`;
    case "MPT":
      return `MPT:${token.issuanceId.toString("hex").toUpperCase()}`;
  }
}

/**
 * Build the 32-byte token id used in emitter address derivation.
 *
 * Matches the Guardian's parse.go token type constants:
 *   XRP: 32 zeros
 *   IOU: 0x01 || last 31 bytes of keccak256(currency[20] || issuer[20])
 *   MPT: 0x02 || 7 zeros || 24-byte issuance ID
 */
export function buildTokenIdForEmitter(token: TokenId): Buffer {
  const buf = Buffer.alloc(32);

  switch (token.type) {
    case "XRP":
      break; // all zeros
    case "IOU": {
      buf[0] = 0x01;
      const hashInput = Buffer.concat([token.currency, token.issuer]);
      const hash = Buffer.from(keccak_256(hashInput));
      hash.copy(buf, 1, 1, 32); // last 31 bytes of hash into bytes 1..31
      break;
    }
    case "MPT":
      buf[0] = 0x02;
      token.issuanceId.copy(buf, 8); // bytes 1..7 stay zero
      break;
  }

  return buf;
}

/**
 * Compute the Wormhole emitter address for an XRPL account + token pair.
 *
 * emitter = keccak256("ntt"[3] || padLeft(manager,32)[32] || tokenId[32])
 *
 * @param accountId - 20-byte XRPL account ID (manager/custody address)
 */
export function computeEmitterAddress(
  accountId: Buffer,
  token: TokenId,
): Buffer {
  if (accountId.length !== 20) {
    throw new Error(`Account ID must be 20 bytes, got ${accountId.length}`);
  }
  const manager = padHex(toHex(accountId), { dir: "left", size: 32 });
  const tokenId = toHex(buildTokenIdForEmitter(token));
  const emitter = keccak256(
    concat([toHex(Buffer.from("ntt")), manager, tokenId]),
  );
  return Buffer.from(emitter.slice(2), "hex");
}

/** Convenience: compute emitter from an XRPL r-address. */
export function computeEmitterAddressFromRAddress(
  rAddress: string,
  token: TokenId,
): Buffer {
  const accountId = Buffer.from(decodeAccountID(rAddress));
  return computeEmitterAddress(accountId, token);
}

/**
 * Parse an XRPL Amount field (from tx metadata) into a TokenId.
 *
 *   XRP: string (drops)
 *   IOU: { currency, value, issuer }
 *   MPT: { mpt_issuance_id, value }
 */
export function tokenIdFromXrplAmount(amount: unknown): TokenId {
  if (typeof amount === "string") {
    return { type: "XRP" };
  }
  if (amount && typeof amount === "object") {
    const a = amount as Record<string, unknown>;
    if ("mpt_issuance_id" in a) {
      return mptToken(a.mpt_issuance_id as string);
    }
    if ("currency" in a && "issuer" in a) {
      return iouToken(a.currency as string, a.issuer as string);
    }
  }
  throw new Error(`Unknown XRPL amount format: ${JSON.stringify(amount)}`);
}

/**
 * Resolve a TokenId from CLI-style flags.
 *
 * @param type - "xrp" | "iou" | "mpt"
 */
export function tokenIdFromFlags(opts: {
  type: string;
  currency?: string;
  issuer?: string;
  mptId?: string;
}): TokenId {
  switch (opts.type.toLowerCase()) {
    case "xrp":
      return xrpToken();
    case "iou":
      if (!opts.currency || !opts.issuer) {
        throw new Error("IOU token requires --currency and --issuer");
      }
      return iouToken(opts.currency, opts.issuer);
    case "mpt":
      if (!opts.mptId) {
        throw new Error("MPT token requires --mpt-id");
      }
      return mptToken(opts.mptId);
    default:
      throw new Error(`Unknown token type: ${opts.type} (expected xrp|iou|mpt)`);
  }
}
