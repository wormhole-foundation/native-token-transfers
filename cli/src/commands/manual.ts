import type {
  WormholeConfigOverrides,
  Network,
} from "@wormhole-foundation/sdk-connect";
import {
  chains,
  deserialize,
  encoding,
  isNetwork,
  toUniversal,
  type Chain,
} from "@wormhole-foundation/sdk";

import { colors } from "../colors.js";
import { loadConfig, type Config } from "../deployments";
import { getSigner, type SignerType } from "../signers/getSigner";
import { newSignSendWaiter } from "../signers/signSendWait.js";

import { options } from "./shared";
import { pullChainConfig } from "../index";
import { validatePayerOption } from "../validation";

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
                inboundLimit,
                signer.address.address
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
          "set-transceiver-peer <peer-chain> <peer-address>",
          "Manually set a transceiver peer relationship between NTT deployments",
          (yargs: any) =>
            yargs
              .positional("peer-chain", {
                describe: "Target chain to set as transceiver peer",
                type: "string",
                choices: chains,
                demandOption: true,
              })
              .positional("peer-address", {
                describe:
                  "Universal address of the peer transceiver (hex, 32 bytes)",
                type: "string",
                demandOption: true,
              })
              .option("chain", {
                describe: "Source chain where the transceiver peer will be set",
                type: "string",
                choices: chains,
                demandOption: true,
              })
              .option("transceiver-index", {
                describe: "Index of the transceiver to configure",
                type: "number",
                default: 0,
              })
              .option("path", options.deploymentPath)
              .option("network", options.network)
              .option("signer-type", options.signerType)
              .option("payer", options.payer)
              .example(
                "$0 manual set-transceiver-peer Xrpl 0x00000000000000000000000000000000AABBCCDD --chain Solana --network Testnet",
                "Set Xrpl as transceiver peer for Solana NTT"
              ),
          async (argv: any) => {
            const path = argv["path"];
            const deployments: Config = loadConfig(path);
            const sourceChain: Chain = argv["chain"];
            const peerChain: Chain = argv["peer-chain"];
            const peerAddress = argv["peer-address"];
            const transceiverIndex = argv["transceiver-index"];
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

            const payerPath = validatePayerOption(
              argv["payer"],
              sourceChain,
              (message) => new Error(message),
              (message) => console.warn(colors.yellow(message))
            );

            console.log(colors.blue("🔗 Manual setTransceiverPeer Operation"));
            console.log(`Source Chain: ${colors.yellow(sourceChain)}`);
            console.log(`Peer Chain: ${colors.yellow(peerChain)}`);
            console.log(`Peer Address: ${colors.yellow(peerAddress)}`);
            console.log(
              `Transceiver Index: ${colors.yellow(transceiverIndex)}`
            );

            try {
              // Load source chain NTT configuration
              const sourceManager = {
                chain: sourceChain,
                address: toUniversal(sourceChain, sourceConfig.manager),
              };
              const [, ctx, ntt] = await pullChainConfig(
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
              const signer = await getSigner(
                ctx,
                signerType,
                undefined,
                payerPath
              );

              console.log(
                `Signer Address: ${colors.yellow(
                  signer.address.address.toString()
                )}`
              );
              console.log(
                "\n" +
                  colors.blue("Executing setTransceiverPeer transaction...")
              );

              // Call setTransceiverPeer on the NTT instance
              const setTxs = ntt.setTransceiverPeer(
                transceiverIndex,
                peerChainAddress,
                signer.address.address
              );

              // Create sign-send-wait function (no special owner for manual operations)
              const signSendWaitFunc = newSignSendWaiter(undefined);

              const results = await signSendWaitFunc(
                ctx,
                setTxs,
                signer.signer
              );

              console.log(
                `Transaction Hash: ${colors.green(
                  results[0]?.txid || results[0] || "Transaction completed"
                )}`
              );

              console.log(
                colors.green(
                  "\n✅ setTransceiverPeer operation completed successfully!"
                )
              );
              console.log(
                `Transceiver peer relationship established: ${sourceChain} ↔ ${peerChain}`
              );
            } catch (error) {
              console.error(
                colors.red("\n❌ setTransceiverPeer operation failed:")
              );
              if (error instanceof Error) {
                console.error(error.message);
                console.error(error.stack);
              } else {
                console.error(String(error));
              }
              process.exit(1);
            }
          }
        )
        .command(
          "redeem <vaa>",
          "Redeem an NTT transfer on the destination chain given a VAA",
          (yargs: any) =>
            yargs
              .positional("vaa", {
                describe: "Hex-encoded VAA bytes (with or without 0x prefix)",
                type: "string",
                demandOption: true,
              })
              .option("chain", {
                describe:
                  "Destination chain where the transfer will be redeemed",
                type: "string",
                choices: chains,
                demandOption: true,
              })
              .option("path", options.deploymentPath)
              .option("network", options.network)
              .option("signer-type", options.signerType)
              .option("payer", options.payer)
              .example(
                "$0 manual redeem 01000000... --chain Solana --network Testnet",
                "Redeem an NTT transfer on Solana using hex VAA bytes"
              )
              .example(
                "$0 manual redeem 01000000... --chain Ethereum --network Mainnet",
                "Redeem an NTT transfer on Ethereum using hex VAA bytes"
              ),
          async (argv: any) => {
            const deploymentPath = argv["path"];
            const deployments: Config = loadConfig(deploymentPath);
            const chain: Chain = argv["chain"];
            const network = argv["network"];
            const signerType = argv["signer-type"] as SignerType;

            // Validate network
            if (!isNetwork(network)) {
              console.error("Invalid network");
              process.exit(1);
            }

            // Validate chain exists in deployment
            const chainConfig = deployments.chains[chain];
            if (!chainConfig) {
              console.error(
                `Chain ${chain} not found in deployment configuration`
              );
              process.exit(1);
            }

            const payerPath = validatePayerOption(
              argv["payer"],
              chain,
              (message) => new Error(message),
              (message) => console.warn(colors.yellow(message))
            );

            // Read VAA bytes: either from file or directly from argument
            let vaaHex = argv["vaa"];
            // Strip 0x prefix if present
            if (vaaHex.startsWith("0x") || vaaHex.startsWith("0X")) {
              vaaHex = vaaHex.slice(2);
            }

            let vaaBytes: Uint8Array;
            try {
              vaaBytes = encoding.hex.decode(vaaHex);
            } catch (e) {
              console.error(
                colors.red(
                  "Failed to decode VAA hex. Ensure the VAA is valid hex-encoded bytes."
                )
              );
              process.exit(1);
            }

            // Deserialize the VAA
            let vaa;
            try {
              vaa = deserialize("Ntt:WormholeTransfer", vaaBytes);
            } catch (e) {
              console.error(
                colors.yellow(
                  "Failed to deserialize as Ntt:WormholeTransfer, trying Ntt:WormholeTransferStandardRelayer..."
                )
              );
              try {
                vaa = deserialize(
                  "Ntt:WormholeTransferStandardRelayer",
                  vaaBytes
                );
              } catch (e2) {
                console.error(
                  colors.red(
                    "Failed to deserialize VAA as any known NTT transfer type."
                  )
                );
                if (e2 instanceof Error) console.error(e2.message);
                process.exit(1);
              }
            }

            console.log(colors.blue("📨 Manual Redeem Operation"));
            console.log(`Destination Chain: ${colors.yellow(chain)}`);
            console.log(
              `VAA Emitter Chain: ${colors.yellow(String(vaa!.emitterChain))}`
            );
            console.log(
              `VAA Sequence: ${colors.yellow(String(vaa!.sequence))}`
            );

            try {
              // Load destination chain NTT configuration
              const managerAddress = {
                chain,
                address: toUniversal(chain, chainConfig.manager),
              };
              const [, ctx, ntt] = await pullChainConfig(
                network,
                managerAddress,
                overrides
              );

              console.log(
                `\nNTT Manager: ${colors.yellow(chainConfig.manager)}`
              );

              // Get signer
              const signer = await getSigner(
                ctx,
                signerType,
                undefined,
                payerPath
              );

              console.log(
                `Signer Address: ${colors.yellow(
                  signer.address.address.toString()
                )}`
              );
              console.log(
                "\n" + colors.blue("Executing redeem transaction...")
              );

              // Call redeem on the NTT instance
              const redeemTxs = ntt.redeem([vaa!], signer.address.address);

              const signSendWaitFunc = newSignSendWaiter(undefined);

              const results = await signSendWaitFunc(
                ctx,
                redeemTxs,
                signer.signer
              );

              for (const result of results) {
                console.log(
                  `Transaction Hash: ${colors.green(
                    result?.txid || result || "Transaction completed"
                  )}`
                );
              }

              console.log(
                colors.green("\n✅ Redeem operation completed successfully!")
              );
            } catch (error) {
              console.error(colors.red("\n❌ Redeem operation failed:"));
              if (error instanceof Error) {
                console.error(error.message);
                console.error(error.stack);
              } else {
                console.error(String(error));
              }
              process.exit(1);
            }
          }
        )
        .demandCommand();
    },
    handler: (_argv: any) => {},
  };
}
