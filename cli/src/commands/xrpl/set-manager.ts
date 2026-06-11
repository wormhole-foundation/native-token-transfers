import fs from "fs";
import type {
  Network,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk-connect";
import { colors } from "../../colors.js";
import { loadConfig } from "../../deployments";
import { runXrpl, validateRAddress } from "../../xrpl/helpers";
import { options } from "../shared";

export function createXrplSetManagerCommand(
  _overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "set-manager",
    describe: "Record the XRPL custody (manager) account in the deployment file",
    builder: (yargs: any) =>
      yargs
        .option("account", {
          describe: "XRPL custody account r-address",
          type: "string",
          demandOption: true,
        })
        .option("path", options.deploymentPath)
        .example(
          "$0 xrpl set-manager --account r9qA...",
          "Record the custody account"
        ),
    handler: (argv: any) =>
      runXrpl(async () => {
        const path = argv.path;
        const config = loadConfig(path);

        const manager = validateRAddress(argv.account);

        config.xrpl = { ...config.xrpl, manager };
        fs.writeFileSync(path, JSON.stringify(config, null, 2));

        console.log(
          colors.green(`✅ Recorded XRPL manager: ${colors.yellow(manager)}`)
        );
        console.log(`   ${path} → xrpl.manager`);
      }),
  };
}
