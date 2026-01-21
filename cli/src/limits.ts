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

/** Extract the decimal precision from a formatted limit string. */
function getDecimalsFromLimit(limit: string): number | null {
  const parts = limit.split(".");
  if (parts.length !== 2) {
    return null;
  }
  return parts[1].length;
}

/** Determine if a formatted limit represents zero. */
function isZeroLimit(value: string): boolean {
  const normalized = value.replace(".", "");
  return normalized.length === 0 || /^0+$/.test(normalized);
}

/** Validate a formatted limit against expected decimal precision. */
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

/** Group missing/zero inbound limits by destination for the new chain. */
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
      continue;
    }
    for (const source of relevantChains) {
      if (source === destination) {
        continue;
      }
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

/** Write a single inbound limit value into the deployment config. */
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

/** Emit a warning for missing/zero inbound limits when prompts are skipped. */
function warnMissingInbound(groups: MissingInboundGroup[]) {
  console.warn(
    colors.yellow(
      "Inbound limits are missing or zero for the new chain. Re-run without --yes or set them in the deployment file."
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

/** Configure missing/zero inbound limits for a new chain, prompting as needed. */
export async function configureInboundLimitsForNewChain(
  deployments: Config,
  newChain: Chain,
  skipPrompts: boolean
): Promise<void> {
  const missingGroups = collectMissingInboundGroups(
    deployments.chains,
    newChain
  );
  if (missingGroups.length === 0) {
    return;
  }

  if (skipPrompts) {
    warnMissingInbound(missingGroups);
    return;
  }

  for (const group of missingGroups) {
    console.log(
      colors.yellow(
        `Destination: ${group.destination} (inbound limits into this chain, ${group.decimals} decimals).`
      )
    );
    console.log(`Default (same as outbound): ${group.defaultLimit}`);
    const applyDefault = await promptYesNo(
      `Apply default to all missing inbound limits for ${group.destination}?`,
      { defaultYes: true }
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
        const answer = (await promptLine(prompt)).trim();
        let value = answer || group.defaultLimit;
        if (answer === "0") {
          value =
            group.decimals === 0
              ? "0"
              : `0.${"0".repeat(group.decimals)}`;
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
}
