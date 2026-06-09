// Decoders for XRPL-Wormhole VAA payloads and the full VAA envelope.
//
// Ported from xrpl_accounts/vaa.ts, ripple/xrpl-client/src/onboarding-codec.ts,
// and the Sequencer payloads (ripple/solana/.../payloads.rs). Keep in sync.
//
// Payload prefixes (first 4 bytes, ASCII):
//   XREL (Sequencer → guardian)  XrplRelease       — assign ticket to inbound transfer
//   XRFL (Sequencer → guardian)  TicketRefill      — request new tickets
//   XADM (admin tx)              Admin             — register peer / rotate admin
//   XRPL (onboarding tx)         XRPLAppOnboarding — onboard a new NTT/WTT app
//   0x994E5454 ("NTT")           NTT transfer manager payload
//   0x9945FF10                   Wormhole transceiver message

import { encodeAccountID } from "ripple-address-codec";

export const PREFIX_XREL = "XREL";
export const PREFIX_XRFL = "XRFL";
export const PREFIX_XADM = "XADM";
export const PREFIX_XRPL = "XRPL"; // onboarding
export const PREFIX_XACK = "XACK";
export const PREFIX_XTCF = "XTCF";
export const PREFIX_XBRN = "XBRN";

// Non-XRPL prefixes we recognise for nicer output (bytes, not ASCII):
export const PREFIX_NTT_TRANSFER = "994e5454"; // 0x99 'N' 'T' 'T'
export const PREFIX_WH_TRANSCEIVER = "9945ff10"; // Wormhole transceiver message

export type ParsedPayload =
  | ({ kind: "XrplRelease" } & XrelPayload)
  | ({ kind: "TicketRefill" } & XrflPayload)
  | ({ kind: "Admin" } & AdminPayload)
  | ({ kind: "Onboarding" } & OnboardingPayload)
  | ({ kind: "NttTransfer" } & NttTransferPayload)
  | { kind: "Unknown"; prefix: string; hex: string };

export interface NttTransferPayload {
  sourceNttManager: string;
  recipientNttManager: string;
  managerPayloadLength: number;
  id: string;
  sender: string;
  decimals: number;
  amount: bigint;
  sourceToken: string;
  recipientAddress: string;
  recipientChain: number;
}

export interface XrelPayload {
  ticketId: bigint;
  xrplCustodyAccount: string;
  xrplRecipient: string;
  amount: bigint;
  tokenDecimals: number;
  sourceChain: number;
  sourceEmitter: string;
  sourceSequence: bigint;
  tokenId:
    | { type: "XRP" }
    | { type: "IOU"; currency: string; issuer: string }
    | { type: "MPT"; mptIssuanceId: string };
  memos: { data: string; format: string; type: string }[];
}

export interface XrflPayload {
  xrplAccount: string;
  useTicket: bigint;
  requestCount: bigint;
}

export interface AdminPayload {
  action: number;
  actionName: string;
  targetAccount: string;
  // RegisterPeer (0x01)
  chainId?: number;
  peerAddress?: string;
  // RotateAdmin (0x02)
  newAdmin?: string;
}

export interface OnboardingPayload {
  admin: string;
  appType: string;
  initialTicket: bigint;
  ticketCount: bigint;
  initDataHex: string;
}

function readAscii(buf: Buffer, offset: number, len: number): string {
  return buf.subarray(offset, offset + len).toString("ascii");
}

/**
 * Parse an XREL (XrplRelease) payload.
 * Layout: prefix[4] ticket[8] custody[20] recipient[20] amount[8]
 *   decimals[1] chain[2] emitter[32] seq[8] tokenId[1-41] memosLen[2] memos[...]
 */
export function parseXrel(buffer: Buffer): XrelPayload {
  if (buffer.length < 106) {
    throw new Error(`XREL payload too short: ${buffer.length} bytes (min 106)`);
  }
  let offset = 0;

  const prefix = readAscii(buffer, offset, 4);
  if (prefix !== PREFIX_XREL) {
    throw new Error(`Invalid XREL prefix: "${prefix}"`);
  }
  offset += 4;

  const ticketId = buffer.readBigUInt64BE(offset);
  offset += 8;
  const xrplCustodyAccount = encodeAccountID(buffer.subarray(offset, offset + 20));
  offset += 20;
  const xrplRecipient = encodeAccountID(buffer.subarray(offset, offset + 20));
  offset += 20;
  const amount = buffer.readBigUInt64BE(offset);
  offset += 8;
  const tokenDecimals = buffer.readUInt8(offset);
  offset += 1;
  const sourceChain = buffer.readUInt16BE(offset);
  offset += 2;
  const sourceEmitter = buffer.subarray(offset, offset + 32).toString("hex");
  offset += 32;
  const sourceSequence = buffer.readBigUInt64BE(offset);
  offset += 8;

  const tokenType = buffer.readUInt8(offset);
  offset += 1;
  let tokenId: XrelPayload["tokenId"];
  if (tokenType === 0x00) {
    tokenId = { type: "XRP" };
  } else if (tokenType === 0x01) {
    if (buffer.length < offset + 40) {
      throw new Error("XREL: insufficient bytes for IOU token");
    }
    const currency = buffer.subarray(offset, offset + 20).toString("hex").toUpperCase();
    offset += 20;
    const issuer = encodeAccountID(buffer.subarray(offset, offset + 20));
    offset += 20;
    tokenId = { type: "IOU", currency, issuer };
  } else if (tokenType === 0x02) {
    if (buffer.length < offset + 24) {
      throw new Error("XREL: insufficient bytes for MPT token");
    }
    const mptIssuanceId = buffer.subarray(offset, offset + 24).toString("hex").toUpperCase();
    offset += 24;
    tokenId = { type: "MPT", mptIssuanceId };
  } else {
    throw new Error(`Unknown XREL token type: 0x${tokenType.toString(16)}`);
  }

  const memos: XrelPayload["memos"] = [];
  const memosLen = buffer.readUInt16BE(offset);
  offset += 2;
  for (let i = 0; i < memosLen; i++) {
    const dataLen = buffer.readUInt16BE(offset);
    offset += 2;
    const data = buffer.subarray(offset, offset + dataLen).toString("hex");
    offset += dataLen;
    const formatLen = buffer.readUInt16BE(offset);
    offset += 2;
    const format = buffer.subarray(offset, offset + formatLen).toString("hex");
    offset += formatLen;
    const typeLen = buffer.readUInt16BE(offset);
    offset += 2;
    const type = buffer.subarray(offset, offset + typeLen).toString("hex");
    offset += typeLen;
    memos.push({ data, format, type });
  }

  return {
    ticketId,
    xrplCustodyAccount,
    xrplRecipient,
    amount,
    tokenDecimals,
    sourceChain,
    sourceEmitter,
    sourceSequence,
    tokenId,
    memos,
  };
}

/** Parse an XRFL (TicketRefill) payload: prefix[4] account[20] useTicket[8] requestCount[8]. */
export function parseXrfl(buffer: Buffer): XrflPayload {
  if (buffer.length < 40) {
    throw new Error(`XRFL payload too short: ${buffer.length} bytes (min 40)`);
  }
  const prefix = readAscii(buffer, 0, 4);
  if (prefix !== PREFIX_XRFL) {
    throw new Error(`Invalid XRFL prefix: "${prefix}"`);
  }
  return {
    xrplAccount: encodeAccountID(buffer.subarray(4, 24)),
    useTicket: buffer.readBigUInt64BE(24),
    requestCount: buffer.readBigUInt64BE(32),
  };
}

/**
 * Parse an XADM (Admin) payload.
 * prefix[4] action[1] target[20] then action-specific:
 *   0x01 RegisterPeer: chainId[2] peerAddress[32]
 *   0x02 RotateAdmin:  newAdmin[20]
 */
export function parseAdmin(buffer: Buffer): AdminPayload {
  if (buffer.length < 25) {
    throw new Error(`XADM payload too short: ${buffer.length} bytes (min 25)`);
  }
  const prefix = readAscii(buffer, 0, 4);
  if (prefix !== PREFIX_XADM) {
    throw new Error(`Invalid XADM prefix: "${prefix}"`);
  }
  const action = buffer.readUInt8(4);
  const targetAccount = encodeAccountID(buffer.subarray(5, 25));

  if (action === 0x01) {
    if (buffer.length < 25 + 2 + 32) {
      throw new Error("XADM RegisterPeer too short");
    }
    return {
      action,
      actionName: "RegisterPeer",
      targetAccount,
      chainId: buffer.readUInt16BE(25),
      peerAddress: buffer.subarray(27, 59).toString("hex"),
    };
  }
  if (action === 0x02) {
    if (buffer.length < 25 + 20) {
      throw new Error("XADM RotateAdmin too short");
    }
    return {
      action,
      actionName: "RotateAdmin",
      targetAccount,
      newAdmin: encodeAccountID(buffer.subarray(25, 45)),
    };
  }
  return { action, actionName: `Unknown(0x${action.toString(16)})`, targetAccount };
}

/**
 * Parse an XRPLAppOnboarding payload.
 * prefix[4] admin[20] appType[32 left-padded] initialTicket[8] ticketCount[8] initData[var]
 */
export function parseOnboarding(buffer: Buffer): OnboardingPayload {
  if (buffer.length < 72) {
    throw new Error(`Onboarding payload too short: ${buffer.length} bytes (min 72)`);
  }
  const prefix = readAscii(buffer, 0, 4);
  if (prefix !== PREFIX_XRPL) {
    throw new Error(`Invalid onboarding prefix: "${prefix}"`);
  }
  let offset = 4;
  const admin = encodeAccountID(buffer.subarray(offset, offset + 20));
  offset += 20;
  const appTypeRaw = buffer.subarray(offset, offset + 32);
  let firstNonZero = 0;
  while (firstNonZero < 32 && appTypeRaw[firstNonZero] === 0) firstNonZero++;
  const appType = appTypeRaw.subarray(firstNonZero).toString("utf8");
  offset += 32;
  const initialTicket = buffer.readBigUInt64BE(offset);
  offset += 8;
  const ticketCount = buffer.readBigUInt64BE(offset);
  offset += 8;
  const initDataHex = buffer.subarray(offset).toString("hex");

  return { admin, appType, initialTicket, ticketCount, initDataHex };
}

/**
 * Parse a Wormhole transceiver message wrapping an NTT manager payload.
 *
 * Layout (see watcher README / NTT Transceiver spec):
 *   transceiver prefix 0x9945FF10[4]
 *   source_ntt_manager[32] recipient_ntt_manager[32] manager_payload_len[2]
 *   manager payload: id[32] sender[32] payload_len[2] ntt prefix 0x994E5454[4]
 *                    decimals[1] amount[8] source_token[32] recipient[32] recipient_chain[2]
 */
export function parseNttTransfer(buffer: Buffer): NttTransferPayload {
  let offset = 0;
  const transceiverPrefix = buffer.subarray(0, 4).toString("hex");
  if (transceiverPrefix !== PREFIX_WH_TRANSCEIVER) {
    throw new Error(`Invalid transceiver prefix: 0x${transceiverPrefix}`);
  }
  offset += 4;
  const sourceNttManager = buffer.subarray(offset, offset + 32).toString("hex");
  offset += 32;
  const recipientNttManager = buffer.subarray(offset, offset + 32).toString("hex");
  offset += 32;
  const managerPayloadLength = buffer.readUInt16BE(offset);
  offset += 2;

  const id = buffer.subarray(offset, offset + 32).toString("hex");
  offset += 32;
  const sender = buffer.subarray(offset, offset + 32).toString("hex");
  offset += 32;
  // internal payload_length
  offset += 2;
  const nttPrefix = buffer.subarray(offset, offset + 4).toString("hex");
  if (nttPrefix !== PREFIX_NTT_TRANSFER) {
    throw new Error(`Invalid NTT manager prefix: 0x${nttPrefix}`);
  }
  offset += 4;
  const decimals = buffer.readUInt8(offset);
  offset += 1;
  const amount = buffer.readBigUInt64BE(offset);
  offset += 8;
  const sourceToken = buffer.subarray(offset, offset + 32).toString("hex");
  offset += 32;
  const recipientAddress = buffer.subarray(offset, offset + 32).toString("hex");
  offset += 32;
  const recipientChain = buffer.readUInt16BE(offset);
  offset += 2;

  return {
    sourceNttManager,
    recipientNttManager,
    managerPayloadLength,
    id,
    sender,
    decimals,
    amount,
    sourceToken,
    recipientAddress,
    recipientChain,
  };
}

/** Dispatch a payload to the right parser based on its prefix. */
export function parsePayload(payload: Buffer): ParsedPayload {
  const asciiPrefix = payload.length >= 4 ? readAscii(payload, 0, 4) : "";
  const hexPrefix = payload.length >= 4 ? payload.subarray(0, 4).toString("hex") : "";
  try {
    switch (asciiPrefix) {
      case PREFIX_XREL:
        return { kind: "XrplRelease", ...parseXrel(payload) };
      case PREFIX_XRFL:
        return { kind: "TicketRefill", ...parseXrfl(payload) };
      case PREFIX_XADM:
        return { kind: "Admin", ...parseAdmin(payload) };
      case PREFIX_XRPL:
        return { kind: "Onboarding", ...parseOnboarding(payload) };
    }
    if (hexPrefix === PREFIX_WH_TRANSCEIVER) {
      return { kind: "NttTransfer", ...parseNttTransfer(payload) };
    }
    return { kind: "Unknown", prefix: hexPrefix, hex: payload.toString("hex") };
  } catch (e) {
    // Fall back to Unknown so the CLI can still show the raw bytes + error.
    return { kind: "Unknown", prefix: hexPrefix, hex: payload.toString("hex") };
  }
}

// ── VAA envelope ─────────────────────────────────────────────────────────

export interface ParsedVaa {
  version: number;
  guardianSetIndex: number;
  signatures: { guardianIndex: number; signature: string }[];
  timestamp: number;
  nonce: number;
  emitterChain: number;
  emitterAddress: string;
  sequence: bigint;
  consistencyLevel: number;
  payload: Buffer;
}

/** Parse a v1 VAA envelope (ported from xrpl_accounts/vaa.ts::parseVAA). */
export function parseVaa(vaaBytes: Buffer): ParsedVaa {
  let offset = 0;
  const version = vaaBytes.readUInt8(offset);
  offset += 1;
  const guardianSetIndex = vaaBytes.readUInt32BE(offset);
  offset += 4;
  const numSignatures = vaaBytes.readUInt8(offset);
  offset += 1;

  const signatures: ParsedVaa["signatures"] = [];
  for (let i = 0; i < numSignatures; i++) {
    const guardianIndex = vaaBytes.readUInt8(offset);
    offset += 1;
    const signature = vaaBytes.subarray(offset, offset + 65).toString("hex");
    offset += 65;
    signatures.push({ guardianIndex, signature });
  }

  const timestamp = vaaBytes.readUInt32BE(offset);
  offset += 4;
  const nonce = vaaBytes.readUInt32BE(offset);
  offset += 4;
  const emitterChain = vaaBytes.readUInt16BE(offset);
  offset += 2;
  const emitterAddress = vaaBytes.subarray(offset, offset + 32).toString("hex");
  offset += 32;
  const sequence = vaaBytes.readBigUInt64BE(offset);
  offset += 8;
  const consistencyLevel = vaaBytes.readUInt8(offset);
  offset += 1;
  const payload = Buffer.from(vaaBytes.subarray(offset));

  return {
    version,
    guardianSetIndex,
    signatures,
    timestamp,
    nonce,
    emitterChain,
    emitterAddress,
    sequence,
    consistencyLevel,
    payload,
  };
}
