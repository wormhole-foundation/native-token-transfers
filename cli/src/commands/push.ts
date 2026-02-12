import {
  assertChain,
  chainToPlatform,
  signSendWait,
  type Chain,
  type ChainContext,
  type Network,
} from "@wormhole-foundation/sdk";
import type { WormholeConfigOverrides } from "@wormhole-foundation/sdk-connect";
import {
  type SolanaChains,
  SolanaAddress,
} from "@wormhole-foundation/sdk-solana";
import type { SolanaNtt } from "@wormhole-foundation/sdk-solana-ntt";
import type { Argv } from "yargs";
import { ethers, Interface } from "ethers";
import { colors } from "../colors.js";
import { loadConfig, type Config } from "../deployments";
import { getSigner, type SignerType } from "../signers/getSigner";
import { newSignSendWaiter } from "../signers/signSendWait.js";
import { registerSolanaTransceiver } from "../solana/transceiver";
import { collectMissingConfigs, validatePayerOption } from "../validation";
import type { Deployment } from "../validation";
import { options } from "./shared";
import { pullDeployments, checkConfigErrors, pushDeployment } from "../index";

export function createPushCommand(overrides: WormholeConfigOverrides<Network>) {
  return {
    command: "push",
    describe: "push the local configuration",
    builder: (yargs: Argv) =>
      yargs
        .option("path", options.deploymentPath)
        .option("yes", options.yes)
        .option("signer-type", options.signerType)
        .option("verbose", options.verbose)
        .option("skip-verify", options.skipVerify)
        .option("payer", options.payer)
        .option("skip-chain", options.skipChain)
        .option("only-chain", options.onlyChain)
        .option("gas-estimate-multiplier", options.gasEstimateMultiplier)
        .option("dangerously-transfer-ownership-in-one-step", {
          describe:
            "Use 1-step ownership transfer for Solana (DANGEROUS - skips claim step)",
          type: "boolean" as const,
          default: false,
        })
        .example(
          "$0 push",
          "Push local configuration changes to the blockchain"
        )
        .example(
          "$0 push --signer-type ledger",
          "Push changes using a Ledger hardware wallet for signing"
        )
        .example(
          "$0 push --skip-verify",
          "Push changes without verifying contracts on EVM chains"
        )
        .example(
          "$0 push --payer <SOLANA_KEYPAIR_PATH>",
          "Path to the payer json file (SVM), instead of setting SOLANA_PRIVATE_KEY env variable"
        ),
    handler: async (argv: any) => {
      const deployments: Config = loadConfig(argv["path"]);
      const verbose = argv["verbose"];
      const network = deployments.network as Network;
      const deps: Partial<{ [C in Chain]: Deployment<Chain> }> =
        await pullDeployments(deployments, network, verbose, overrides);
      const signerType = argv["signer-type"] as SignerType;
      const depsChains = Object.keys(deps) as Chain[];
      const needsSolanaPayer = depsChains.some(
        (c) => chainToPlatform(c) === "Solana"
      );
      const payerValidationChain = (
        needsSolanaPayer ? "Solana" : depsChains[0]
      ) as Chain | undefined;
      const payerPath = validatePayerOption(
        argv["payer"],
        payerValidationChain ?? ("Solana" as Chain),
        (message) => new Error(message),
        (message) => console.warn(colors.yellow(message))
      );
      const gasEstimateMultiplier = argv["gas-estimate-multiplier"];
      const skipChains = (argv["skip-chain"] as string[]) || [];
      const onlyChains = (argv["only-chain"] as string[]) || [];
      const shouldSkipChain = (chain: string) => {
        if (onlyChains.length > 0) {
          if (!onlyChains.includes(chain)) {
            return true;
          }
        }
        if (skipChains.includes(chain)) {
          return true;
        }
        return false;
      };
      const missing = await collectMissingConfigs(deps, verbose);

      if (checkConfigErrors(deps)) {
        console.error(
          "There are errors in the config file. Please fix these before continuing."
        );
        process.exit(1);
      }

      const nttOwnerForChain: Record<string, string | undefined> = {};

      for (const [chain, _] of Object.entries(deps)) {
        if (shouldSkipChain(chain)) {
          console.log(`skipping registration for chain ${chain}`);
          continue;
        }
        assertChain(chain);
        if (chainToPlatform(chain) === "Evm") {
          const ntt = deps[chain]!.ntt;
          const ctx = deps[chain]!.ctx;
          const signer = await getSigner(ctx, signerType, undefined, payerPath);
          const rpc = ctx.config.rpc;
          const provider = new ethers.JsonRpcProvider(rpc);
          // get the owner of the ntt manager
          const contractOwner = await ntt.getOwner();
          // check if the owner has data to see if it is a smart contract
          if (
            !signer.address.address.equals(contractOwner.toUniversalAddress())
          ) {
            const contractCode = await provider.getCode(
              contractOwner.address.toString()
            );
            if (contractCode.length <= 2) {
              console.error(
                `cannot update ${chain} because the configured private key does not correspond to owner ${contractOwner.address}`
              );
              continue;
            } else {
              const eip165Interface = new Interface([
                "function supportsInterface(bytes4 interfaceId) external view returns (bool)",
              ] as const);
              const callData = eip165Interface.encodeFunctionData(
                "supportsInterface",
                ["0x43412b75"]
              );
              try {
                const supports = await provider.call({
                  to: contractOwner.toString(),
                  data: callData,
                });
                const supportsInt = parseInt(supports);
                if (supportsInt !== 1) {
                  console.error(
                    `cannot update ${chain} because the owning contract does not implement INttOwner`
                  );
                  process.exit(1);
                }
                nttOwnerForChain[chain] = contractOwner.toString();
              } catch (error: any) {
                // This catch is primarily for reverts
                console.error(
                  colors.red(
                    `Cannot update ${chain}: You do not own the NTT manager contract. Owner is ${contractOwner.address}.`
                  )
                );
                process.exit(1);
              }
            }
          }
        }
      }
      for (const [chain, missingConfig] of Object.entries(missing)) {
        if (shouldSkipChain(chain)) {
          console.log(`skipping registration for chain ${chain}`);
          continue;
        }
        assertChain(chain);
        const ntt = deps[chain]!.ntt;
        const ctx = deps[chain]!.ctx;
        const signer = await getSigner(ctx, signerType, undefined, payerPath);
        const signSendWaitFunc = newSignSendWaiter(nttOwnerForChain[chain]);
        for (const manager of missingConfig.managerPeers) {
          const tx = ntt.setPeer(
            manager.address,
            manager.tokenDecimals,
            manager.inboundLimit,
            signer.address.address
          );
          await signSendWaitFunc(ctx, tx, signer.signer);
        }
        for (const transceiver of missingConfig.transceiverPeers) {
          const tx = ntt.setTransceiverPeer(
            0,
            transceiver,
            signer.address.address
          );
          await signSendWaitFunc(ctx, tx, signer.signer);
        }
        if (missingConfig.solanaWormholeTransceiver) {
          if (chainToPlatform(chain) !== "Solana") {
            console.error(
              "Solana wormhole transceiver can only be set on Solana chains"
            );
            continue;
          }
          const solanaNtt = ntt as SolanaNtt<Network, SolanaChains>;
          const solanaCtx = ctx as ChainContext<Network, SolanaChains>;
          try {
            await registerSolanaTransceiver(solanaNtt, solanaCtx, signer);
          } catch (e: any) {
            console.error(e.logs);
          }
        }
        if (missingConfig.solanaUpdateLUT) {
          if (chainToPlatform(chain) !== "Solana") {
            console.error("Solana update LUT can only be set on Solana chains");
            continue;
          }
          const solanaNtt = ntt as SolanaNtt<Network, SolanaChains>;
          const payer = new SolanaAddress(signer.address.address).unwrap();
          const tx = solanaNtt.initializeOrUpdateLUT({ payer, owner: payer });
          try {
            await signSendWait(ctx, tx, signer.signer);
          } catch (e: any) {
            console.error(e.logs);
          }
        }
      }

      // pull deps again
      const depsAfterRegistrations: Partial<{
        [C in Chain]: Deployment<Chain>;
      }> = await pullDeployments(deployments, network, verbose, overrides);

      for (const [chain, deployment] of Object.entries(
        depsAfterRegistrations
      )) {
        if (shouldSkipChain(chain)) {
          console.log(`skipping deployment for chain ${chain}`);
          continue;
        }
        assertChain(chain);
        const signSendWaitFunc = newSignSendWaiter(nttOwnerForChain[chain]);
        await pushDeployment(
          deployment as any,
          signSendWaitFunc,
          signerType,
          !argv["skip-verify"],
          argv["yes"],
          payerPath,
          gasEstimateMultiplier,
          argv["dangerously-transfer-ownership-in-one-step"],
          overrides
        );
      }
    },
  };
}
