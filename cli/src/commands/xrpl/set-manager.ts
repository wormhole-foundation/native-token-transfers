import fs from "fs";
import type {
  Network,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk-connect";
import { colors } from "../../colors.js";
import { loadConfig } from "../../deployments";
import {
  loadSeed,
  runXrpl,
  validateRAddress,
  walletFromSeed,
} from "../../xrpl/helpers";
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
        })
        .option("seed", {
          describe: "Custody seed to derive the address from (or env SEED)",
          type: "string",
        })
        .option("algorithm", {
          describe: "Key algorithm when deriving the address from --seed",
          type: "string",
          choices: ["ed25519", "secp256k1"] as const,
        })
        .option("path", options.deploymentPath)
        .example(
          "$0 xrpl set-manager --account r9qA...",
          "Record an existing custody account"
        )
        .example(
          "$0 xrpl set-manager --seed sEd7...",
          "Derive the account from its seed and record it"
        ),
    handler: (argv: any) =>
      runXrpl(async () => {
        const path = argv.path;
        const config = loadConfig(path);

        let manager: string;
        if (argv.account) {
          manager = validateRAddress(argv.account);
        } else {
          const seed = loadSeed(argv.seed, "seed", "SEED");
          manager = walletFromSeed(seed, argv.algorithm).address;
        }

        config.xrpl = { ...config.xrpl, manager };
        fs.writeFileSync(path, JSON.stringify(config, null, 2));

        console.log(
          colors.green(`✅ Recorded XRPL manager: ${colors.yellow(manager)}`)
        );
        console.log(`   ${path} → xrpl.manager`);
      }),
  };
}
