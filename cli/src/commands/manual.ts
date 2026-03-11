import type {
  WormholeConfigOverrides,
  Network,
} from "@wormhole-foundation/sdk-connect";
import {
  chains,
  chainToPlatform,
  isNetwork,
  toUniversal,
  type Chain,
  type UnsignedTransaction,
} from "@wormhole-foundation/sdk";
import * as solanaWeb3 from "@solana/web3.js";
import {
  SolanaAddress,
  type SolanaChains,
} from "@wormhole-foundation/sdk-solana";
import { NTT, SolanaNtt } from "@wormhole-foundation/sdk-solana-ntt";

import { colors } from "../colors.js";
import { loadConfig, type Config } from "../deployments";
import { getSigner, type SignerType } from "../signers/getSigner";
import { newSignSendWaiter } from "../signers/signSendWait.js";

import { options } from "./shared";
import { pullChainConfig } from "../index";

export function createManualCommand(
  overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "manual",
    describe: "Manual NTT operations",
    builder: (yargs: any) => {
      return yargs
        .command(
          "set-peer <peer-chain> <peer-address>",
          "Manually set a peer relationship between NTT deployments",
          (yargs: any) =>
            yargs
              .positional("peer-chain", {
                describe: "Target chain to set as peer",
                type: "string",
                choices: chains,
                demandOption: true,
              })
              .positional("peer-address", {
                describe: "Universal address of the peer NTT manager",
                type: "string",
                demandOption: true,
              })
              .option("chain", {
                describe: "Source chain where the peer will be set",
                type: "string",
                choices: chains,
                demandOption: true,
              })
              .option("token-decimals", {
                describe: "Token decimals for the peer chain",
                type: "number",
                demandOption: true,
              })
              .option("inbound-limit", {
                describe: "Inbound rate limit for transfers from this peer",
                type: "string",
                demandOption: true,
              })
              .option("path", options.deploymentPath)
              .option("network", options.network)
              .option("signer-type", options.signerType)
              .example(
                "$0 manual set-peer Ethereum 0x742d35Cc6634C0532925a3b8D0C85e3c4e5cBB8D --chain Sui --token-decimals 18 --inbound-limit 1000000000000000000",
                "Set Ethereum as peer for Sui NTT"
              ),
          async (argv: any) => {
            const path = argv["path"];
            const deployments: Config = loadConfig(path);
            const sourceChain: Chain = argv["chain"];
            const peerChain: Chain = argv["peer-chain"];
            const peerAddress = argv["peer-address"];
            const tokenDecimals = argv["token-decimals"];
            const inboundLimit = BigInt(argv["inbound-limit"]);
            const network = argv["network"];
            const signerType = argv["signer-type"] as SignerType;

            // Validate network
            if (!isNetwork(network)) {
              console.error("Invalid network");
              process.exit(1);
            }

            // Validate source chain exists in deployment
            const sourceConfig = deployments.chains[sourceChain];
            if (!sourceConfig) {
              console.error(
                `Source chain ${sourceChain} not found in deployment configuration`
              );
              process.exit(1);
            }

            console.log(colors.blue("🔗 Manual setPeer Operation"));
            console.log(`Source Chain: ${colors.yellow(sourceChain)}`);
            console.log(`Peer Chain: ${colors.yellow(peerChain)}`);
            console.log(`Peer Address: ${colors.yellow(peerAddress)}`);
            console.log(`Token Decimals: ${colors.yellow(tokenDecimals)}`);
            console.log(
              `Inbound Limit: ${colors.yellow(inboundLimit.toString())}`
            );

            try {
              // Load source chain NTT configuration
              const sourceManager = {
                chain: sourceChain,
                address: toUniversal(sourceChain, sourceConfig.manager),
              };
              const [config, ctx, ntt] = await pullChainConfig(
                network,
                sourceManager,
                overrides
              );

              console.log(
                `\nSource NTT Manager: ${colors.yellow(sourceConfig.manager)}`
              );

              // Create peer address object
              const peerChainAddress = {
                chain: peerChain,
                address: toUniversal(peerChain, peerAddress),
              };

              // Get signer for the source chain
              const signer = await getSigner(ctx, signerType);

              console.log(
                `Signer Address: ${colors.yellow(
                  signer.address.address.toString()
                )}`
              );
              console.log(
                "\n" + colors.blue("Executing setPeer transaction...")
              );

              // Call setPeer on the NTT instance (it returns an AsyncGenerator)
              const setPeerTxs = ntt.setPeer(
                peerChainAddress,
                tokenDecimals,
                inboundLimit
              );

              // Create sign-send-wait function (no special owner for manual operations)
              const signSendWaitFunc = newSignSendWaiter(undefined);

              // Execute the transaction(s)

              try {
                const results = await signSendWaitFunc(
                  ctx,
                  setPeerTxs,
                  signer.signer
                );

                // Display transaction results
                console.log(
                  `Transaction Hash: ${colors.green(
                    results[0]?.txid || results[0] || "Transaction completed"
                  )}`
                );
              } catch (signSendError) {
                console.error("DEBUG: Error occurred in signSendWaitFunc:");
                console.error(
                  "DEBUG: signSendError type:",
                  typeof signSendError
                );
                console.error(
                  "DEBUG: signSendError constructor:",
                  signSendError?.constructor?.name
                );
                console.error(
                  "DEBUG: signSendError message:",
                  signSendError instanceof Error
                    ? signSendError.message
                    : String(signSendError)
                );

                if (signSendError instanceof Error) {
                  console.error("DEBUG: signSendError stack:");
                  console.error(signSendError.stack);
                }

                // Try to extract specific information about bytes.length error
                const errorString = String(signSendError);
                if (errorString.includes("bytes.length")) {
                  console.error("DEBUG: *** FOUND bytes.length ERROR! ***");
                  console.error("DEBUG: Full error string:", errorString);
                }

                throw signSendError;
              }

              console.log(
                colors.green("\n✅ setPeer operation completed successfully!")
              );
              console.log(
                `Peer relationship established: ${sourceChain} ↔ ${peerChain}`
              );
            } catch (error) {
              console.error(colors.red("\n❌ setPeer operation failed:"));
              console.error(
                "ERROR: Main error message:",
                error instanceof Error ? error.message : String(error)
              );

              // Enhanced error logging for debugging
              if (error instanceof Error) {
                console.error("ERROR: Error name:", error.name);
                console.error("ERROR: Error stack trace:");
                console.error(error.stack || "No stack trace available");

                // Check for nested errors or cause
                if ("cause" in error && error.cause) {
                  console.error("ERROR: Caused by:", error.cause);
                }
              }

              // Log the error type and constructor
              console.error("ERROR: Error type:", typeof error);
              console.error(
                "ERROR: Error constructor:",
                error?.constructor?.name
              );

              // If it's a string or has toString, log that too
              if (typeof error === "object" && error !== null) {
                try {
                  console.error(
                    "ERROR: Error as JSON:",
                    JSON.stringify(error, null, 2)
                  );
                } catch (jsonError) {
                  console.error(
                    "ERROR: Could not stringify error object:",
                    jsonError
                  );
                }
              }

              process.exit(1);
            }
          }
        )
        .command(
          "claim-ownership",
          "Claim ownership of a Solana NTT program after a 2-step ownership transfer",
          (yargs: any) =>
            yargs
              .option("chain", {
                describe: "Solana chain where ownership will be claimed",
                type: "string",
                choices: chains,
                demandOption: true,
              })
              .option("path", options.deploymentPath)
              .option("network", options.network)
              .option("signer-type", options.signerType)
              .example(
                "$0 manual claim-ownership --chain Solana --network Mainnet",
                "Claim ownership of the Solana NTT program"
              ),
          async (argv: any) => {
            const path = argv["path"];
            const deployments: Config = loadConfig(path);
            const chain: Chain = argv["chain"];
            const network = argv["network"];
            const signerType = argv["signer-type"] as SignerType;

            if (!isNetwork(network)) {
              console.error("Invalid network");
              process.exit(1);
            }

            if (chainToPlatform(chain) !== "Solana") {
              console.error(
                `claim-ownership is only supported on Solana chains, got ${chain}`
              );
              process.exit(1);
            }

            const chainConfig = deployments.chains[chain];
            if (!chainConfig) {
              console.error(
                `Chain ${chain} not found in deployment configuration`
              );
              process.exit(1);
            }

            console.log(colors.blue("🔑 Manual claimOwnership Operation"));
            console.log(`Chain: ${colors.yellow(chain)}`);

            try {
              const manager = {
                chain,
                address: toUniversal(chain, chainConfig.manager),
              };
              const [, ctx, ntt] = await pullChainConfig(
                network,
                manager,
                overrides
              );

              const solanaNtt = ntt as SolanaNtt<
                typeof ctx.config.network,
                SolanaChains
              >;

              const signer = await getSigner(ctx, signerType);
              const newOwner = new SolanaAddress(
                signer.address.address
              ).unwrap();

              console.log(
                `Signer/New Owner: ${colors.yellow(newOwner.toBase58())}`
              );
              console.log(
                "\n" +
                  colors.blue("Executing claimOwnership transaction...")
              );

              const ix = await NTT.createClaimOwnershipInstruction(
                solanaNtt.program,
                { newOwner }
              );

              const tx = new solanaWeb3.Transaction();
              tx.add(ix);
              tx.feePayer = newOwner;

              const txs = (async function* () {
                yield solanaNtt.createUnsignedTx(
                  { transaction: tx },
                  "Claim ownership"
                ) as UnsignedTransaction<any, any>;
              })();

              const signSendWaitFunc = newSignSendWaiter(undefined);
              const results = await signSendWaitFunc(
                ctx,
                txs,
                signer.signer
              );

              console.log(
                `Transaction Hash: ${colors.green(
                  results[0]?.txid || results[0] || "Transaction completed"
                )}`
              );
              console.log(
                colors.green(
                  "\n✅ claimOwnership operation completed successfully!"
                )
              );
            } catch (error) {
              console.error(
                colors.red("\n❌ claimOwnership operation failed:")
              );
              console.error(
                error instanceof Error ? error.message : String(error)
              );
              process.exit(1);
            }
          }
        )
        .demandCommand();
    },
    handler: (_argv: any) => {},
  };
}
