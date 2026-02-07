import type { WormholeConfigOverrides, Network } from "@wormhole-foundation/sdk-connect";
import {
  assertChain,
  chainToPlatform,
  type Chain,
} from "@wormhole-foundation/sdk";
import { hasExecutorDeployed } from "@wormhole-foundation/sdk-evm-ntt";
import type { EvmChains } from "@wormhole-foundation/sdk-evm";

import { colors } from "../colors.js";
import { colorizeDiff, diffObjects } from "../diff";
import { loadConfig, type Config } from "../deployments";
import {
  collectMissingConfigs,
  printMissingConfigReport,
} from "../validation";
import type { Deployment } from "../validation";

import { options, EXCLUDED_DIFF_PATHS } from "./shared";
import {
  pullDeployments,
  checkConfigErrors,
  getImmutables,
  getPdas,
} from "../index";

export function createStatusCommand(overrides: WormholeConfigOverrides<Network>) {
  return {
    command: "status",
    describe: "check the status of the deployment",
    builder: (yargs: any) =>
      yargs
        .option("path", options.deploymentPath)
        .option("verbose", options.verbose)
        .example(
          "$0 status",
          "Check the status of the deployment across all chains"
        )
        .example(
          "$0 status --verbose",
          "Check the status with detailed output"
        ),
    handler: async (argv: any) => {
      const path = argv["path"];
      const verbose = argv["verbose"];
      // TODO: I don't like the variable names here
      const deployments: Config = loadConfig(path);

      const network = deployments.network as Network;

      let deps: Partial<{ [C in Chain]: Deployment<Chain> }> =
        await pullDeployments(deployments, network, verbose);

      let fixable = 0;

      const extraInfo: any = {};

      if (checkConfigErrors(deps)) {
        console.error(
          "There are errors in the config file. Please fix these before continuing."
        );
        process.exit(1);
      }

      // diff remote and local configs
      for (const [chain, deployment] of Object.entries(deps)) {
        assertChain(chain);
        const local = deployment.config.local;
        const remote = deployment.config.remote;

        const diff = diffObjects(local!, remote!, EXCLUDED_DIFF_PATHS);
        if (Object.keys(diff).length !== 0) {
          console.error(colors.reset(colorizeDiff({ [chain]: diff })));
          fixable++;
        }

        if (verbose) {
          const immutables = await getImmutables(chain, deployment.ntt);
          if (immutables) {
            extraInfo[chain] = immutables;
          }
          const pdas = await getPdas(chain, deployment.ntt);
          if (pdas) {
            extraInfo[chain] = pdas;
          }
        }
      }

      if (Object.keys(extraInfo).length > 0) {
        console.log(colors.yellow(JSON.stringify(extraInfo, null, 2)));
      }

      // verify peers
      const missing = await collectMissingConfigs(deps, verbose);

      const hasMissingConfigs = printMissingConfigReport(missing);
      if (hasMissingConfigs) {
        fixable++;
      }

      // Check executor availability for EVM chains
      for (const [chain, deployment] of Object.entries(deps)) {
        assertChain(chain);
        const platform = chainToPlatform(chain);
        if (
          platform === "Evm" &&
          !hasExecutorDeployed(network, chain as EvmChains)
        ) {
          console.log(
            colors.yellow(
              `On ${chain} ${network} no executor is deployed. Please check with the Wormhole team for availability.`
            )
          );
        }
      }

      if (fixable > 0) {
        console.error(
          "Run `ntt pull` to pull the remote configuration (overwriting the local one)"
        );
        console.error(
          "Run `ntt push` to push the local configuration (overwriting the remote one) by executing the necessary transactions"
        );
        process.exit(1);
      } else {
        console.log(`${path} is up to date with the on-chain configuration.`);
        process.exit(0);
      }
    },
  };
}
