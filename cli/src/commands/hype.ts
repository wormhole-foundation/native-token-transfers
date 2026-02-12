import type {
  WormholeConfigOverrides,
  Network,
} from "@wormhole-foundation/sdk-connect";

import { colors } from "../colors.js";
import { loadConfig, type Config } from "../deployments";
import { enableBigBlocks } from "../evm/hyperliquid.js";
import fs from "fs";

import { options } from "./shared";

export function createHypeCommand(overrides: WormholeConfigOverrides<Network>) {
  return {
    command: "hype",
    describe: "Hyperliquid/HyperEVM utilities",
    builder: (yargs: any) => {
      return yargs
        .command(
          "set-big-blocks",
          "Enable or disable big blocks for HyperEVM deployments",
          (yargs: any) =>
            yargs
              .option("disable", {
                alias: "d",
                describe: "Disable big blocks",
                type: "boolean",
                default: false,
              })
              .option("path", {
                ...options.deploymentPath,
                describe:
                  "Path to deployment.json (used to detect network). Falls back to --testnet flag if not found.",
              })
              .option("testnet", {
                describe:
                  "Override: use HyperEVM testnet instead of mainnet (only needed if no deployment.json)",
                type: "boolean",
              })
              .example(
                "$0 hype set-big-blocks",
                "Enable big blocks (reads network from deployment.json)"
              )
              .example("$0 hype set-big-blocks --disable", "Disable big blocks")
              .example(
                "$0 hype set-big-blocks -d",
                "Disable big blocks (short form)"
              ),
          async (argv: any) => {
            const deploymentPath = argv["path"];

            // Determine network: try deployment.json first, then fall back to --testnet flag
            let isTestnet: boolean;
            if (fs.existsSync(deploymentPath)) {
              const deployments: Config = loadConfig(deploymentPath);
              isTestnet = deployments.network === "Testnet";
            } else if (argv["testnet"] !== undefined) {
              isTestnet = argv["testnet"];
            } else {
              console.error(
                colors.red(
                  `No deployment.json found at ${deploymentPath}. Please specify --testnet or --testnet=false to indicate the network.`
                )
              );
              process.exit(1);
            }

            await enableBigBlocks(isTestnet, !argv["disable"]);
          }
        )
        .demandCommand();
    },
    handler: (_argv: any) => {},
  };
}
