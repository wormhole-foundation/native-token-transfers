import type { Chain } from "@wormhole-foundation/sdk";

/**
 * A registered breaking-change barrier between two major versions of the NTT
 * deployment for a given chain. An in-place version change is blocked iff it
 * crosses the barrier in *either* direction — i.e. exactly one of the source
 * and target majors is at or above the barrier. This covers both an upgrade
 * past the barrier and a downgrade back across it, since the on-chain layout
 * is incompatible in both directions.
 *
 * Add an entry here whenever a major version introduces an on-chain layout or
 * wire-format change that an existing deployment cannot be migrated into in
 * place. The `reason` string is surfaced verbatim when blocking the attempt.
 */
export type UpgradeBarrier = {
  chain: Chain;
  breakingMajor: number;
  reason: string;
};

export const UPGRADE_BARRIERS: UpgradeBarrier[] = [
  {
    chain: "Solana",
    breakingMajor: 4,
    reason:
      "Solana NTT v4 changes the on-chain account layout (PDAs are scoped by " +
      "instance ID, the Instance account is keypair-created instead of a PDA, " +
      "and the on-the-wire NTT manager identity is the Instance pubkey rather " +
      "than the program ID). v3 and v4 cannot be migrated into each other in " +
      "place, in either direction. Deploy fresh v4 with " +
      "`ntt add-chain Solana --version 4.0.0` instead.",
  },
];

export type UpgradeCheck = { ok: true } | { ok: false; reason: string };

function parseMajor(version: string): number {
  return parseInt(version.split(".")[0] ?? "0", 10);
}

/**
 * Returns whether the proposed `fromVersion → toVersion` version change on
 * `chain` is permitted in place. A registered barrier blocks the change when it
 * crosses the barrier in either direction (upgrade past it or downgrade back
 * across it).
 *
 * Local-version (`toVersion === null`) changes are always permitted; the
 * caller is asserting they know what they're doing.
 */
export function canUpgrade(
  chain: Chain,
  fromVersion: string,
  toVersion: string | null
): UpgradeCheck {
  if (toVersion === null) return { ok: true };
  const fromMajor = parseMajor(fromVersion);
  const toMajor = parseMajor(toVersion);
  for (const barrier of UPGRADE_BARRIERS) {
    if (barrier.chain !== chain) continue;
    const fromBelow = fromMajor < barrier.breakingMajor;
    const toBelow = toMajor < barrier.breakingMajor;
    // Blocked when the change straddles the barrier — one side below it and
    // the other at or above it — regardless of direction.
    if (fromBelow !== toBelow) {
      return { ok: false, reason: barrier.reason };
    }
  }
  return { ok: true };
}
