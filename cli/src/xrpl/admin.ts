import { decodeAccountID } from "xrpl";

// XADM (Admin) payload builders. Published like XRPLAppOnboarding — wrap the
// payload with buildPublishMemoData (see onboarding.ts) and send it as a
// Payment to the Wormhole Core account.

/** "XADM" prefix (0x5841444D) identifying an admin payload. */
export const XADM_PREFIX = "5841444D";

const ACTION_REGISTER_PEER = "01";
const ACTION_ROTATE_ADMIN = "02";

/** Decode an XRPL r-address to its 20-byte account ID (40 hex chars). */
function accountIdHex(rAddress: string): string {
  return Buffer.from(decodeAccountID(rAddress)).toString("hex");
}

/** Normalize a 32-byte address (e.g. a transceiver emitter) to 64 lowercase hex chars. */
function normalizeAddress32(hex: string): string {
  const h = hex.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) {
    throw new Error(`expected a 32-byte (64 hex char) address, got "${hex}"`);
  }
  return h;
}

/** Encode a Wormhole chain id as a big-endian 2-byte (4 hex char) value. */
function chainIdHex(chainId: number): string {
  if (!Number.isInteger(chainId) || chainId < 0 || chainId > 0xffff) {
    throw new Error(`chain id ${chainId} does not fit in a uint16`);
  }
  return chainId.toString(16).padStart(4, "0");
}

/**
 * Build an XADM RegisterPeer (0x01) payload (hex, no 0x prefix):
 *   prefix("XADM")[4] + 0x01 + manager[20] + peer_chain[2 BE] + peer_address[32]
 */
export function buildRegisterPeerPayload(params: {
  manager: string;
  peerChainId: number;
  peerAddress: string;
}): string {
  return (
    XADM_PREFIX +
    ACTION_REGISTER_PEER +
    accountIdHex(params.manager) +
    chainIdHex(params.peerChainId) +
    normalizeAddress32(params.peerAddress)
  );
}

/**
 * Build an XADM RotateAdmin (0x02) payload (hex, no 0x prefix):
 *   prefix("XADM")[4] + 0x02 + manager[20] + new_admin[20]
 */
export function buildRotateAdminPayload(params: {
  manager: string;
  newAdmin: string;
}): string {
  return (
    XADM_PREFIX +
    ACTION_ROTATE_ADMIN +
    accountIdHex(params.manager) +
    accountIdHex(params.newAdmin)
  );
}
