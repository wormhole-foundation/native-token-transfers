import { assertChain, type Chain } from "@wormhole-foundation/sdk";
import { colors } from "./colors.js";
import type { Config } from "./deployments";
import {
  getDecimalsFromLimit,
  isValidLimit,
  isZeroLimit,
} from "./limitFormatting.js";
import { promptLine, promptYesNo } from "./prompts.js";

type MissingInboundGroup = {
  destination: Chain;
  sources: Chain[];
  defaultLimit: string;
  decimals: number;
};

/** Group missing/zero inbound limits by destination. When newChain is provided,
 *  only pairs involving that chain are considered. */
export function collectMissingInboundGroups(
  chainsConfig: Config["chains"],
  newChain?: Chain
): MissingInboundGroup[] {
  const chainNames = Object.keys(chainsConfig);
  const chains: Chain[] = [];
  for (const name of chainNames) {
    assertChain(name);
    chains.push(name);
  }

  if (newChain && !chains.includes(newChain)) {
    return [];
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
      // When scoped to a new chain, only consider pairs where either side is that chain.
      if (newChain && source !== newChain && destination !== newChain) {
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
    // Placeholder outbound; normal flows only call setInboundLimit when outbound is already configured.
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

/** Apply inbound limit prompts for the provided missing groups. */
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
  await applyInboundGroups(deployments, missingGroups, skipPrompts);
}

/** Configure missing/zero inbound limits across all chains, prompting as needed. */
export async function configureInboundLimitsForPull(
  deployments: Config,
  skipPrompts: boolean
): Promise<{ updated: boolean; hadMissing: boolean }> {
  const missingGroups = collectMissingInboundGroups(deployments.chains);
  const hadMissing = missingGroups.length > 0;
  const updated = await applyInboundGroups(
    deployments,
    missingGroups,
    skipPrompts
  );
  return { updated, hadMissing };
}
