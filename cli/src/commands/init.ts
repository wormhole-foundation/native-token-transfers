import fs from "fs";
import { isNetwork } from "@wormhole-foundation/sdk";
import type { Argv } from "yargs";
import { colors } from "../colors.js";
import { options } from "./shared";

export function createInitCommand() {
  return {
    command: "init <network>",
    describe: "initialize a deployment file",
    builder: (yargs: Argv) =>
      yargs
        .positional("network", options.network)
        .option("path", options.deploymentPath)
        .example(
          "$0 init Testnet",
          "Initialize a new deployment file for the Testnet network"
        )
        .example(
          "$0 init Mainnet --path custom.json",
          "Initialize a new deployment file for Mainnet with a custom file name"
        ),
    handler: async (argv: any) => {
      if (!isNetwork(argv["network"])) {
        console.error("Invalid network");
        process.exit(1);
      }
      const deployment = {
        network: argv["network"],
        chains: {},
      };
      const path = argv["path"];
      // check if the file exists
      if (fs.existsSync(path)) {
        console.error(
          `Deployment file already exists at ${path}. Specify a different path with --path`
        );
        process.exit(1);
      }
      fs.writeFileSync(path, JSON.stringify(deployment, null, 2));
      console.log(
        colors.green(
          `${path} created — this file stores your NTT deployment configuration`
        )
      );
      console.log(
        colors.cyan(
          `\nTip: To use custom RPC endpoints, rename example-overrides.json to overrides.json and edit as needed.`
        )
      );
    },
  };
}
