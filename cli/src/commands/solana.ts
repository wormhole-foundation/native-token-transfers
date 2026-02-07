import type { WormholeConfigOverrides, Network } from "@wormhole-foundation/sdk-connect";
import { encoding } from "@wormhole-foundation/sdk-connect";
import {
  Wormhole,
  chainToPlatform,
  toUniversal,
  type Chain,
} from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/platforms/evm";
import solana from "@wormhole-foundation/sdk/platforms/solana";
import sui from "@wormhole-foundation/sdk/platforms/sui";

import {
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
} from "@solana/web3.js";
import * as spl from "@solana/spl-token";

import { NTT, SolanaNtt } from "@wormhole-foundation/sdk-solana-ntt";
import type { SolanaChains } from "@wormhole-foundation/sdk-solana";

import { colors } from "../colors.js";
import { loadConfig, type Config } from "../deployments";
import { validatePayerOption } from "../validation";
import fs from "fs";

import { options } from "./shared";
import {
  pullChainConfig,
  resolveVersion,
  validateChain,
  askForConfirmation,
  buildSvm,
  createWorkTree,
} from "../index";

export function createSolanaCommand(overrides: WormholeConfigOverrides<Network>) {
  return {
    command: ["solana", "svm"] as const,
    describe: "svm commands",
    builder: (yargs: any) => {
      return yargs
        .command(
          "key-base58 <keypair>",
          "print private key in base58",
          (yargs: any) =>
            yargs.positional("keypair", {
              describe: "Path to keypair.json",
              type: "string",
              demandOption: true,
            }),
          (argv: any) => {
            const keypair = Keypair.fromSecretKey(
              new Uint8Array(
                JSON.parse(fs.readFileSync(argv["keypair"]).toString())
              )
            );
            console.log(encoding.b58.encode(keypair.secretKey));
          }
        )
        .command(
          "token-authority <programId>",
          "print the token authority address for a given program ID",
          (yargs: any) =>
            yargs.positional("programId", {
              describe: "Program ID",
              type: "string",
              demandOption: true,
            }),
          (argv: any) => {
            const programId = new PublicKey(argv["programId"]);
            const tokenAuthority = NTT.pdas(programId).tokenAuthority();
            console.log(tokenAuthority.toBase58());
          }
        )
        .command(
          "ata <mint> <owner> <tokenProgram>",
          "print the associated token account address for a given mint and owner",
          (yargs: any) =>
            yargs
              .positional("mint", {
                describe: "Mint address",
                type: "string",
                demandOption: true,
              })
              .positional("owner", {
                describe: "Owner address",
                type: "string",
                demandOption: true,
              })
              .positional("tokenProgram", {
                describe: "Token program ID",
                type: "string",
                choices: ["legacy", "token22"],
                demandOption: true,
              }),
          (argv: any) => {
            const mint = new PublicKey(argv["mint"]);
            const owner = new PublicKey(argv["owner"]);
            const tokenProgram =
              argv["tokenProgram"] === "legacy"
                ? spl.TOKEN_PROGRAM_ID
                : spl.TOKEN_2022_PROGRAM_ID;
            const ata = spl.getAssociatedTokenAddressSync(
              mint,
              owner,
              true,
              tokenProgram
            );
            console.log(ata.toBase58());
          }
        )
        .command(
          "create-spl-multisig <multisigMemberPubkey...>",
          "create a valid SPL Multisig (see https://github.com/wormhole-foundation/native-token-transfers/tree/main/solana#spl-multisig-support for more info)",
          (yargs: any) =>
            yargs
              .positional("multisigMemberPubkey", {
                describe:
                  "public keys of the members that can independently mint",
                type: "string",
                demandOption: true,
              })
              .option("manager", {
                describe: "Manager address",
                type: "string",
              })
              .option("token", {
                describe: "Token address",
                type: "string",
              })
              .option("path", options.deploymentPath)
              .option("yes", options.yes)
              .option("payer", { ...options.payer, demandOption: true })
              .example(
                "$0 svm create-spl-multisig Sol1234... --token Sol3456... --manager Sol5678... --payer <SOLANA_KEYPAIR_PATH>",
                "Create multisig with Sol1234... having independent mint privilege alongside NTT token-authority for undeployed program"
              )
              .example(
                "$0 svm create-spl-multisig Sol1234... Sol3456... Sol5678... --payer <SOLANA_KEYPAIR_PATH>",
                "Create multisig with Sol1234..., Sol3456..., and Sol5678... having mint privileges alongside NTT token-authority for deployed program"
              ),
          async (argv: any) => {
            const path = argv["path"];
            const deployments: Config = loadConfig(path);
            const chain: Chain = "Solana";
            const manager = argv["manager"];
            const token = argv["token"];
            const network = deployments.network as Network;
            const payerPath = validatePayerOption(
              argv["payer"],
              chain,
              (message) => new Error(message),
              (message) => console.warn(colors.yellow(message))
            );

            if (!payerPath) {
              console.error("Payer not found. Specify with --payer");
              process.exit(1);
            }
            const payerKeypair = Keypair.fromSecretKey(
              new Uint8Array(JSON.parse(fs.readFileSync(payerPath).toString()))
            );

            if (!token !== !manager) {
              console.error(
                "Please provide both --token and --manager for an undeployed program"
              );
              process.exit(1);
            }

            const wh = new Wormhole(
              network,
              [solana.Platform, evm.Platform],
              overrides
            );
            const ch = wh.getChain(chain);
            const connection: Connection = await ch.getRpc();

            let solanaNtt: SolanaNtt<typeof network, SolanaChains> | undefined;
            let managerKey: PublicKey;
            let major: number;
            let tokenProgram: PublicKey;

            // program deployed so fetch token and manager addresses from deployment
            if (!token && !manager) {
              if (!(chain in deployments.chains)) {
                console.error(
                  `Either provide --token and --manager flags, or ensure ${path} contains a valid ${chain} configuration`
                );
                process.exit(1);
              }
              const chainConfig = deployments.chains[chain]!;
              const [, , ntt] = await pullChainConfig(
                network,
                { chain, address: toUniversal(chain, chainConfig.manager) },
                overrides
              );
              solanaNtt = ntt as SolanaNtt<typeof network, SolanaChains>;
              managerKey = new PublicKey(chainConfig.manager);
              major = Number(solanaNtt.version.split(".")[0]);
              tokenProgram = (await solanaNtt.getConfig()).tokenProgram;
            }
            // default values as undeployed program
            else {
              // ensure mint is valid
              const tokenMint = new PublicKey(token!);
              const mintInfo = await connection.getAccountInfo(tokenMint);
              if (!mintInfo) {
                console.error(
                  `Mint ${token} not found on ${ch.chain} ${ch.network}`
                );
                process.exit(1);
              }
              spl.unpackMint(tokenMint, mintInfo, mintInfo.owner);

              solanaNtt = undefined;
              managerKey = new PublicKey(manager!);
              major = -1;
              tokenProgram = mintInfo.owner;
            }

            const tokenAuthority = NTT.pdas(managerKey).tokenAuthority();

            // check if SPL-Multisig is supported for manager version
            // undeployed -- assume version compatible via warning
            if (major === -1 && !argv["yes"]) {
              console.warn(
                colors.yellow(
                  "SPL Multisig token mint authority is only supported for versions >= 3.x.x"
                )
              );
              console.warn(
                colors.yellow(
                  "Ensure the program version you wish to deploy supports SPL Multisig token mint authority"
                )
              );
              await askForConfirmation();
            }
            // unsupported version
            else if (major < 3) {
              console.error(
                "SPL Multisig token mint authority is only supported for versions >= 3.x.x"
              );
              console.error(
                "Use 'ntt upgrade' to upgrade the NTT contract to a specific version."
              );
              process.exit(1);
            }

            try {
              // use same tokenProgram as token to create multisig
              const additionalMemberPubkeys = (
                argv["multisigMemberPubkey"] as any
              ).map((key: string) => new PublicKey(key));
              const multisig = await spl.createMultisig(
                connection,
                payerKeypair,
                [tokenAuthority, ...additionalMemberPubkeys],
                1,
                undefined,
                { commitment: "finalized" },
                tokenProgram
              );
              console.log(`Valid SPL Multisig created: ${multisig.toBase58()}`);
            } catch (error) {
              if (error instanceof Error) {
                console.error(error.message);
              } else if (error instanceof SendTransactionError) {
                console.error(error.logs);
              }
            }
          }
        )
        .command(
          "build <chain>",
          "build the SVM program binary without deploying",
          (yargs: any) =>
            yargs
              .positional("chain", options.chain)
              .option("program-key", {
                describe: "Path to program key json",
                type: "string",
              })
              .option("binary", {
                describe:
                  "Path to existing program binary (.so file) - if provided, only validates the binary",
                type: "string",
              })
              .option("ver", options.version)
              .option("latest", options.latest)
              .option("local", options.local)
              .option("path", options.deploymentPath)
              .example(
                "$0 svm build Solana --latest",
                "Build the SVM program binary using the latest version"
              )
              .example(
                "$0 svm build Solana --ver 1.0.0",
                "Build using a specific version"
              )
              .example(
                "$0 svm build Solana --local --program-key my-program-keypair.json",
                "Build from local source with a specific program keypair"
              )
              .example(
                "$0 svm build Solana --latest --binary target/deploy/example_native_token_transfers.so",
                "Validate an existing binary against the latest version"
              ),
          async (argv: any) => {
            const path = argv["path"];
            const deployments: Config = loadConfig(path);
            const chain: Chain = argv["chain"];
            const network = deployments.network as Network;

            // Check that the platform is Solana
            const platform = chainToPlatform(chain);
            if (platform !== "Solana") {
              console.error(
                `build command is only supported for Solana chains. Got platform: ${platform}`
              );
              process.exit(1);
            }

            validateChain(network, chain);

            // Resolve version (--latest, --ver, or --local)
            const version = resolveVersion(
              argv["latest"],
              argv["ver"],
              argv["local"],
              platform
            );

            // Create worktree if version is specified, otherwise use current directory
            const worktree = version ? createWorkTree(platform, version) : ".";

            // Get wormhole core bridge address for verification
            const wh = new Wormhole(
              network,
              [solana.Platform, evm.Platform, sui.Platform],
              overrides
            );
            const ch = wh.getChain(chain);
            const wormhole = ch.config.contracts.coreBridge;
            if (!wormhole) {
              console.error("Core bridge not found");
              process.exit(1);
            }

            const programKeyPath = argv["program-key"];
            const binaryPath = argv["binary"];

            console.log(`Building SVM program for ${chain} on ${network}...`);
            if (version) {
              console.log(colors.blue(`Using version: ${version}`));
              console.log(colors.blue(`Worktree: ${worktree}`));
            } else {
              console.log(colors.blue(`Using local source`));
            }

            const buildResult = await buildSvm(
              worktree,
              network,
              chain,
              wormhole,
              version,
              programKeyPath,
              binaryPath
            );

            console.log(`Program ID: ${buildResult.programId}`);
            console.log(`Binary: ${buildResult.binary}`);
            console.log(`Keypair: ${buildResult.programKeypairPath}`);
          }
        )
        .demandCommand();
    },
    handler: (_argv: any) => {},
  };
}
