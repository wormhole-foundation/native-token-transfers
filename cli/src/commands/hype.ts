import type {
  WormholeConfigOverrides,
  Network,
} from "@wormhole-foundation/sdk-connect";

import { colors } from "../colors.js";
import { loadConfig, type Config } from "../deployments";
import {
  enableBigBlocks,
  spotRequestEvmContract,
  spotFinalizeEvmContract,
  computeDeployNonceFromHyperEvm,
  getDeployerAddress,
  computeAssetBridge,
  bridgeIn,
  spotSend,
  getSpotTokenString,
} from "../evm/hyperliquid.js";
import {
  parseIntegerInRange,
  parsePositiveDecimalAmount,
  parseEvmAddress,
} from "../hype/validation.js";
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
        .command(
          "link",
          "Link a HyperCore spot token to its HyperEVM ERC-20 contract",
          (yargs: any) =>
            yargs
              .option("token-index", {
                describe:
                  "HyperCore spot token index (0–65535). Required unless --only-finalize reads it from deployment.json.",
                type: "number",
              })
              .option("evm-extra-wei-decimals", {
                describe:
                  "evmExtraWeiDecimals = ERC-20 decimals(18) minus weiDecimals. Defaults to 10.",
                type: "number",
                default: 10,
              })
              .option("deploy-nonce", {
                describe:
                  "ERC-20 CREATE deploy nonce (auto-derived from deployer address if omitted)",
                type: "number",
              })
              .option("only-finalize", {
                describe:
                  "Skip the request step and only run finalize. --token-index falls back to deployment.json if omitted.",
                type: "boolean",
                default: false,
              })
              .option("path", options.deploymentPath)
              .option("testnet", {
                describe:
                  "Use HyperLiquid testnet (overrides deployment.json)",
                type: "boolean",
              })
              .check((argv: any) => {
                if (
                  !argv["only-finalize"] &&
                  argv["token-index"] === undefined
                ) {
                  throw new Error(
                    "--token-index is required (or use --only-finalize to skip the request step and read the token index from deployment.json)"
                  );
                }
                return true;
              })
              .example(
                "$0 hype link --token-index 1591",
                "Request + finalize EVM link for token 1591"
              )
              .example(
                "$0 hype link --only-finalize",
                "Finalize EVM link (reads token index from deployment.json)"
              )
              .example(
                "$0 hype link --only-finalize --token-index 1591",
                "Finalize EVM link with explicit token index"
              ),
          async (argv: any) => {
            const onlyFinalize = argv["only-finalize"] as boolean;
            const deploymentPath = argv["path"] as string;
            const deployments: Config = loadConfig(deploymentPath);
            const isTestnet =
              argv["testnet"] !== undefined
                ? (argv["testnet"] as boolean)
                : deployments.network === "Testnet";

            const privateKey = process.env.ETH_PRIVATE_KEY;
            if (!privateKey) {
              console.error(
                colors.red("ETH_PRIVATE_KEY environment variable is not set.")
              );
              process.exit(1);
              return;
            }

            const hyperEvmChain = deployments.chains["HyperEVM"];
            if (!hyperEvmChain?.token) {
              console.error(
                colors.red(
                  "No HyperEVM chain config found in deployment.json. Add HyperEVM chain first."
                )
              );
              process.exit(1);
              return;
            }

            // Resolve and validate token index and EVM address
            let tokenIndex: number;
            let address: string;
            try {
              const rawTokenIndex =
                argv["token-index"] !== undefined
                  ? (argv["token-index"] as number)
                  : deployments.hypercore?.tokenIndex;
              if (rawTokenIndex === undefined) {
                throw new Error(
                  "--token-index is required (or run 'ntt hype link' first to save it to deployment.json)"
                );
              }
              tokenIndex = parseIntegerInRange(
                "--token-index",
                rawTokenIndex,
                0,
                0xffff
              );
              address = parseEvmAddress("HyperEVM token", hyperEvmChain.token);
            } catch (error) {
              console.error(
                colors.red(
                  `Invalid input: ${error instanceof Error ? error.message : String(error)}`
                )
              );
              process.exit(1);
              return;
            }

            if (!onlyFinalize) {
              // Step 1: request
              let evmExtraWeiDecimals: number;
              try {
                evmExtraWeiDecimals = parseIntegerInRange(
                  "--evm-extra-wei-decimals",
                  argv["evm-extra-wei-decimals"] as number,
                  0,
                  18
                );
              } catch (error) {
                console.error(
                  colors.red(
                    `Invalid input: ${error instanceof Error ? error.message : String(error)}`
                  )
                );
                process.exit(1);
                return;
              }

              console.log(
                colors.cyan(
                  `[1/2] Requesting EVM contract link: token ${tokenIndex} → ${address}`
                )
              );
              try {
                await spotRequestEvmContract(
                  privateKey,
                  tokenIndex,
                  address,
                  evmExtraWeiDecimals,
                  isTestnet
                );
              } catch (err) {
                console.error(
                  colors.red(
                    `Request failed: ${err instanceof Error ? err.message : String(err)}`
                  )
                );
                process.exit(1);
                return;
              }
            }

            // Finalize step (step 2 of 2 normally, or step 1 of 1 with --only-finalize)
            const deployerAddress = getDeployerAddress(privateKey);

            let deployNonce: number;
            if (argv["deploy-nonce"] !== undefined) {
              try {
                deployNonce = parseIntegerInRange(
                  "--deploy-nonce",
                  argv["deploy-nonce"] as number,
                  0
                );
              } catch (error) {
                console.error(
                  colors.red(
                    `Invalid input: ${error instanceof Error ? error.message : String(error)}`
                  )
                );
                process.exit(1);
                return;
              }
            } else {
              console.log(
                colors.cyan("Auto-deriving deploy nonce from deployer address…")
              );
              try {
                deployNonce = await computeDeployNonceFromHyperEvm(
                  deployerAddress,
                  address,
                  isTestnet
                );
              } catch (err) {
                console.error(
                  colors.red(
                    `Failed to auto-derive deploy nonce: ${err instanceof Error ? err.message : String(err)}`
                  )
                );
                process.exit(1);
                return;
              }
              console.log(
                colors.cyan(`  Derived deploy nonce: ${deployNonce}`)
              );
            }

            const stepLabel = onlyFinalize ? "[1/1]" : "[2/2]";
            console.log(
              colors.cyan(
                `${stepLabel} Finalizing EVM contract link: token ${tokenIndex}, nonce ${deployNonce}`
              )
            );
            try {
              await spotFinalizeEvmContract(
                privateKey,
                tokenIndex,
                deployNonce,
                isTestnet
              );
            } catch (err) {
              console.error(
                colors.red(
                  `Finalize failed: ${err instanceof Error ? err.message : String(err)}`
                )
              );
              process.exit(1);
              return;
            }

            // Persist tokenIndex to deployment.json
            const raw = JSON.parse(fs.readFileSync(deploymentPath).toString());
            raw.hypercore = { ...(raw.hypercore ?? {}), tokenIndex };
            fs.writeFileSync(
              deploymentPath,
              JSON.stringify(raw, null, 2) + "\n"
            );

            console.log(
              colors.green(
                `Link complete. Token index ${tokenIndex} saved to deployment.json.`
              )
            );
          }
        )
        .command(
          "bridge-in <amount>",
          "Bridge tokens from HyperEVM into HyperCore (ERC-20 transfer to asset bridge)",
          (yargs: any) =>
            yargs
              .positional("amount", {
                describe:
                  "Human-readable token amount to bridge into HyperCore (e.g. '1.0'). ERC-20 decimals are fetched automatically.",
                type: "string",
                demandOption: true,
              })
              .option("path", options.deploymentPath)
              .example(
                "$0 hype bridge-in 1.0",
                "Transfer 1.0 tokens from HyperEVM into HyperCore"
              ),
          async (argv: any) => {
            const deploymentPath = argv["path"] as string;
            const deployments: Config = loadConfig(deploymentPath);

            const hypercore = deployments.hypercore;
            if (hypercore?.tokenIndex === undefined) {
              console.error(
                colors.red(
                  "No 'hypercore.tokenIndex' found in deployment.json. Run 'ntt hype link' first."
                )
              );
              process.exit(1);
              return;
            }

            const hyperEvmChain = deployments.chains["HyperEVM"];
            if (!hyperEvmChain?.token) {
              console.error(
                colors.red(
                  "No HyperEVM chain config found in deployment.json."
                )
              );
              process.exit(1);
              return;
            }

            let assetBridge: string;
            let amount: string;
            let tokenAddress: string;
            try {
              assetBridge = computeAssetBridge(hypercore.tokenIndex);
              amount = parsePositiveDecimalAmount(
                "<amount>",
                argv["amount"] as string
              );
              tokenAddress = parseEvmAddress(
                "HyperEVM token",
                hyperEvmChain.token
              );
            } catch (error) {
              console.error(
                colors.red(
                  `Invalid input: ${error instanceof Error ? error.message : String(error)}`
                )
              );
              process.exit(1);
              return;
            }

            const privateKey = process.env.ETH_PRIVATE_KEY;
            if (!privateKey) {
              console.error(
                colors.red("ETH_PRIVATE_KEY environment variable is not set.")
              );
              process.exit(1);
              return;
            }

            const isTestnet = deployments.network === "Testnet";

            console.log(
              colors.cyan(
                `Bridging IN: transferring ${amount} tokens of ${tokenAddress} to asset bridge ${assetBridge}`
              )
            );

            try {
              const txHash = await bridgeIn(
                privateKey,
                tokenAddress,
                assetBridge,
                amount,
                isTestnet
              );
              console.log(colors.cyan(`  tx hash: ${txHash}`));
              console.log(
                colors.green(
                  `bridge-in complete. ${amount} tokens transferred to HyperCore asset bridge.`
                )
              );
            } catch (err) {
              console.error(
                colors.red(
                  `bridge-in failed: ${err instanceof Error ? err.message : String(err)}`
                )
              );
              process.exit(1);
            }
          }
        )
        .command(
          "bridge-out <amount>",
          "Bridge tokens from HyperCore to HyperEVM signer wallet (spotSend to asset bridge)",
          (yargs: any) =>
            yargs
              .positional("amount", {
                describe:
                  "Token amount in human-readable form (e.g. '1.0') to send back to HyperEVM",
                type: "string",
                demandOption: true,
              })
              .option("path", options.deploymentPath)
              .option("testnet", {
                describe:
                  "Use HyperLiquid testnet (overrides deployment.json)",
                type: "boolean",
              })
              .example(
                "$0 hype bridge-out 1.0",
                "Send 1.0 tokens from HyperCore to your own address on HyperEVM"
              ),
          async (argv: any) => {
            const deploymentPath = argv["path"] as string;
            const deployments: Config = loadConfig(deploymentPath);
            const isTestnet =
              argv["testnet"] !== undefined
                ? (argv["testnet"] as boolean)
                : deployments.network === "Testnet";

            const hypercore = deployments.hypercore;
            if (hypercore?.tokenIndex === undefined) {
              console.error(
                colors.red(
                  "No 'hypercore.tokenIndex' found in deployment.json. Run 'ntt hype link' first."
                )
              );
              process.exit(1);
              return;
            }

            const privateKey = process.env.ETH_PRIVATE_KEY;
            if (!privateKey) {
              console.error(
                colors.red("ETH_PRIVATE_KEY environment variable is not set.")
              );
              process.exit(1);
              return;
            }

            const signerAddress = getDeployerAddress(privateKey);
            let assetBridge: string;
            let amount: string;
            try {
              assetBridge = computeAssetBridge(hypercore.tokenIndex);
              amount = parsePositiveDecimalAmount(
                "<amount>",
                argv["amount"] as string
              );
            } catch (error) {
              console.error(
                colors.red(
                  `Invalid input: ${error instanceof Error ? error.message : String(error)}`
                )
              );
              process.exit(1);
              return;
            }

            let tokenString: string;
            try {
              tokenString = await getSpotTokenString(
                hypercore.tokenIndex,
                isTestnet
              );
            } catch (err) {
              console.error(
                colors.red(
                  `Failed to look up token string: ${err instanceof Error ? err.message : String(err)}`
                )
              );
              process.exit(1);
              return;
            }

            console.log(
              colors.cyan(
                `Bridging OUT: ${amount} ${tokenString} via asset bridge ${assetBridge} (released on HyperEVM to signer ${signerAddress})`
              )
            );

            try {
              await spotSend(
                privateKey,
                assetBridge,
                tokenString,
                amount,
                isTestnet
              );
              console.log(
                colors.green(
                  `bridge-out complete. ${amount} ${tokenString} released on HyperEVM to ${signerAddress}.`
                )
              );
            } catch (err) {
              console.error(
                colors.red(
                  `bridge-out failed: ${err instanceof Error ? err.message : String(err)}`
                )
              );
              process.exit(1);
            }
          }
        )
        .command(
          "status",
          "Show HyperCore token status for this deployment",
          (yargs: any) =>
            yargs
              .option("path", options.deploymentPath)
              .option("testnet", {
                describe:
                  "Use HyperLiquid testnet (overrides deployment.json)",
                type: "boolean",
              })
              .example(
                "$0 hype status",
                "Print HyperCore token index, asset bridge address, and token string"
              ),
          async (argv: any) => {
            const deploymentPath = argv["path"] as string;
            const deployments: Config = loadConfig(deploymentPath);
            const isTestnet =
              argv["testnet"] !== undefined
                ? (argv["testnet"] as boolean)
                : deployments.network === "Testnet";

            const hypercore = deployments.hypercore;
            if (!hypercore || hypercore.tokenIndex === undefined) {
              console.log(
                colors.yellow(
                  "No 'hypercore.tokenIndex' found in deployment.json. Run 'ntt hype link' to link a HyperCore token."
                )
              );
              return;
            }

            const { tokenIndex, szDecimals, weiDecimals } = hypercore;
            let validatedTokenIndex: number;
            let assetBridge: string;
            try {
              validatedTokenIndex = parseIntegerInRange(
                "deployment.hypercore.tokenIndex",
                tokenIndex,
                0,
                0xffff
              );
              assetBridge = computeAssetBridge(validatedTokenIndex);
            } catch (error) {
              console.error(
                colors.red(
                  `Invalid deployment config: ${error instanceof Error ? error.message : String(error)}`
                )
              );
              process.exit(1);
              return;
            }

            console.log(colors.cyan("HyperCore status:"));
            console.log(`  Token index:  ${validatedTokenIndex}`);
            console.log(`  szDecimals:   ${szDecimals ?? "(not set)"}`);
            console.log(`  weiDecimals:  ${weiDecimals ?? "(not set)"}`);
            console.log(`  Asset bridge: ${assetBridge}`);
            console.log(`  Network:      ${isTestnet ? "Testnet" : "Mainnet"}`);

            const hyperEvmChain = deployments.chains["HyperEVM"];
            if (hyperEvmChain?.token) {
              console.log(`  EVM token:    ${hyperEvmChain.token}`);
            }

            try {
              const tokenString = await getSpotTokenString(
                validatedTokenIndex,
                isTestnet
              );
              console.log(`  Token string: ${tokenString}`);
            } catch {
              console.log(
                colors.yellow(
                  "  Token string: (could not fetch — check network)"
                )
              );
            }
          }
        )
        .demandCommand();
    },
    handler: (_argv: any) => {},
  };
}
