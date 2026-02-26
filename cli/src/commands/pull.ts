import fs from "fs";
import {
  assertChain,
  type Chain,
  type Network,
} from "@wormhole-foundation/sdk";
import type { WormholeConfigOverrides } from "@wormhole-foundation/sdk-connect";
import type { Argv } from "yargs";
import { colors } from "../colors.js";
import { loadConfig, type Config } from "../deployments";
import { colorizeDiff, diffObjects } from "../diff";
import {
  options,
  EXCLUDED_DIFF_PATHS,
  getNestedValue,
  setNestedValue,
  resolveRpcConcurrency,
} from "./shared";
import { pullDeployments, askForConfirmation } from "../index";
import { configureInboundLimitsForPull } from "../limits.js";
import type { Deployment } from "../validation";

export function createPullCommand(overrides: WormholeConfigOverrides<Network>) {
  return {
    command: "pull",
    describe: "pull the remote configuration",
    builder: (yargs: Argv) =>
      yargs
        .option("path", options.deploymentPath)
        .option("yes", options.yes)
        .option("verbose", options.verbose)
        .option("rpc-concurrency", options.rpcConcurrency)
        .example(
          "$0 pull",
          "Pull the latest configuration from the blockchain for all chains"
        )
        .example(
          "$0 pull --yes",
          "Pull the latest configuration and apply changes without confirmation"
        ),
    handler: async (argv: any) => {
      const deployments: Config = loadConfig(argv["path"]);
      const verbose = argv["verbose"];
      const network = deployments.network as Network;
      const path = argv["path"];
      const maxConcurrent = resolveRpcConcurrency(argv["rpc-concurrency"]);
      const { deps, failures } = await pullDeployments(
        deployments,
        network,
        verbose,
        maxConcurrent,
        overrides
      );

      let changed = false;
      for (const [chain, deployment] of Object.entries(deps)) {
        assertChain(chain);
        const diff = diffObjects(
          deployments.chains[chain]!,
          deployment.config.remote!,
          EXCLUDED_DIFF_PATHS
        );
        if (Object.keys(diff).length !== 0) {
          console.error(colors.reset(colorizeDiff({ [chain]: diff })));
          changed = true;
          // Preserve excluded fields from local config when pulling
          const preservedConfig = { ...deployment.config.remote! };
          for (const excludedPath of EXCLUDED_DIFF_PATHS) {
            const pathParts = excludedPath.split(".");
            const localValue = getNestedValue(
              deployments.chains[chain]!,
              pathParts
            );
            if (localValue !== undefined) {
              setNestedValue(preservedConfig, [...pathParts], localValue);
            }
          }
          deployments.chains[chain] = preservedConfig;
        }
      }
      if (failures.length > 0) {
        console.error("Pull incomplete due to chain fetch failures:");
        for (const failure of failures) {
          console.error(
            `  ${failure.chain}: ${failure.message ?? failure.reason}`
          );
        }
        process.exit(1);
      }
      const inboundResult = await configureInboundLimitsForPull(
        deployments,
        Boolean(argv["yes"])
      );
      const shouldWrite = changed || inboundResult.updated;
      if (!shouldWrite) {
        if (!inboundResult.hadMissing) {
          console.log(`${path} is already up to date`);
        }
        process.exit(0);
      }

      if (!argv["yes"]) {
        await askForConfirmation();
      }
      fs.writeFileSync(path, JSON.stringify(deployments, null, 2));
      console.log(`Updated ${path}`);
    },
  };
}
