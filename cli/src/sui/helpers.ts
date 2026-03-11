import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import {
  type Chain,
  type ChainContext,
  type Network,
} from "@wormhole-foundation/sdk";
import type { SuiChains } from "@wormhole-foundation/sdk-sui";
import type { SuiNtt } from "@wormhole-foundation/sdk-sui-ntt";
import { Transaction } from "@mysten/sui/transactions";

const MIN_SUI_VERSION = "1.63.0";

function parseVersion(version: string): number[] {
  return version.split(".").map(Number);
}

function versionAtLeast(current: string, minimum: string): boolean {
  const cur = parseVersion(current);
  const min = parseVersion(minimum);
  for (let i = 0; i < min.length; i++) {
    if ((cur[i] ?? 0) > min[i]) return true;
    if ((cur[i] ?? 0) < min[i]) return false;
  }
  return true;
}

export function checkSuiVersion(): void {
  let output: string;
  try {
    output = execFileSync("sui", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("Could not run 'sui --version'. Is the Sui CLI installed?");
  }
  // Output format: "sui 1.63.2-abc123"
  const match = output.match(/sui\s+(\d+\.\d+\.\d+)/);
  if (!match) {
    throw new Error(`Could not parse Sui version from: ${output}`);
  }
  const version = match[1];
  if (!versionAtLeast(version, MIN_SUI_VERSION)) {
    throw new Error(
      `Sui CLI version ${version} is too old. Minimum required: ${MIN_SUI_VERSION}. ` +
        `Please update with: cargo install --locked --git https://github.com/MystenLabs/sui.git sui`
    );
  }
  console.log(`Sui CLI version: ${version}`);
}

// Setup Sui environment for consistent CLI usage with automatic cleanup
export async function withSuiEnv<N extends Network, C extends Chain, T>(
  pwd: string,
  ch: ChainContext<N, C>,
  fn: () => Promise<T>
): Promise<T> {
  checkSuiVersion();
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
      execFileSync(
        "sui",
        ["client", "new-env", "--alias", envAlias, "--rpc", rpcUrl],
        { stdio: "inherit", env: process.env }
      );
    } catch (error) {
      // Environment might already exist, try to switch to it
      console.log(
        `Environment ${envAlias} may already exist, switching to it...`
      );
    }

    // Switch to the environment
    try {
      execFileSync("sui", ["client", "switch", "--env", envAlias], {
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
  // Determine build environment for Sui 1.63+ package system
  const buildEnv = ctx.network === "Mainnet" ? "mainnet" : "testnet";

  // Get build output with dependencies using the correct sui command
  console.log(
    `Running sui move build --dump-bytecode-as-base64 -e ${buildEnv} for ${packagePath}...`
  );

  const buildOutput = execFileSync(
    "sui",
    [
      "move",
      "build",
      "--dump-bytecode-as-base64",
      "-e",
      buildEnv,
      "--path",
      packagePath,
    ],
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

export function buildSuiPackage(
  packagesPath: string,
  packageName: string,
  buildEnv: string
): void {
  console.log(`Building ${packageName} package...`);
  try {
    execFileSync("sui", ["move", "build", "-e", buildEnv], {
      cwd: path.join(packagesPath, packageName),
      stdio: "inherit",
      env: process.env,
    });
  } catch (e) {
    console.error(`Failed to build ${packageName} package`);
    throw e;
  }
}

export interface SuiPublishResult {
  packageId: string;
  objectChanges: any[];
}

export function publishSuiPackage(
  packagesPath: string,
  packageName: string,
  gasBudget: number
): SuiPublishResult {
  console.log(`Publishing ${packageName} package...`);
  const result = execFileSync(
    "sui",
    ["client", "publish", "--gas-budget", String(gasBudget), "--json"],
    {
      cwd: path.join(packagesPath, packageName),
      encoding: "utf8",
      env: process.env,
    }
  );
  const deploy = JSON.parse(result.substring(result.indexOf("{")));
  if (!deploy.objectChanges) {
    throw new Error(`Failed to deploy ${packageName} package`);
  }
  const packageId = deploy.objectChanges.find(
    (c: any) => c.type === "published"
  )?.packageId;
  if (!packageId) {
    throw new Error(
      `Could not find package ID for ${packageName} in publish result`
    );
  }
  console.log(`${packageName} deployed at: ${packageId}`);
  return { packageId, objectChanges: deploy.objectChanges };
}

/**
 * Find a created object in transaction objectChanges by type substring.
 * If `shared` is true, only matches shared objects.
 */
export function findCreatedObject(
  objectChanges: any[],
  typeSubstring: string,
  shared?: boolean
): string | undefined {
  return objectChanges.find(
    (c: any) =>
      c.type === "created" &&
      c.objectType?.includes(typeSubstring) &&
      (!shared || c.owner?.Shared)
  )?.objectId;
}

/**
 * Generate Published.toml content for a Sui package.
 * Tells the build system the package is already published at the given address.
 */
export function generatePublishedToml(
  env: string,
  chainId: string,
  packageId: string
): string {
  return `[published.${env}]\nchain-id = "${chainId}"\npublished-at = "${packageId}"\noriginal-id = "${packageId}"\nversion = 1\n`;
}

export function parsePublishedToml(
  filePath: string,
  env: string
): { packageId: string; upgradeCap: string } {
  const content = fs.readFileSync(filePath, "utf8");
  const section = content.match(
    new RegExp(`\\[published\\.${env}\\][\\s\\S]*?(?=\\[|$)`)
  );
  if (!section) throw new Error(`No [published.${env}] section in ${filePath}`);
  const publishedAt = section[0].match(/published-at\s*=\s*"(0x[0-9a-f]+)"/);
  const upgradeCap = section[0].match(
    /upgrade-capability\s*=\s*"(0x[0-9a-f]+)"/
  );
  if (!publishedAt?.[1])
    throw new Error(`No published-at in [published.${env}] of ${filePath}`);
  if (!upgradeCap?.[1])
    throw new Error(
      `No upgrade-capability in [published.${env}] of ${filePath}`
    );
  return {
    packageId: publishedAt[1],
    upgradeCap: upgradeCap[1],
  };
}

export function movePublishedTomlToMainTree(
  packagesPath: string,
  mainTreePackagesPath: string,
  packageNames: string[]
): void {
  for (const pkg of packageNames) {
    const worktreePath = `${packagesPath}/${pkg}/Published.toml`;
    const mainTreePath = `${mainTreePackagesPath}/${pkg}/Published.toml`;

    if (
      fs.existsSync(worktreePath) &&
      !fs.lstatSync(worktreePath).isSymbolicLink()
    ) {
      fs.copyFileSync(worktreePath, mainTreePath);
      fs.unlinkSync(worktreePath);
      fs.rmSync(worktreePath, { force: true });
      fs.symlinkSync(path.resolve(mainTreePath), path.resolve(worktreePath));
      console.log(`Moved Published.toml for ${pkg} to ${mainTreePath}`);
    }
  }
}

export interface SuiSetupProgress {
  nttStateId?: string;
  nttAdminCapId?: string;
  transceiverStateId?: string;
  whTransceiverAdminCapId?: string;
  transceiverRegistered?: boolean;
}

export function readSetupProgress(filePath: string): SuiSetupProgress {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

export function saveSetupProgress(
  filePath: string,
  progress: SuiSetupProgress
): void {
  fs.writeFileSync(filePath, JSON.stringify(progress, null, 2));
}
