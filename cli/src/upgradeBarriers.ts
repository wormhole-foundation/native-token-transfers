import type { Chain } from "@wormhole-foundation/sdk";

/**
 * A registered breaking-change barrier between two major versions of the NTT
 * deployment for a given chain. An in-place upgrade is blocked iff the source
 * version's major is below the barrier and the target version's major is at or
 * above it.
 *
 * Add an entry here whenever a major version introduces an on-chain layout or
 * wire-format change that an existing deployment cannot be upgraded into. The
 * `reason` string is surfaced verbatim when blocking an upgrade attempt.
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
      "than the program ID). v3 deployments cannot be upgraded in place. " +
      "Deploy fresh v4 with `ntt add-chain Solana --version 4.0.0` instead.",
  },
];

export type UpgradeCheck = { ok: true } | { ok: false; reason: string };

function parseMajor(version: string): number {
  return parseInt(version.split(".")[0] ?? "0", 10);
}

/**
 * Returns whether the proposed `fromVersion → toVersion` upgrade on `chain` is
 * permitted in place. A registered barrier between the two majors blocks it.
 *
 * Local-version (`toVersion === null`) upgrades are always permitted; the
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
    if (fromMajor < barrier.breakingMajor && toMajor >= barrier.breakingMajor) {
      return { ok: false, reason: barrier.reason };
    }
  }
  return { ok: true };
}
