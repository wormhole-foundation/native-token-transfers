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
import { options, EXCLUDED_DIFF_PATHS, getNestedValue, setNestedValue } from "./shared";
import { pullDeployments, askForConfirmation } from "../index";
import type { Deployment } from "../validation";

export function createPullCommand(
  overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "pull",
    describe: "pull the remote configuration",
    builder: (yargs: Argv) =>
      yargs
        .option("path", options.deploymentPath)
        .option("yes", options.yes)
        .option("verbose", options.verbose)
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
      const deps: Partial<{ [C in Chain]: Deployment<Chain> }> =
        await pullDeployments(deployments, network, verbose);

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
      if (!changed) {
        console.log(`${path} is already up to date`);
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
