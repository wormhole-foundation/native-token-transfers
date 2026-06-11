import { ethers } from "ethers";
import { decodeAccountID, deriveAddress } from "xrpl";

// Fetches the Wormhole "delegated manager set" — the set of signer keys that
// controls an XRPL custody account — from an EVM contract, and turns it into
// XRPL signer entries. (This is the per-deployment delegated manager set, not
// the canonical Wormhole guardian set.) Mirrors xrpl-scripts/guardian-manager.ts
// (which uses viem) and xrpl-scripts/pks_to_accts.ts, using ethers to match the
// rest of this CLI.

export type ParsedManagerSet = {
  mThreshold: number;
  nTotal: number;
  pubkeys: Buffer[]; // 33-byte compressed secp256k1 keys
};

export type ManagerSet = ParsedManagerSet & {
  /** The resolved set index (meaningful when "latest" was requested). */
  index: number;
};

export type SignerEntry = {
  SignerEntry: { Account: string; SignerWeight: number };
};

const MANAGER_SET_ABI = [
  "function getManagerSet(uint16 chainId, uint32 index) view returns (bytes)",
  "function getCurrentManagerSetIndex(uint16 chainId) view returns (uint32)",
];

/**
 * Parse the delegated manager set wire format (see Wormhole whitepaper 0016,
 * delegated-manager governance):
 *   [0] version (== 1), [1] mThreshold, [2] nTotal, [3..] nTotal × 33-byte pubkeys.
 */
export function parseManagerSet(bytes: Buffer): ParsedManagerSet {
  if (bytes[0] !== 1) {
    throw new Error(`Unsupported manager set version: ${bytes[0]}`);
  }
  const mThreshold = bytes[1];
  const nTotal = bytes[2];
  const rest = bytes.subarray(3);
  if (rest.length !== nTotal * 33) {
    throw new Error(
      `Manager set pubkey data is ${rest.length} bytes; expected ${nTotal} × 33`
    );
  }

  const pubkeys: Buffer[] = [];
  for (let i = 0; i < nTotal; i++) {
    pubkeys.push(Buffer.from(rest.subarray(i * 33, i * 33 + 33)));
  }
  return { mThreshold, nTotal, pubkeys };
}

/**
 * Read the delegated manager set for `chainId` from the EVM contract. Pass a
 * specific `index`, or "latest" to resolve the current index on-chain.
 */
export async function fetchDelegatedManagerSet(
  chainId: number,
  index: number | "latest",
  rpcUrl: string,
  address: string
): Promise<ManagerSet> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(address, MANAGER_SET_ABI, provider);
  const resolvedIndex =
    index === "latest"
      ? Number(await contract.getCurrentManagerSetIndex(chainId))
      : index;
  const hex: string = await contract.getManagerSet(chainId, resolvedIndex);
  return {
    index: resolvedIndex,
    ...parseManagerSet(Buffer.from(ethers.getBytes(hex))),
  };
}

/** Sort signer entries by account ID — required by XRPL for SignerListSet. */
function sortByAccountId(entries: SignerEntry[]): SignerEntry[] {
  return entries.sort((a, b) =>
    Buffer.compare(
      Buffer.from(decodeAccountID(a.SignerEntry.Account)),
      Buffer.from(decodeAccountID(b.SignerEntry.Account))
    )
  );
}

/** Derive sorted XRPL signer entries (weight 1) from compressed secp256k1 pubkeys. */
export function deriveSignerEntries(pubkeys: Buffer[]): SignerEntry[] {
  return sortByAccountId(
    pubkeys.map((pk) => ({
      SignerEntry: {
        Account: deriveAddress(pk.toString("hex").toUpperCase()),
        SignerWeight: 1,
      },
    }))
  );
}

/** Build sorted XRPL signer entries (weight 1) from explicit r-addresses. */
export function signerEntriesFromAddresses(addresses: string[]): SignerEntry[] {
  return sortByAccountId(
    addresses.map((a) => ({
      SignerEntry: { Account: a.trim(), SignerWeight: 1 },
    }))
  );
}
