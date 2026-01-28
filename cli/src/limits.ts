import { assertChain, type Chain } from "@wormhole-foundation/sdk";
import { colors } from "./colors.js";
import type { Config } from "./deployments";
import { promptLine, promptYesNo } from "./prompts.js";

type MissingInboundGroup = {
  destination: Chain;
  sources: Chain[];
  defaultLimit: string;
  decimals: number;
};

/**
 * Get the number of digits after the decimal point in a formatted limit string.
 *
 * @param limit - A numeric limit formatted with a decimal point (e.g. "123.456")
 * @returns The count of fractional digits, or `null` if `limit` does not contain exactly one decimal point
 */
function getDecimalsFromLimit(limit: string): number | null {
  const parts = limit.split(".");
  if (parts.length !== 2) {
    return null;
  }
  return parts[1].length;
}

/**
 * Check whether a formatted numeric limit represents zero.
 *
 * @param value - The limit string, optionally containing a single `.` as a decimal separator
 * @returns `true` if the value contains only zeros when the decimal point is ignored, `false` otherwise
 */
function isZeroLimit(value: string): boolean {
  const normalized = value.replace(".", "");
  return normalized.length === 0 || /^0+$/.test(normalized);
}

/**
 * Determine whether a limit string matches the expected decimal precision.
 *
 * @param value - The formatted limit string to validate (may contain a decimal point).
 * @param decimals - The required number of digits after the decimal point; use `0` for integer-only values.
 * @returns `true` if `value` is a valid limit with the specified precision, `false` otherwise.
 */
function isValidLimit(value: string, decimals: number): boolean {
  if (decimals === 0) {
    return /^\d+$/.test(value);
  }
  const parts = value.split(".");
  if (parts.length !== 2) {
    return false;
  }
  if (parts[1].length !== decimals) {
    return false;
  }
  return /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]);
}

/**
 * Collect groups of destinations that have missing or zero inbound limits involving a newly added chain.
 *
 * For each destination that either is the new chain or pairs with it as source, includes sources whose inbound limit
 * is missing or zero, along with the destination's outbound default limit and its decimal precision.
 *
 * @param chainsConfig - Map of chain configurations keyed by chain name
 * @param newChain - The chain being added or evaluated; only pairs where either source or destination is this chain are considered
 * @returns An array of MissingInboundGroup objects, one per destination with at least one missing/zero inbound limit, sorted by destination name
 */
function collectMissingInboundGroups(
  chainsConfig: Config["chains"],
  newChain: Chain
): MissingInboundGroup[] {
  const chainNames = Object.keys(chainsConfig);
  const chains: Chain[] = [];
  for (const name of chainNames) {
    assertChain(name);
    chains.push(name);
  }

  if (!chains.includes(newChain)) {
    return [];
  }

  const otherChains = chains.filter((chain) => chain !== newChain);
  const relevantChains = [newChain, ...otherChains];
  const missingByDestination = new Map<Chain, MissingInboundGroup>();

  for (const destination of relevantChains) {
    const destinationConfig = chainsConfig[destination];
    if (!destinationConfig) {
      continue;
    }
    const outbound = destinationConfig.limits?.outbound;
    if (!outbound) {
      continue;
    }
    const decimals = getDecimalsFromLimit(outbound);
    if (decimals === null) {
      console.warn(
        colors.yellow(
          `Skipping ${destination}: malformed outbound limit (${outbound})`
        )
      );
      continue;
    }
    for (const source of relevantChains) {
      if (source === destination) {
        continue;
      }
      // Only consider pairs where either side is the new chain.
      if (source !== newChain && destination !== newChain) {
        continue;
      }
      const current = destinationConfig.limits?.inbound?.[source];
      if (current !== undefined && !isZeroLimit(current)) {
        continue;
      }
      const existing = missingByDestination.get(destination);
      if (existing) {
        existing.sources.push(source);
      } else {
        missingByDestination.set(destination, {
          destination,
          sources: [source],
          defaultLimit: outbound,
          decimals,
        });
      }
    }
  }

  return Array.from(missingByDestination.values()).sort((a, b) =>
    a.destination.localeCompare(b.destination)
  );
}

/**
 * Collects inbound limit entries that are missing or zero for every destination across all chains and groups them by destination.
 *
 * @param chainsConfig - Map of chain names to their configuration objects.
 * @returns An array of `MissingInboundGroup` objects, each describing a destination, the source chains with missing or zero inbound limits, the destination's default outbound limit to suggest, and the expected decimal precision.
 */
function collectMissingInboundGroupsForAll(
  chainsConfig: Config["chains"]
): MissingInboundGroup[] {
  const chainNames = Object.keys(chainsConfig);
  const chains: Chain[] = [];
  for (const name of chainNames) {
    assertChain(name);
    chains.push(name);
  }

  const missingByDestination = new Map<Chain, MissingInboundGroup>();

  for (const destination of chains) {
    const destinationConfig = chainsConfig[destination];
    if (!destinationConfig) {
      continue;
    }
    const outbound = destinationConfig.limits?.outbound;
    if (!outbound) {
      continue;
    }
    const decimals = getDecimalsFromLimit(outbound);
    if (decimals === null) {
      console.warn(
        colors.yellow(
          `Skipping ${destination}: malformed outbound limit (${outbound})`
        )
      );
      continue;
    }
    for (const source of chains) {
      if (source === destination) {
        continue;
      }
      // Scan all destination<-source pairs for missing/zero limits.
      const current = destinationConfig.limits?.inbound?.[source];
      if (current !== undefined && !isZeroLimit(current)) {
        continue;
      }
      const existing = missingByDestination.get(destination);
      if (existing) {
        existing.sources.push(source);
      } else {
        missingByDestination.set(destination, {
          destination,
          sources: [source],
          defaultLimit: outbound,
          decimals,
        });
      }
    }
  }

  return Array.from(missingByDestination.values()).sort((a, b) =>
    a.destination.localeCompare(b.destination)
  );
}

/**
 * Set the inbound transfer limit for a specific source chain on a destination chain in the deployments config.
 *
 * @param chainsConfig - Map of chain configurations to modify
 * @param destination - Destination chain that will receive the inbound limit
 * @param source - Source chain for which the inbound limit is set on the destination
 * @param limit - Formatted limit string (for example, "123.45") to assign
 */
function setInboundLimit(
  chainsConfig: Config["chains"],
  destination: Chain,
  source: Chain,
  limit: string
) {
  const destinationConfig = chainsConfig[destination];
  if (!destinationConfig) {
    return;
  }
  if (!destinationConfig.limits) {
    destinationConfig.limits = { outbound: "0.0", inbound: {} };
  }
  if (!destinationConfig.limits.inbound) {
    destinationConfig.limits.inbound = {};
  }
  destinationConfig.limits.inbound[source] = limit;
}

/**
 * Warns about missing or zero inbound limits for the provided groups.
 *
 * @param groups - Array of MissingInboundGroup objects whose missing inbound pairs will be logged
 */
function warnMissingInbound(groups: MissingInboundGroup[]) {
  console.warn(
    colors.yellow(
      "Inbound limits are missing or zero for one or more chain pairs. Re-run without --yes or set them in the deployment file."
    )
  );
  for (const group of groups) {
    for (const source of group.sources) {
      console.warn(
        colors.yellow(`  ${group.destination} <- ${source} (inbound)`)
      );
    }
  }
}

/**
 * Interactively prompt for and apply inbound limits for the given missing groups.
 *
 * If `skipPrompts` is true, emits a warning and does not modify `deployments`.
 *
 * @param deployments - The full deployments configuration to update with chosen inbound limits
 * @param groups - Groups of destinations and their missing inbound sources to process
 * @param skipPrompts - When true, skip interactive prompting and only warn about missing inbound limits
 * @returns `true` if any inbound limits were set on `deployments`, `false` otherwise
 */
async function applyInboundGroups(
  deployments: Config,
  groups: MissingInboundGroup[],
  skipPrompts: boolean
): Promise<boolean> {
  if (groups.length === 0) {
    return false;
  }

  if (skipPrompts) {
    warnMissingInbound(groups);
    return false;
  }

  for (const group of groups) {
    const sourceDetails = group.sources
      .map((source) => {
        const current =
          deployments.chains[group.destination]?.limits?.inbound?.[source];
        const status =
          current === undefined
            ? "missing"
            : isZeroLimit(current)
              ? "zero"
              : "";
        return status ? `${source} (${status})` : source;
      })
      .sort((a, b) => a.localeCompare(b));
    console.log(
      colors.yellow(
        `Destination: ${group.destination} (inbound limits into this chain, ${group.decimals} decimals).`
      )
    );
    console.log(`Missing inbound from: ${sourceDetails.join(", ")}`);
    console.log(`Default (same as outbound): ${group.defaultLimit}`);
    const applyDefault = await promptYesNo(
      `Apply default to all missing inbound limits for ${group.destination}?`,
      { defaultYes: true, abortOnSigint: true }
    );
    const sources = [...group.sources].sort((a, b) => a.localeCompare(b));
    if (applyDefault) {
      for (const source of sources) {
        setInboundLimit(
          deployments.chains,
          group.destination,
          source,
          group.defaultLimit
        );
      }
      continue;
    }
    for (const source of sources) {
      while (true) {
        const prompt = [
          `Inbound to ${group.destination} from ${source} (${group.decimals} decimals). Press Enter for default or type 0 for zero.`,
          `Default: ${group.defaultLimit}`,
          "> ",
        ].join("\n");
        const answer = (
          await promptLine(prompt, { abortOnSigint: true })
        ).trim();
        let value = answer || group.defaultLimit;
        if (answer === "0") {
          value =
            group.decimals === 0 ? "0" : `0.${"0".repeat(group.decimals)}`;
        }
        if (!isValidLimit(value, group.decimals)) {
          console.error(
            colors.red(
              `Invalid format. Expected ${group.decimals} decimals (example: ${group.defaultLimit}).`
            )
          );
          continue;
        }
        setInboundLimit(deployments.chains, group.destination, source, value);
        break;
      }
    }
  }

  return true;
}

/**
 * Prompts to set inbound limits that are missing or zero for destinations affected by adding a new chain.
 *
 * May mutate `deployments` by setting inbound limits for the relevant chains.
 *
 * @param deployments - Deployment configuration containing chain settings to update
 * @param newChain - The chain being added which may require inbound limits on other chains
 * @param skipPrompts - If true, do not prompt interactively; emit warnings and do not apply changes
 */
export async function configureInboundLimitsForNewChain(
  deployments: Config,
  newChain: Chain,
  skipPrompts: boolean
): Promise<void> {
  const missingGroups = collectMissingInboundGroups(
    deployments.chains,
    newChain
  );
  await applyInboundGroups(deployments, missingGroups, skipPrompts);
}

/**
 * Detects missing or zero inbound limits across all chains and prompts to set them.
 *
 * @param deployments - Deployment configuration containing chain definitions and limits
 * @param skipPrompts - If true, do not prompt and instead warn about missing inbound limits
 * @returns An object with `updated` set to `true` if any limits were modified and `hadMissing` set to `true` if any missing or zero inbound limits were detected
 */
export async function configureInboundLimitsForPull(
  deployments: Config,
  skipPrompts: boolean
): Promise<{ updated: boolean; hadMissing: boolean }> {
  const missingGroups = collectMissingInboundGroupsForAll(deployments.chains);
  const hadMissing = missingGroups.length > 0;
  const updated = await applyInboundGroups(
    deployments,
    missingGroups,
    skipPrompts
  );
  return { updated, hadMissing };
}