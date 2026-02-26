import fs from "fs";
import {
  chainToPlatform,
  Wormhole,
  type Chain,
  type Network,
} from "@wormhole-foundation/sdk";
import type { WormholeConfigOverrides } from "@wormhole-foundation/sdk-connect";
import type { Ntt } from "@wormhole-foundation/sdk-definitions-ntt";
import evm from "@wormhole-foundation/sdk/platforms/evm";
import solana from "@wormhole-foundation/sdk/platforms/solana";
import sui from "@wormhole-foundation/sdk/platforms/sui";
import type { Argv } from "yargs";
import { colors } from "../colors.js";
import { loadConfig, type Config } from "../deployments";
import { enableBigBlocks } from "../evm/hyperliquid.js";
import { promptYesNo } from "../prompts.js";
import { promptSolanaMainnetOverridesIfNeeded } from "../overrides.js";
import { validatePayerOption } from "../validation";
import type { SignerType } from "../signers/getSigner";
import { options } from "./shared";
import type { CclConfig } from "./shared";
import {
  deploy,
  pullChainConfig,
  resolveVersion,
  validateChain,
  askForConfirmation,
  parseCclFlag,
  confirmCustomFinality,
} from "../index";
import { configureInboundLimitsForNewChain } from "../limits.js";

export function createAddChainCommand(
  overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "add-chain <chain>",
    describe: "add a chain to the deployment file",
    builder: (yargs: Argv) =>
      yargs
        .positional("chain", options.chain)
        // TODO: add ability to specify manager address (then just pull the config)
        // .option("manager", {
        //     describe: "Manager address",
        //     type: "string",
        // })
        .option("program-key", {
          describe: "Path to program key json (SVM)",
          type: "string" as const,
        })
        .option("payer", {
          describe: "Path to payer key json (SVM)",
          type: "string" as const,
        })
        .option("binary", {
          describe: "Path to program binary (.so file -- SVM)",
          type: "string" as const,
        })
        .option("token", {
          describe: "Token address",
          type: "string" as const,
        })
        .option("mode", {
          alias: "m",
          describe: "Mode",
          type: "string" as const,
          choices: ["locking", "burning"] as const,
        })
        .option("solana-priority-fee", {
          describe: "Priority fee for SVM deployment (in microlamports)",
          type: "number" as const,
          default: 50000,
        })
        .option("sui-gas-budget", {
          describe: "Gas budget for Sui deployment",
          type: "number" as const,
          default: 500000000,
        })
        .option("sui-package-path", {
          describe:
            "Path to Sui Move package directory (relative to project root)",
          type: "string" as const,
          default: "sui",
        })
        .option("sui-wormhole-state", {
          describe:
            "Wormhole state object ID for Sui (optional, will lookup from SDK if not provided)",
          type: "string" as const,
        })
        .option("sui-treasury-cap", {
          describe: "Treasury cap object ID for Sui burning mode deployment",
          type: "string" as const,
        })
        .option("signer-type", options.signerType)
        .option("skip-verify", options.skipVerify)
        .option("gas-estimate-multiplier", options.gasEstimateMultiplier)
        .option("ver", options.version)
        .option("latest", options.latest)
        .option("local", options.local)
        .option("path", options.deploymentPath)
        .option("yes", options.yes)
        .option("manager-variant", {
          describe: "NttManager variant to deploy (EVM only)",
          type: "string" as const,
          choices: ["standard", "noRateLimiting", "wethUnwrap"] as const,
          default: "standard",
        })
        .option("unsafe-custom-finality", {
          describe:
            "Enable custom consistency level (CCL) for advanced finality control (EVM only). Format: 'level:blocks' where level is 200 (instant), 201 (safe), or 202 (finalized), and blocks is additional wait time. Example: '200:5' means instant + 5 blocks. Requires explicit confirmation.",
          type: "string" as const,
        })
        .example(
          "$0 add-chain Ethereum --token 0x1234... --mode burning --latest",
          "Add Ethereum chain with the latest contract version in burning mode"
        )
        .example(
          "$0 add-chain Solana --token Sol1234... --mode locking --ver 1.0.0",
          "Add Solana chain with a specific contract version in locking mode"
        )
        .example(
          "$0 add-chain Avalanche --token 0xabcd... --mode burning --local",
          "Add Avalanche chain using the local contract version"
        )
        .example(
          "$0 add-chain Sui --token 0x123::mycoin::MYCOIN --mode burning --sui-treasury-cap 0xabc123... --latest",
          "Add Sui chain in burning mode with treasury cap"
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
      const version = resolveVersion(
        argv["latest"],
        argv["ver"],
        argv["local"],
        chainToPlatform(chain)
      );
      let mode = argv["mode"] as Ntt.Mode | undefined;
      const signerType = argv["signer-type"] as SignerType;
      const token = argv["token"];
      const network = deployments.network as Network;

      if (chain in deployments.chains) {
        console.error(`Chain ${chain} already exists in ${path}`);
        process.exit(1);
      }

      validateChain(network, chain);
      await promptSolanaMainnetOverridesIfNeeded(
        network,
        chain,
        overrides,
        Boolean(argv["yes"])
      );

      // Parse and validate CCL configuration (EVM only)
      let cclConfig: CclConfig | null = null;
      const platform = chainToPlatform(chain);
      if (argv["unsafe-custom-finality"]) {
        if (platform !== "Evm") {
          console.error(
            colors.red(
              "Error: --unsafe-custom-finality is only supported for EVM chains"
            )
          );
          process.exit(1);
        }

        try {
          cclConfig = parseCclFlag(
            argv["unsafe-custom-finality"],
            network,
            chain
          );

          // Show warning and get confirmation
          const confirmed = await confirmCustomFinality();
          if (!confirmed) {
            console.log("Aborting deployment");
            process.exit(0);
          }
        } catch (error) {
          console.error(colors.red(`Error: ${(error as Error).message}`));
          process.exit(1);
        }
      }

      const existsLocking = Object.values(deployments.chains).some(
        (c) => c.mode === "locking"
      );

      if (existsLocking) {
        if (mode && mode === "locking") {
          console.error("Only one locking chain is allowed");
          process.exit(1);
        }
        mode = "burning";
      }

      if (!mode) {
        console.error("Mode is required (use --mode)");
        process.exit(1);
      }

      if (!token) {
        console.error("Token is required (use --token)");
        process.exit(1);
      }

      // HyperEVM confirmation
      if (chain === "HyperEVM" && !argv["yes"]) {
        console.log(
          colors.yellow("\u26A0\uFE0F  HyperEVM Deployment Requirements:")
        );
        console.log(
          colors.yellow(
            "Before proceeding with the HyperEVM deployment, please ensure:"
          )
        );
        console.log(
          colors.yellow(
            "1. You have created a verified account by depositing into Hyperliquid from the deployer wallet"
          )
        );
        console.log(
          colors.white("   Hyperliquid app: https://app.hyperliquid.xyz/")
        );
        console.log(
          colors.yellow(
            "2. You have enabled larger blocks to be used for the deployment"
          )
        );
        console.log(
          colors.white(
            "   Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/dual-block-architecture"
          )
        );
        console.log(colors.yellow(""));

        // Ask if user wants to enable big blocks now
        const shouldEnableBigBlocks = await promptYesNo(
          "Would you like to enable big blocks now?",
          { defaultYes: true }
        );

        if (shouldEnableBigBlocks) {
          if (network !== "Mainnet" && network !== "Testnet") {
            console.error(
              colors.red(
                `Error: Automatic big blocks toggle is only supported for "Mainnet" or "Testnet" networks, got "${network}". Please enable big blocks manually.`
              )
            );
            process.exit(1);
          }
          await enableBigBlocks(network === "Testnet");
        } else {
          console.log(
            colors.white("Please enable big blocks manually before proceeding:")
          );
          console.log(
            colors.white(
              "   Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/dual-block-architecture"
            )
          );
          console.log(colors.yellow(""));
          await askForConfirmation("Did you enable big blocks manually?");
        }

        // Confirm the verified account requirement
        await askForConfirmation(
          "Did you create a verified account by depositing into Hyperliquid from the deployer wallet?"
        );
      }

      // let's deploy

      // TODO: factor out to function to get chain context
      const wh = new Wormhole(
        network,
        [solana.Platform, evm.Platform, sui.Platform],
        overrides
      );
      const ch = wh.getChain(chain);

      // TODO: make manager configurable
      const deployedManager = await deploy(
        version,
        mode,
        ch,
        token,
        signerType,
        !argv["skip-verify"],
        argv["yes"],
        argv["manager-variant"],
        payerPath,
        argv["program-key"],
        argv["binary"],
        argv["solana-priority-fee"],
        argv["sui-gas-budget"],
        argv["sui-package-path"],
        argv["sui-wormhole-state"],
        argv["sui-treasury-cap"],
        argv["gas-estimate-multiplier"],
        cclConfig,
        overrides
      );

      const [config, _ctx, _ntt, decimals] = await pullChainConfig(
        network,
        deployedManager,
        overrides
      );

      console.log("token decimals:", colors.yellow(decimals));

      // Add manager variant to config for EVM chains
      if (platform === "Evm" && argv["manager-variant"]) {
        config.managerVariant = argv["manager-variant"];
      }

      deployments.chains[chain] = config;
      await configureInboundLimitsForNewChain(
        deployments,
        chain,
        Boolean(argv["yes"])
      );
      fs.writeFileSync(path, JSON.stringify(deployments, null, 2));
      console.log(`Added ${chain} to ${path}`);
    },
  };
}
