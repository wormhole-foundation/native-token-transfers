import type { WormholeConfigOverrides, Network } from "@wormhole-foundation/sdk-connect";
import {
  Wormhole,
  chainToPlatform,
  toUniversal,
  type Chain,
} from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/platforms/evm";
import solana from "@wormhole-foundation/sdk/platforms/solana";
import sui from "@wormhole-foundation/sdk/platforms/sui";

import { colors } from "../colors.js";
import { loadConfig, type Config } from "../deployments";
import type { SignerType } from "../getSigner";
import { validatePayerOption } from "../validation";

import { options } from "./shared";
import {
  pullChainConfig,
  resolveVersion,
  askForConfirmation,
  nttFromManager,
  getVersion,
  upgrade,
  warnLocalDeployment,
} from "../index";

import fs from "fs";

export function createUpgradeCommand(overrides: WormholeConfigOverrides<Network>) {
  return {
    command: "upgrade <chain>",
    describe: "upgrade the contract on a specific chain",
    builder: (yargs: any) =>
      yargs
        .positional("chain", options.chain)
        .option("ver", options.version)
        .option("latest", {
          describe: "Use the latest version",
          type: "boolean",
          default: false,
        })
        .option("local", options.local)
        .option("signer-type", options.signerType)
        .option("skip-verify", options.skipVerify)
        .option("path", options.deploymentPath)
        .option("yes", options.yes)
        .option("payer", {
          describe: "Path to payer key json (SVM)",
          type: "string",
        })
        .option("program-key", {
          describe: "Path to program key json (SVM)",
          type: "string",
        })
        .option("binary", {
          describe: "Path to program binary (.so file -- SVM)",
          type: "string",
        })
        .option("gas-estimate-multiplier", options.gasEstimateMultiplier)
        .option("manager-variant", {
          describe:
            "NttManager variant to upgrade to (EVM only). If not specified, preserves the existing variant from deployment config.",
          type: "string",
          choices: ["standard", "noRateLimiting", "wethUnwrap"],
        })
        .example(
          "$0 upgrade Ethereum --latest",
          "Upgrade the Ethereum contract to the latest version"
        )
        .example(
          "$0 upgrade Solana --ver 1.1.0",
          "Upgrade the Solana contract to version 1.1.0"
        )
        .example(
          "$0 upgrade Polygon --local --skip-verify",
          "Upgrade the Polygon contract using the local version, skipping explorer bytecode verification"
        ),
    handler: async (argv: any) => {
      const path = argv["path"];
      const deployments: Config = loadConfig(path);
      const chain: Chain = argv["chain"];
      const payerPath = validatePayerOption(
        argv["payer"],
        chain,
        (message) => new Error(message),
        (message) => console.warn(colors.yellow(message))
      );
      const signerType = argv["signer-type"] as SignerType;
      const network = deployments.network as Network;

      if (!(chain in deployments.chains)) {
        console.error(`Chain ${chain} not found in ${path}`);
        process.exit(1);
      }

      const chainConfig = deployments.chains[chain]!;
      const currentVersion = chainConfig.version;
      const platform = chainToPlatform(chain);

      const toVersion = resolveVersion(
        argv["latest"],
        argv["ver"],
        argv["local"],
        platform
      );

      if (argv["local"]) {
        await warnLocalDeployment(argv["yes"]);
      }

      if (toVersion === currentVersion && !argv["local"]) {
        console.log(`Chain ${chain} is already at version ${currentVersion}`);
        process.exit(0);
      }

      console.log(
        `Upgrading ${chain} from version ${currentVersion} to ${
          toVersion || "local version"
        }`
      );

      if (!argv["yes"]) {
        await askForConfirmation();
      }

      const wh = new Wormhole(
        network,
        [solana.Platform, evm.Platform, sui.Platform],
        overrides
      );
      const ch = wh.getChain(chain);

      const [_, ctx, ntt] = await pullChainConfig(
        network,
        { chain, address: toUniversal(chain, chainConfig.manager) },
        overrides
      );

      // Determine manager variant: use flag if provided, otherwise use config value, default to "standard"
      const managerVariant =
        argv["manager-variant"] ?? chainConfig.managerVariant ?? "standard";

      await upgrade(
        currentVersion,
        toVersion,
        ntt,
        ctx,
        signerType,
        !argv["skip-verify"],
        managerVariant,
        payerPath,
        argv["program-key"],
        argv["binary"],
        argv["gas-estimate-multiplier"]
      );

      // reinit the ntt object to get the new version
      // TODO: is there an easier way to do this?
      const { ntt: upgraded } = await nttFromManager(ch, chainConfig.manager);

      chainConfig.version = getVersion(chain, upgraded);
      fs.writeFileSync(path, JSON.stringify(deployments, null, 2));

      console.log(
        `Successfully upgraded ${chain} to version ${
          toVersion || "local version"
        }`
      );
    },
  };
}
