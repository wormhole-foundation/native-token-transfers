import { execSync, execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import {
  signSendWait,
  type Chain,
  type ChainContext,
  type Network,
} from "@wormhole-foundation/sdk";
import type { SuiChains } from "@wormhole-foundation/sdk-sui";
import type { SuiNtt } from "@wormhole-foundation/sdk-sui-ntt";
import { Transaction } from "@mysten/sui/transactions";

// Setup Sui environment for consistent CLI usage with automatic cleanup
export async function withSuiEnv<N extends Network, C extends Chain, T>(
  pwd: string,
  ch: ChainContext<N, C>,
  fn: () => Promise<T>
): Promise<T> {
  console.log("Setting up Sui environment...");

  // Store original environment variable
  const originalSuiConfigDir = process.env.SUI_CONFIG_DIR;

  // Create .sui directory in project root
  const suiConfigDir = path.resolve(path.join(pwd, ".sui"));
  fs.rmSync(suiConfigDir, { recursive: true, force: true });
  fs.mkdirSync(suiConfigDir, { recursive: true });

  try {
    // Set SUI_CONFIG_DIR environment variable
    process.env.SUI_CONFIG_DIR = suiConfigDir;

    console.log(`Using SUI_CONFIG_DIR: ${suiConfigDir}`);

    // Create client.yaml configuration file
    const clientYamlContent = `keystore:
  File: "${suiConfigDir}/sui.keystore"
envs:
  - alias: local
    rpc: "http://127.0.0.1:9000"
    ws: ~
active_env: local
active_address: ~
`;
    fs.writeFileSync(path.join(suiConfigDir, "client.yaml"), clientYamlContent);

    // Create empty keystore file
    fs.writeFileSync(path.join(suiConfigDir, "sui.keystore"), "[]");

    console.log("Created Sui configuration files");

    // Import private key if SUI_PRIVATE_KEY environment variable is set
    const privateKey = process.env.SUI_PRIVATE_KEY;
    if (privateKey) {
      console.log("Importing private key from SUI_PRIVATE_KEY...");
      try {
        execFileSync(
          "sui",
          ["keytool", "import", privateKey, "ed25519", "--alias", "default"],
          { stdio: "pipe", env: process.env }
        );
        console.log("Private key imported successfully");
      } catch (error) {
        console.error("Failed to import private key:", error);
        throw error;
      }
    }

    // Get RPC URL from chain context
    const rpcUrl = ch.config.rpc;
    console.error(rpcUrl);

    // Determine network environment based on RPC URL
    let envAlias: string;
    if (rpcUrl.includes("mainnet")) {
      envAlias = "mainnet";
    } else if (rpcUrl.includes("testnet")) {
      envAlias = "testnet";
    } else {
      envAlias = "devnet";
    }

    // Create or update the environment
    console.log(`Setting up ${envAlias} environment with RPC: ${rpcUrl}`);
    try {
      execSync(`sui client new-env --alias ${envAlias} --rpc ${rpcUrl}`, {
        stdio: "inherit",
        env: process.env,
      });
    } catch (error) {
      // Environment might already exist, try to switch to it
      console.log(
        `Environment ${envAlias} may already exist, switching to it...`
      );
    }

    // Switch to the environment
    try {
      execSync(`sui client switch --env ${envAlias}`, {
        stdio: "inherit",
        env: process.env,
      });
      console.log(`Switched to ${envAlias} environment`);
    } catch (error) {
      console.error(`Failed to switch to ${envAlias} environment:`, error);
      throw error;
    }

    // Execute the provided function
    return await fn();
  } finally {
    // remove directory
    // fs.rmSync(suiConfigDir, { recursive: true, force: true });
    // Cleanup: restore original environment variable
    if (originalSuiConfigDir !== undefined) {
      process.env.SUI_CONFIG_DIR = originalSuiConfigDir;
    } else {
      delete process.env.SUI_CONFIG_DIR;
    }

    console.log("Sui environment cleaned up");
  }
}

// Helper function to update Move.toml files for network-specific dependencies
export function updateMoveTomlForNetwork(
  packagesPath: string,
  networkType: Network
): { restore: () => void } {
  const packages = ["ntt_common", "ntt", "wormhole_transceiver"];
  const backups: { [key: string]: string } = {};

  // Determine the correct revisions based on network (with environment variable overrides)
  const wormholeRev =
    process.env.WORMHOLE_REV ||
    (networkType === "Mainnet" ? "sui/mainnet" : "sui/testnet");

  // localhost not supported for now, because the
  if (networkType === "Devnet") {
    throw new Error("devnet not supported yet");
  }

  console.log(`Updating Move.toml files for ${networkType} network...`);
  console.log(`  Wormhole revision: ${wormholeRev}`);

  for (const packageName of packages) {
    const moveTomlPath = `${packagesPath}/${packageName}/Move.toml`;

    try {
      // Backup original content
      const originalContent = fs.readFileSync(moveTomlPath, "utf8");
      backups[moveTomlPath] = originalContent;

      let content = originalContent;

      // Update Wormhole revision
      content = content.replace(
        /rev = "sui\/(testnet|mainnet)"/g,
        `rev = "${wormholeRev}"`
      );

      // Only write if content actually changed
      if (content !== originalContent) {
        fs.writeFileSync(moveTomlPath, content, "utf8");
        console.log(`  Updated ${packageName}/Move.toml`);
      } else {
        console.log(`  No changes needed for ${packageName}/Move.toml`);
      }
    } catch (error) {
      console.warn(
        `  Warning: Could not update ${packageName}/Move.toml: ${error}`
      );
      // Don't throw error here to allow deployment to continue
    }
  }

  // Return restore function
  return {
    restore: () => {
      console.log("Restoring original Move.toml files...");
      for (const [filePath, content] of Object.entries(backups)) {
        try {
          fs.writeFileSync(filePath, content, "utf8");
        } catch (error) {
          console.warn(`  Warning: Could not restore ${filePath}: ${error}`);
        }
      }
    },
  };
}

// Helper function to perform complete package upgrade in a single PTB
export async function performPackageUpgradeInPTB<
  N extends Network,
  C extends SuiChains,
>(
  ctx: ChainContext<N, C>,
  packagePath: string,
  upgradeCapId: string,
  ntt: SuiNtt<N, C>
): Promise<any> {
  // Get the package name from the path
  const packageName = packagePath.split("/").pop();
  let buildPackageName: string;

  // Map directory names to build package names
  switch (packageName) {
    case "ntt_common":
      buildPackageName = "NttCommon";
      break;
    case "ntt":
      buildPackageName = "Ntt";
      break;
    case "wormhole_transceiver":
      buildPackageName = "WormholeTransceiver";
      break;
    default:
      throw new Error(`Unknown package: ${packageName}`);
  }

  // Get build output with dependencies using the correct sui command
  console.log(
    `Running sui move build --dump-bytecode-as-base64 for ${packagePath}...`
  );

  const buildOutput = execSync(
    `sui move build --dump-bytecode-as-base64 --path ${packagePath}`,
    {
      encoding: "utf-8",
      env: process.env,
    }
  );

  const { modules, dependencies, digest } = JSON.parse(buildOutput);

  console.log(
    `Found ${modules.length} modules and ${dependencies.length} dependencies to upgrade`
  );
  console.log(`Build digest: ${digest}`);

  // Create a single PTB that performs all upgrade steps
  const tx = new Transaction();
  const packageId = await ntt.getPackageId();

  // Step 1: Authorize the upgrade - this returns an UpgradeTicket
  const upgradeTicket = tx.moveCall({
    target: `${packageId}::upgrades::authorize_upgrade`,
    arguments: [
      tx.object(upgradeCapId),
      tx.pure.vector("u8", Array.from(Buffer.from(digest, "hex"))),
    ],
  });

  // Step 2: Perform the upgrade using the ticket
  const upgradeReceipt = tx.upgrade({
    modules,
    dependencies,
    package: packageId,
    ticket: upgradeTicket,
  });

  // Step 3: Commit the upgrade
  tx.moveCall({
    target: `${packageId}::upgrades::commit_upgrade`,
    typeArguments: [ntt.contracts.ntt!["token"]], // Token type parameter
    arguments: [
      tx.object(upgradeCapId),
      tx.object(ntt.contracts.ntt!["manager"]), // state
      upgradeReceipt,
    ],
  });

  // Set gas budget
  tx.setGasBudget(1000000000);

  // Return the unsigned transaction
  return {
    chainId: ctx.chain,
    transaction: tx,
    description: "Package Upgrade PTB",
  };
}
