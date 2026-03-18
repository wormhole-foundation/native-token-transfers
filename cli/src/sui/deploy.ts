import { execSync } from "child_process";
import {
  signSendWait,
  toUniversal,
  type Chain,
  type ChainContext,
  type Network,
} from "@wormhole-foundation/sdk";
import type { Ntt } from "@wormhole-foundation/sdk-definitions-ntt";
import type { SuiChains } from "@wormhole-foundation/sdk-sui";
import type { SuiNtt } from "@wormhole-foundation/sdk-sui-ntt";
import { Transaction } from "@mysten/sui/transactions";

import { colors } from "../colors.js";
import { getSigner, type SignerType } from "../signers/getSigner";
import { handleDeploymentError } from "../error";
import { ensureNttRoot } from "../validation";
import type { SuiDeploymentResult } from "../commands/shared";
import {
  withSuiEnv,
  updateMoveTomlForNetwork,
  performPackageUpgradeInPTB,
} from "./helpers";

export async function upgradeSui<N extends Network, C extends SuiChains>(
  pwd: string,
  version: string | null,
  ntt: SuiNtt<N, C>,
  ctx: ChainContext<N, C>,
  signerType: SignerType
): Promise<void> {
  ensureNttRoot(pwd);

  console.log("Upgrading Sui chain", ctx.chain);

  // Setup Sui environment and execute upgrade
  await withSuiEnv(pwd, ctx, async () => {
    // Build the updated packages
    console.log("Building updated packages...");
    const packagesToBuild = ["ntt_common", "ntt", "wormhole_transceiver"];

    for (const packageName of packagesToBuild) {
      const packagePath = `${pwd}/sui/packages/${packageName}`;
      console.log(`Building package: ${packageName}`);

      try {
        execSync(`sui move build`, {
          cwd: packagePath,
          stdio: "inherit",
          env: process.env,
        });
      } catch (error) {
        console.error(`Failed to build package ${packageName}:`, error);
        throw error;
      }
    }

    // Get the current NTT manager address and retrieve upgrade capabilities
    const managerAddress = ntt.contracts.ntt?.manager;
    if (!managerAddress) {
      throw new Error("NTT manager address not found");
    }

    console.log("Retrieving upgrade capabilities...");

    // Get the upgrade cap ID from the NTT state
    let upgradeCapId: string;
    try {
      upgradeCapId = await ntt.getUpgradeCapId();
      console.log(`Found upgrade cap ID: ${upgradeCapId}`);
    } catch (error) {
      console.error("Failed to retrieve upgrade cap ID:", error);
      throw error;
    }

    // Only upgrade the NTT package (other packages don't have upgrade logic)
    const packagesToUpgrade = [{ name: "Ntt", path: "sui/packages/ntt" }];

    console.log("Upgrading packages using pure JavaScript...");

    // Get signer for transactions
    const signer = await getSigner(ctx, signerType);

    for (const pkg of packagesToUpgrade) {
      console.log(`Upgrading package: ${pkg.name}`);

      try {
        // Build the package first
        const packagePath = `${pwd}/${pkg.path}`;
        console.log(`Building package at: ${packagePath}`);

        execSync(`sui move build`, {
          cwd: packagePath,
          stdio: "pipe",
          env: process.env,
        });

        // Perform all upgrade steps in a single PTB
        console.log(`Performing upgrade for ${pkg.name}...`);
        const upgradeTxs = (async function* () {
          const upgradeTx = await performPackageUpgradeInPTB(
            ctx,
            packagePath,
            upgradeCapId,
            ntt
          );
          yield upgradeTx;
        })();
        await signSendWait(ctx, upgradeTxs, signer.signer);

        console.log(`Successfully upgraded ${pkg.name}`);
      } catch (error) {
        console.error(`Failed to upgrade package ${pkg.name}:`, error);
        throw error;
      }
    }

    console.log("Upgrade process completed for Sui chain", ctx.chain);
  });
}

export async function deploySui<N extends Network, C extends Chain>(
  pwd: string,
  version: string | null,
  mode: Ntt.Mode,
  ch: ChainContext<N, C>,
  token: string,
  signerType: SignerType,
  initialize: boolean,
  skipVerify?: boolean,
  gasBudget?: number,
  packagePath?: string,
  wormholeStateId?: string,
  treasuryCapId?: string
): Promise<SuiDeploymentResult<C>> {
  const finalPackagePath = packagePath || "sui";
  const finalGasBudget = gasBudget || 100000000;

  console.log(`Deploying Sui NTT contracts in ${mode} mode...`);
  console.log(`Package path: ${finalPackagePath}`);
  console.log(`Gas budget: ${finalGasBudget}`);
  console.log(`Target chain: ${ch.chain}`);
  console.log(`Token: ${token}`);

  // Setup Sui environment and execute deployment
  return await withSuiEnv(pwd, ch, async () => {
    const signer = await getSigner(ch, signerType);

    // Build the Move packages
    console.log("Building Move packages...");
    const packagesPath = `${pwd}/${finalPackagePath}/packages`;

    // Detect network type and update Move.toml files accordingly
    const networkType = ch.network;
    const { restore } = updateMoveTomlForNetwork(packagesPath, networkType);

    // Ensure we restore files if deployment fails
    try {
      // Build ntt_common first (dependency)
      try {
        console.log("Building ntt_common package...");
        execSync(`cd ${packagesPath}/ntt_common && sui move build`, {
          stdio: "inherit",
          env: process.env,
        });
      } catch (e) {
        console.error("Failed to build ntt_common package");
        throw e;
      }

      // Build ntt package
      try {
        console.log("Building ntt package...");
        execSync(`cd ${packagesPath}/ntt && sui move build`, {
          stdio: "inherit",
          env: process.env,
        });
      } catch (e) {
        console.error("Failed to build ntt package");
        throw e;
      }

      // Build wormhole_transceiver package
      try {
        console.log("Building wormhole_transceiver package...");
        execSync(`cd ${packagesPath}/wormhole_transceiver && sui move build`, {
          stdio: "inherit",
          env: process.env,
        });
      } catch (e) {
        console.error("Failed to build wormhole_transceiver package");
        throw e;
      }

      // Deploy packages in order
      console.log("Deploying packages...");

      // 1. Deploy ntt_common
      console.log("Publishing ntt_common package...");
      const nttCommonResult = execSync(
        `cd ${packagesPath}/ntt_common && sui client publish --gas-budget ${finalGasBudget} --json`,
        {
          encoding: "utf8",
          env: process.env,
        }
      );

      const nttCommonDeploy = JSON.parse(nttCommonResult);
      if (!nttCommonDeploy.objectChanges) {
        throw new Error("Failed to deploy ntt_common package");
      }

      const nttCommonPackageId = nttCommonDeploy.objectChanges.find(
        (change: any) => change.type === "published"
      )?.packageId;

      if (!nttCommonPackageId) {
        throw new Error("Could not find ntt_common package ID");
      }

      console.log(`ntt_common deployed at: ${nttCommonPackageId}`);

      // 2. Deploy ntt package
      console.log("Publishing ntt package...");
      const nttResult = execSync(
        `cd ${packagesPath}/ntt && sui client publish --gas-budget ${finalGasBudget} --json`,
        {
          encoding: "utf8",
          env: process.env,
        }
      );

      const nttDeploy = JSON.parse(nttResult);
      if (!nttDeploy.objectChanges) {
        throw new Error("Failed to deploy ntt package");
      }

      const nttPackageId = nttDeploy.objectChanges.find(
        (change: any) => change.type === "published"
      )?.packageId;

      if (!nttPackageId) {
        throw new Error("Could not find ntt package ID");
      }

      console.log(`ntt deployed at: ${nttPackageId}`);

      // 3. Deploy wormhole_transceiver package
      console.log("Publishing wormhole_transceiver package...");
      const whTransceiverResult = execSync(
        `cd ${packagesPath}/wormhole_transceiver && sui client publish --gas-budget ${finalGasBudget} --json`,
        {
          encoding: "utf8",
          env: process.env,
        }
      );

      const whTransceiverDeploy = JSON.parse(whTransceiverResult);
      if (!whTransceiverDeploy.objectChanges) {
        throw new Error("Failed to deploy wormhole_transceiver package");
      }

      const whTransceiverPackageId = whTransceiverDeploy.objectChanges.find(
        (change: any) => change.type === "published"
      )?.packageId;

      if (!whTransceiverPackageId) {
        throw new Error("Could not find wormhole_transceiver package ID");
      }

      console.log(
        `wormhole_transceiver deployed at: ${whTransceiverPackageId}`
      );

      // Initialize NTT manager
      console.log("Initializing NTT manager...");

      // 1. Get the deployer caps from deployment results
      const nttDeployerCapId = nttDeploy.objectChanges.find(
        (change: any) =>
          change.type === "created" &&
          change.objectType?.includes("setup::DeployerCap")
      )?.objectId;

      if (!nttDeployerCapId) {
        throw new Error("Could not find NTT DeployerCap object ID");
      }

      const whTransceiverDeployerCapId = whTransceiverDeploy.objectChanges.find(
        (change: any) =>
          change.type === "created" &&
          change.objectType?.includes("DeployerCap")
      )?.objectId;

      if (!whTransceiverDeployerCapId) {
        throw new Error(
          "Could not find Wormhole Transceiver DeployerCap object ID"
        );
      }

      // 2. Get the upgrade cap from NTT deployment
      const nttUpgradeCapId = nttDeploy.objectChanges.find(
        (change: any) =>
          change.type === "created" && change.objectType?.includes("UpgradeCap")
      )?.objectId;

      if (!nttUpgradeCapId) {
        throw new Error("Could not find NTT UpgradeCap object ID");
      }

      // 3. Get Wormhole core bridge state
      let wormholeStateObjectId: string | undefined;
      if (wormholeStateId) {
        wormholeStateObjectId = wormholeStateId;
        console.log(
          `Using provided Wormhole State ID: ${wormholeStateObjectId}`
        );
      } else {
        // Try to get the Wormhole state from the SDK configuration
        try {
          console.log(
            "No wormhole state ID provided, looking up from SDK configuration..."
          );
          const wormholeConfig = ch.config.contracts?.coreBridge;
          if (wormholeConfig) {
            wormholeStateObjectId = wormholeConfig;
            console.log(
              `Using Wormhole State ID from SDK: ${wormholeStateObjectId}`
            );
          } else {
            console.log(
              "No Wormhole core bridge contract found in SDK configuration, will skip wormhole transceiver setup"
            );
          }
        } catch (error) {
          console.log(
            "Failed to lookup Wormhole state from SDK, will skip wormhole transceiver setup"
          );
          console.log(
            "Error:",
            error instanceof Error ? error.message : String(error)
          );
        }
      }

      // 4. Call setup::complete_burning or setup::complete_locking to initialize the NTT manager state
      const chainId = ch.config.chainId; // Get numeric chain ID from config
      const modeArg = mode === "locking" ? "Locking" : "Burning";

      console.log(
        `Completing NTT setup with mode: ${modeArg}, chain ID: ${chainId}`
      );

      // Build the transaction using Sui SDK
      const tx = new Transaction();

      if (mode === "burning") {
        // Call setup::complete_burning (which now requires treasury cap)
        console.log("Attempting to call setup::complete_burning...");
        console.log("Package ID:", nttPackageId);
        console.log(
          "Function target:",
          `${nttPackageId}::setup::complete_burning`
        );
        console.log("Token type:", token);

        // For burning mode, we need a treasury cap
        if (!treasuryCapId) {
          throw new Error(
            "Burning mode deployment requires a treasury cap. Please provide --sui-treasury-cap <TREASURY_CAP_ID>"
          );
        }

        console.log("Treasury Cap ID:", treasuryCapId);

        const [adminCap, upgradeCapNtt] = tx.moveCall({
          target: `${nttPackageId}::setup::complete_burning`,
          typeArguments: [token],
          arguments: [
            tx.object(nttDeployerCapId),
            tx.object(nttUpgradeCapId),
            tx.pure.u16(chainId),
            tx.object(treasuryCapId),
          ],
        });

        // Transfer both capability objects to the transaction sender
        tx.transferObjects(
          [adminCap, upgradeCapNtt],
          tx.pure.address(signer.address.address.toString())
        );
      } else {
        // Call setup::complete_locking
        console.log("Attempting to call setup::complete_locking...");
        console.log("Package ID:", nttPackageId);
        console.log(
          "Function target:",
          `${nttPackageId}::setup::complete_locking`
        );
        console.log("Token type:", token);

        const [adminCap, upgradeCapNtt] = tx.moveCall({
          target: `${nttPackageId}::setup::complete_locking`,
          typeArguments: [token], // Use the original token format
          arguments: [
            tx.object(nttDeployerCapId),
            tx.object(nttUpgradeCapId),
            tx.pure.u16(chainId),
          ],
        });

        // Transfer both capability objects to the transaction sender
        tx.transferObjects(
          [adminCap, upgradeCapNtt],
          tx.pure.address(signer.address.address.toString())
        );
      }

      // Set gas budget
      tx.setGasBudget(finalGasBudget);

      // Execute the transaction using the signer's client
      // TODO: clean this up
      const suiSigner = signer.signer as any; // Cast to access internal client
      const setupResult = await suiSigner.client.signAndExecuteTransaction({
        signer: suiSigner._signer, // Access the underlying Ed25519Keypair
        transaction: tx,
        options: {
          showEffects: true,
          showObjectChanges: true,
        },
      });

      const setupDeploy = setupResult;
      if (!setupDeploy.objectChanges) {
        throw new Error("Failed to complete NTT setup");
      }

      // Log all object changes and effects to debug
      console.log(
        "Transaction effects:",
        JSON.stringify(setupDeploy.effects, null, 2)
      );
      console.log(
        "Object changes:",
        JSON.stringify(setupDeploy.objectChanges, null, 2)
      );

      // Find the shared State object
      const nttStateId = setupDeploy.objectChanges.find(
        (change: any) =>
          change.type === "created" &&
          change.objectType?.includes("state::State") &&
          change.owner?.Shared
      )?.objectId;

      if (!nttStateId) {
        console.log("Looking for any shared objects...");
        const sharedObjects = setupDeploy.objectChanges.filter(
          (change: any) => change.owner === "Shared"
        );
        console.log("Shared objects:", JSON.stringify(sharedObjects, null, 2));
        throw new Error("Could not find NTT State object ID");
      }

      // Find the NTT AdminCap object ID for future reference
      const nttAdminCapId = setupDeploy.objectChanges.find(
        (change: any) =>
          change.type === "created" &&
          change.objectType?.includes("state::AdminCap")
      )?.objectId;

      if (nttAdminCapId) {
        console.log(`NTT AdminCap created at: ${nttAdminCapId}`);
      }

      console.log(`NTT State created at: ${nttStateId}`);

      // 5. Complete wormhole transceiver setup
      let transceiverStateId: string | undefined;
      let whTransceiverAdminCapId: string | undefined;

      if (wormholeStateObjectId) {
        console.log("Completing Wormhole Transceiver setup...");

        // Build the transceiver setup transaction
        const transceiverTx = new Transaction();

        console.log(`  Package: ${whTransceiverPackageId}`);
        console.log(`  Module: wormhole_transceiver`);
        console.log(`  Function: complete`);
        console.log(`  Type args: ${nttPackageId}::auth::ManagerAuth`);
        console.log(`  Deployer cap: ${whTransceiverDeployerCapId}`);
        console.log(`  Wormhole state: ${wormholeStateObjectId}`);

        // Call wormhole_transceiver::complete and transfer the returned AdminCap
        const [adminCap] = transceiverTx.moveCall({
          target: `${whTransceiverPackageId}::wormhole_transceiver::complete`,
          typeArguments: [`${nttPackageId}::auth::ManagerAuth`],
          arguments: [
            transceiverTx.object(whTransceiverDeployerCapId),
            transceiverTx.object(wormholeStateObjectId),
          ],
        });

        // Transfer the AdminCap to the signer to avoid UnusedValueWithoutDrop
        transceiverTx.transferObjects(
          [adminCap],
          signer.address.address.toString()
        );

        transceiverTx.setGasBudget(finalGasBudget);

        // Execute the transceiver setup transaction using the same method as NTT setup
        try {
          // Wait a moment to allow the network to settle after NTT setup
          await new Promise((resolve) => setTimeout(resolve, 1000));

          const suiSigner = signer.signer as any; // Cast to access internal client
          const transceiverSetupResult =
            await suiSigner.client.signAndExecuteTransaction({
              signer: suiSigner._signer, // Access the underlying Ed25519Keypair
              transaction: transceiverTx,
              options: {
                showEffects: true,
                showObjectChanges: true,
              },
            });

          const transceiverSetupDeploy = transceiverSetupResult;
          if (!transceiverSetupDeploy.objectChanges) {
            throw new Error("Failed to complete Wormhole Transceiver setup");
          }

          console.log(
            JSON.stringify(transceiverSetupDeploy.objectChanges, null, 2)
          );

          // Find the transceiver state - look for State object that is shared
          transceiverStateId = transceiverSetupDeploy.objectChanges.find(
            (change: any) =>
              change.type === "created" &&
              change.objectType?.includes("::wormhole_transceiver::State") &&
              change.owner?.Shared
          )?.objectId;

          if (!transceiverStateId) {
            console.log("Looking for any State object (not just shared)...");
            const stateObject = transceiverSetupDeploy.objectChanges.find(
              (change: any) =>
                change.type === "created" &&
                change.objectType?.includes("State")
            );
            if (stateObject) {
              console.log(
                "Found State object:",
                JSON.stringify(stateObject, null, 2)
              );
            }
            throw new Error(
              "Could not find Wormhole Transceiver State object ID"
            );
          }

          console.log(
            `Wormhole Transceiver State created at: ${transceiverStateId}`
          );

          // Find the AdminCap object ID for future reference
          whTransceiverAdminCapId = transceiverSetupDeploy.objectChanges.find(
            (change: any) =>
              change.type === "created" &&
              change.objectType?.includes("::wormhole_transceiver::AdminCap")
          )?.objectId;

          if (whTransceiverAdminCapId) {
            console.log(
              `Wormhole Transceiver AdminCap created at: ${whTransceiverAdminCapId}`
            );
          }

          // 6. Register the wormhole transceiver with the NTT manager
          if (nttAdminCapId && transceiverStateId) {
            console.log("Registering wormhole transceiver with NTT manager...");

            const registerTx = new Transaction();

            console.log(`  NTT State: ${nttStateId}`);
            console.log(`  NTT AdminCap: ${nttAdminCapId}`);
            console.log(
              `  Transceiver Type: ${whTransceiverPackageId}::wormhole_transceiver::TransceiverAuth`
            );

            // Call state::register_transceiver to register the wormhole transceiver
            registerTx.moveCall({
              target: `${nttPackageId}::state::register_transceiver`,
              typeArguments: [
                `${whTransceiverPackageId}::wormhole_transceiver::TransceiverAuth`, // Transceiver type
                token, // Token type
              ],
              arguments: [
                registerTx.object(nttStateId), // NTT state (mutable)
                registerTx.object(transceiverStateId),
                registerTx.object(nttAdminCapId), // AdminCap for authorization
              ],
            });

            registerTx.setGasBudget(finalGasBudget);

            try {
              await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait for network

              const registerResult =
                await suiSigner.client.signAndExecuteTransaction({
                  signer: suiSigner._signer,
                  transaction: registerTx,
                  options: {
                    showEffects: true,
                    showObjectChanges: true,
                  },
                });

              if (registerResult.effects?.status?.status !== "success") {
                throw new Error(
                  `Registration failed: ${JSON.stringify(
                    registerResult.effects?.status
                  )}`
                );
              }

              console.log(
                "✅ Wormhole transceiver successfully registered with NTT manager"
              );
            } catch (error) {
              console.error(
                "❌ Failed to register wormhole transceiver with NTT manager:",
                error
              );
              // Don't throw here, let deployment continue, but warn the user
              console.warn(
                "⚠️  Deployment completed but transceiver registration failed. You may need to register it manually."
              );
            }
          } else {
            console.warn(
              "⚠️  Skipping transceiver registration: missing NTT AdminCap or transceiver state ID"
            );
          }
        } catch (error) {
          console.error("Wormhole Transceiver setup failed:", error);
          console.error("Error details:", JSON.stringify(error, null, 2));
          throw error;
        }
      } else {
        console.log(
          "Skipping Wormhole Transceiver setup (no wormhole state available)..."
        );
        console.log(
          "Note: Wormhole state not found in SDK configuration. To manually specify, use --sui-wormhole-state parameter."
        );
      }

      console.log(colors.green("Sui NTT deployment completed successfully!"));
      console.log(`NTT Package ID: ${nttPackageId}`);
      console.log(`NTT State ID: ${nttStateId}`);
      console.log(`Wormhole Transceiver Package ID: ${whTransceiverPackageId}`);
      console.log(
        `Wormhole Transceiver State ID: ${
          transceiverStateId || "Not deployed (skipped)"
        }`
      );

      // Restore original Move.toml files after successful deployment
      restore();

      // Return the deployment information including AdminCaps and package IDs
      return {
        chain: ch.chain,
        address: toUniversal(ch.chain, nttStateId),
        adminCaps: {
          wormholeTransceiver: whTransceiverAdminCapId,
        },
        transceiverStateIds: {
          wormhole: transceiverStateId,
        },
        packageIds: {
          ntt: nttPackageId,
          nttCommon: nttCommonPackageId,
          wormholeTransceiver: whTransceiverPackageId,
        },
      };
    } catch (deploymentError) {
      // Restore original Move.toml files if deployment fails
      restore();
      handleDeploymentError(
        deploymentError,
        ch.chain,
        ch.network,
        ch.config.rpc
      );
    }
  });
}
