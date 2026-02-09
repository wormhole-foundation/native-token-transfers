import type {
  WormholeConfigOverrides,
  Network,
} from "@wormhole-foundation/sdk-connect";
import {
  Wormhole,
  chainToPlatform,
  toUniversal,
  type Chain,
} from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/platforms/evm";
import solana from "@wormhole-foundation/sdk/platforms/solana";

import {
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import * as spl from "@solana/spl-token";
import type { AddressLookupTableAccount } from "@solana/web3.js";

import { NTT, SolanaNtt } from "@wormhole-foundation/sdk-solana-ntt";
import type { SolanaChains } from "@wormhole-foundation/sdk-solana";

import { colors } from "../colors.js";
import { loadConfig, type Config } from "../deployments";
import { validatePayerOption } from "../validation";
import fs from "fs";

import { options } from "./shared";
import {
  pullChainConfig,
  askForConfirmation,
  checkSvmValidSplMultisig,
} from "../index";

export function createSetMintAuthorityCommand(
  overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "set-mint-authority",
    describe:
      "set token mint authority to token authority (or valid SPL Multisig if --multisig flag is provided)",
    builder: (yargs: any) =>
      yargs
        .option("chain", options.chain)
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
        .option("multisig", {
          describe: "valid SPL Multisig address",
          type: "string",
        })
        .example(
          "$0 set-mint-authority --chain Solana --token Sol1234... --manager Sol3456... --payer <SOLANA_KEYPAIR_PATH>",
          "Set token mint authority to be the token authority address for undeployed program"
        )
        .example(
          "$0 set-mint-authority --chain Fogo --multisig <VALID_SPL_MULTISIG> --payer <SOLANA_KEYPAIR_PATH>",
          "Set token mint authority to be a valid SPL Multisig for deployed program"
        ),
    handler: async (argv: any) => {
      const path = argv["path"];
      const deployments: Config = loadConfig(path);
      const chain: Chain = argv["chain"] as Chain;
      const manager = argv["manager"];
      const token = argv["token"];
      const network = deployments.network as Network;
      const payerPath = validatePayerOption(
        argv["payer"],
        chain,
        (message) => new Error(message),
        (message) => console.warn(colors.yellow(message))
      );

      // Check that the platform is SVM (Solana)
      const platform = chainToPlatform(chain);
      if (platform !== "Solana") {
        console.error(
          `set-mint-authority is only supported for SVM chains. Got platform: ${platform}`
        );
        process.exit(1);
      }

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

      let solanaNtt: SolanaNtt<typeof network, SolanaChains> | undefined;
      let tokenMint: PublicKey;
      let managerKey: PublicKey;
      let major: number;

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
        tokenMint = (await solanaNtt.getConfig()).mint;
        managerKey = new PublicKey(chainConfig.manager);
        major = Number(solanaNtt.version.split(".")[0]);
      }
      // default values as undeployed program
      else {
        solanaNtt = undefined;
        tokenMint = new PublicKey(token!);
        managerKey = new PublicKey(manager!);
        major = -1;
      }

      const wh = new Wormhole(
        network,
        [solana.Platform, evm.Platform],
        overrides
      );
      const ch = wh.getChain(chain);
      const connection: Connection = await ch.getRpc();

      const tokenAuthority = NTT.pdas(managerKey).tokenAuthority();

      // verify current mint authority is not token authority
      const mintInfo = await connection.getAccountInfo(tokenMint);
      if (!mintInfo) {
        console.error(`Mint ${token} not found on ${ch.chain} ${ch.network}`);
        process.exit(1);
      }
      const mint = spl.unpackMint(tokenMint, mintInfo, mintInfo.owner);
      if (!mint.mintAuthority) {
        console.error(
          "Token has fixed supply and no further tokens may be minted"
        );
        process.exit(1);
      }
      if (mint.mintAuthority.equals(tokenAuthority)) {
        console.error(
          "Please use https://github.com/wormhole-foundation/demo-ntt-token-mint-authority-transfer to transfer the token mint authority out of the NTT manager"
        );
        process.exit(1);
      }

      // verify current mint authority is not valid SPL Multisig
      const isMultisigTokenAuthority = await checkSvmValidSplMultisig(
        connection,
        mint.mintAuthority,
        mintInfo.owner,
        tokenAuthority
      );
      if (isMultisigTokenAuthority) {
        console.error(
          "Please use https://github.com/wormhole-foundation/demo-ntt-token-mint-authority-transfer to transfer the token mint authority out of the NTT manager"
        );
        process.exit(1);
      }

      // verify current mint authority is payer
      if (!mint.mintAuthority.equals(payerKeypair.publicKey)) {
        console.error(
          `Current mint authority (${mint.mintAuthority.toBase58()}) does not match payer (${payerKeypair.publicKey.toBase58()}). Retry with current authority`
        );
        process.exit(1);
      }

      const multisigTokenAuthority = argv["multisig"]
        ? new PublicKey(argv["multisig"])
        : undefined;
      // check if SPL-Multisig is supported for manager version
      if (multisigTokenAuthority) {
        // undeployed -- assume version compatible via warning
        if (major === -1) {
          if (!argv["yes"]) {
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
      }

      // verify new authority address is valid
      if (multisigTokenAuthority?.equals(tokenAuthority)) {
        console.error(
          `New authority matches token authority (${multisigTokenAuthority.toBase58()}). To set mint authority as token authority, retry without --multisig`
        );
        process.exit(1);
      }

      // verify manager is paused if already deployed
      if (solanaNtt && !(await solanaNtt.isPaused())) {
        console.error(
          `Not paused. Set \`paused\` for ${chain} to \`true\` in ${path} and run \`ntt push\` to sync the changes on-chain. Then retry this command.`
        );
        process.exit(1);
      }

      // program deployed
      if (solanaNtt) {
        // manager versions < 3.x.x have to call spl setAuthority instruction directly
        if (major < 3) {
          try {
            await spl.setAuthority(
              connection,
              payerKeypair,
              tokenMint,
              payerKeypair.publicKey,
              spl.AuthorityType.MintTokens,
              tokenAuthority,
              [],
              { commitment: "finalized" },
              mintInfo.owner
            );
            console.log(
              `Token mint authority successfully updated to ${tokenAuthority.toBase58()}`
            );
            process.exit(0);
          } catch (error) {
            if (error instanceof Error) {
              console.error(error.message);
            } else if (error instanceof SendTransactionError) {
              console.error(error.logs);
            }
            process.exit(1);
          }
        }

        // use lut if configured
        const luts: AddressLookupTableAccount[] = [];
        try {
          luts.push(await solanaNtt.getAddressLookupTable());
        } catch {}

        // send versioned transaction
        try {
          const latestBlockHash = await connection.getLatestBlockhash();
          const messageV0 = new TransactionMessage({
            payerKey: payerKeypair.publicKey,
            instructions: [
              await NTT.createAcceptTokenAuthorityInstruction(
                solanaNtt.program,
                await solanaNtt.getConfig(),
                {
                  currentAuthority: payerKeypair.publicKey,
                  multisigTokenAuthority,
                }
              ),
            ],
            recentBlockhash: latestBlockHash.blockhash,
          }).compileToV0Message(luts);
          const vtx = new VersionedTransaction(messageV0);
          vtx.sign([payerKeypair]);
          const signature = await connection.sendTransaction(vtx, {});
          await connection.confirmTransaction(
            {
              ...latestBlockHash,
              signature,
            },
            "finalized"
          );
          console.log(
            `Token mint authority successfully updated to ${(
              multisigTokenAuthority ?? tokenAuthority
            ).toBase58()}`
          );
        } catch (error) {
          if (error instanceof Error) {
            console.error(error.message);
          } else if (error instanceof SendTransactionError) {
            console.error(error.logs);
          }
        }
      }
      // undeployed case
      else {
        // verify new authority is valid SPL Multisig
        if (multisigTokenAuthority) {
          // NOTE: the `acceptTokenAuthority` instruction would have done this check normally.
          // However, since the program is not yet deployed, we do this check here.
          const isMultisigTokenAuthority = await checkSvmValidSplMultisig(
            connection,
            multisigTokenAuthority,
            mintInfo.owner,
            tokenAuthority
          );
          if (isMultisigTokenAuthority) {
            console.error(
              "Invalid SPL Multisig provided. Use 'ntt solana create-spl-multisig' to create valid SPL Multisig first"
            );
            process.exit(1);
          }
        }

        // call spl setAuthority instruction directly as program is not yet deployed
        try {
          await spl.setAuthority(
            connection,
            payerKeypair,
            tokenMint,
            payerKeypair.publicKey,
            spl.AuthorityType.MintTokens,
            multisigTokenAuthority ?? tokenAuthority,
            [],
            { commitment: "finalized" },
            mintInfo.owner
          );
          console.log(
            `Token mint authority successfully updated to ${(
              multisigTokenAuthority ?? tokenAuthority
            ).toBase58()}`
          );
          process.exit(0);
        } catch (error) {
          if (error instanceof Error) {
            console.error(error.message);
          } else if (error instanceof SendTransactionError) {
            console.error(error.logs);
          }
          process.exit(1);
        }
      }
    },
  };
}
