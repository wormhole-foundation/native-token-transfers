import type { WormholeConfigOverrides, Network } from "@wormhole-foundation/sdk-connect";
import {
  Wormhole,
  chainToPlatform,
  toUniversal,
  type Chain,
} from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/platforms/evm";

import type { EvmNtt } from "@wormhole-foundation/sdk-evm-ntt";
import type { EvmChains } from "@wormhole-foundation/sdk-evm";

import { ethers } from "ethers";

import { colors } from "../colors.js";
import { loadConfig, type Config } from "../deployments";
import { getSigner } from "../getSigner";

import { options } from "./shared";
import {
  pullChainConfig,
  askForConfirmation,
} from "../index";

export function createTransferOwnershipCommand(overrides: WormholeConfigOverrides<Network>) {
  return {
    command: "transfer-ownership <chain>",
    describe: "transfer NTT manager ownership to a new wallet (EVM chains only)",
    builder: (yargs: any) =>
      yargs
        .positional("chain", options.chain)
        .option("destination", {
          describe: "New owner wallet address",
          type: "string",
          demandOption: true,
        })
        .option("path", options.deploymentPath)
        .option("yes", options.yes)
        .example(
          "$0 transfer-ownership Ethereum --destination 0x1234...",
          "Transfer NTT manager ownership on Ethereum to a new wallet"
        )
        .example(
          "$0 transfer-ownership Bsc --destination 0xabcd... --path ./my-deployment.json",
          "Transfer NTT manager ownership on BSC to a new wallet using custom deployment file"
        ),
    handler: async (argv: any) => {
      const path = argv["path"];
      const deployments: Config = loadConfig(path);
      const chain: Chain = argv["chain"];
      const destination = argv["destination"];
      const network = deployments.network as Network;

      // Check that the platform is EVM
      const platform = chainToPlatform(chain);
      if (platform !== "Evm") {
        console.error(
          `transfer-ownership is only supported for EVM chains. Got platform: ${platform}`
        );
        process.exit(1);
      }

      if (!(chain in deployments.chains)) {
        console.error(`Chain ${chain} not found in deployment configuration`);
        process.exit(1);
      }

      const chainConfig = deployments.chains[chain]!;
      console.log(`Transferring ownership on ${chain} (${network})`);
      console.log(`Manager address: ${chainConfig.manager}`);
      console.log(`New owner: ${destination}`);

      // Validate destination address
      if (!ethers.isAddress(destination)) {
        console.error("Invalid destination address");
        process.exit(1);
      }

      // Get NTT instance
      const [, , ntt] = await pullChainConfig(
        network,
        { chain, address: toUniversal(chain, chainConfig.manager) },
        overrides
      );

      // Get current owner
      const currentOwner = await ntt.getOwner();
      console.log(`Current owner: ${currentOwner}`);

      // Get signer using the same pattern as other commands
      const wh = new Wormhole(network, [evm.Platform], overrides);
      const ch = wh.getChain(chain);
      const signer = await getSigner(ch, "privateKey");

      // Verify the wallet is the current owner
      if (
        currentOwner.toString().toLowerCase() !==
        signer.address.address.toString().toLowerCase()
      ) {
        console.error(
          `❌ Wallet ${signer.address.address} is not the current owner. Current owner is ${currentOwner}`
        );
        process.exit(1);
      }

      if (!argv["yes"]) {
        console.log("\n⚠️  ⚠️  ⚠️  CRITICAL WARNING ⚠️  ⚠️  ⚠️");
        console.log("This ownership transfer is IRREVERSIBLE!");
        console.log(
          "Please TRIPLE-CHECK that the destination address is correct:"
        );
        console.log(`   ${destination}`);
        console.log("");
        await askForConfirmation(
          `Are you absolutely certain you want to transfer ownership to ${destination}?`
        );
      }

      try {
        // Cast to EVM NTT and call transferOwnership
        const evmNtt = ntt as EvmNtt<typeof network, EvmChains>;

        // Get the native ethers signer from the EvmNativeSigner
        const nativeSigner = (signer.signer as any)._signer;
        if (!nativeSigner || !nativeSigner.provider) {
          throw new Error("Failed to get native ethers signer");
        }

        const contract = evmNtt.manager.connect(nativeSigner);
        const tx = await contract.transferOwnership(destination);
        console.log(`Transaction hash: ${tx.hash}`);
        console.log(`Waiting for 1 confirmation...`);

        // 1 confirmation, 5 minute timeout
        await tx.wait(1, 300000);

        console.log(`Verifying ownership transfer...`);
        const newOwnerFromContract = await evmNtt.manager.owner();
        if (newOwnerFromContract.toLowerCase() === destination.toLowerCase()) {
          console.log(
            `✅ Ownership transferred successfully to ${destination}`
          );
        } else {
          console.error(`❌ Ownership transfer verification failed`);
          console.error(`   New owner:        ${newOwnerFromContract}`);
          process.exit(1);
        }
      } catch (error: any) {
        console.error("❌ Failed to transfer ownership:", error.message);
        if (error.transaction) {
          console.error("Transaction details:", error.transaction);
        }
        process.exit(1);
      }
    },
  };
}
