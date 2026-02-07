#!/usr/bin/env bun
import "./side-effects"; // doesn't quite work for silencing the bigint error message. why?
import evm from "@wormhole-foundation/sdk/platforms/evm";
import solana from "@wormhole-foundation/sdk/platforms/solana";
import sui from "@wormhole-foundation/sdk/platforms/sui";
import {
  encoding,
  type RpcConnection,
  type UnsignedTransaction,
  type WormholeConfigOverrides,
} from "@wormhole-foundation/sdk-connect";
import { execSync } from "child_process";
import * as myEvmSigner from "./evmsigner.js";

import { colors } from "./colors.js";
import yargs from "yargs";
import { $ } from "bun";
import { hideBin } from "yargs/helpers";
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import * as solanaWeb3 from "@solana/web3.js";
import * as spl from "@solana/spl-token";
import fs from "fs";
import path from "path";
import {
  ChainContext,
  UniversalAddress,
  Wormhole,
  assertChain,
  canonicalAddress,
  chainToPlatform,
  chains,
  signSendWait,
  toUniversal,
  type AccountAddress,
  type Chain,
  type ChainAddress,
  type Network,
  type Platform,
} from "@wormhole-foundation/sdk";
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import "@wormhole-foundation/sdk-evm-ntt";
import "@wormhole-foundation/sdk-solana-ntt";
import "@wormhole-foundation/sdk-sui-ntt";
import "@wormhole-foundation/sdk-definitions-ntt";
import type {
  Ntt,
  NttTransceiver,
} from "@wormhole-foundation/sdk-definitions-ntt";
import {
  type SolanaChains,
  SolanaAddress,
} from "@wormhole-foundation/sdk-solana";
import { type SuiChains } from "@wormhole-foundation/sdk-sui";
import { registerSolanaTransceiver } from "./solanaHelpers";

import { colorizeDiff, diffObjects } from "./diff";
import { forgeSignerArgs, getSigner, type SignerType } from "./getSigner";
import { handleDeploymentError } from "./error";
import { loadConfig, type ChainConfig, type Config } from "./deployments";
export type { ChainConfig, Config } from "./deployments";
export type { Deployment } from "./validation";

import {
  options,
  EXCLUDED_DIFF_PATHS,
  CCL_CONTRACT_ADDRESSES,
} from "./commands/shared";
import type { CclConfig, SuiDeploymentResult } from "./commands/shared";

import { NTT, SolanaNtt } from "@wormhole-foundation/sdk-solana-ntt";
import type {
  EvmNtt,
  EvmNttWormholeTranceiver,
} from "@wormhole-foundation/sdk-evm-ntt";
import { SuiNtt } from "@wormhole-foundation/sdk-sui-ntt";
import type { EvmChains } from "@wormhole-foundation/sdk-evm";
import { getAvailableVersions, getGitTagName } from "./tag";
import * as configuration from "./configuration";
import { createTokenTransferCommand } from "./tokenTransfer";
import {
  createAddChainCommand,
  createCloneCommand,
  createConfigCommand,
  createHypeCommand,
  createInitCommand,
  createManualCommand,
  createNewCommand,
  createPullCommand,
  createPushCommand,
  createSetMintAuthorityCommand,
  createSolanaCommand,
  createStatusCommand,
  createTransferOwnershipCommand,
  createUpdateCommand,
  createUpgradeCommand,
} from "./commands";
import { ethers, Interface } from "ethers";
import { newSignSendWaiter } from "./signSendWait.js";
import { promptYesNo } from "./prompts.js";
import {
  loadOverrides,
  promptSolanaMainnetOverridesIfNeeded,
} from "./overrides.js";
import {
  collectMissingConfigs,
  ensureNttRoot,
  printMissingConfigReport,
  retryWithExponentialBackoff,
  validatePayerOption,
} from "./validation";
import type { Deployment } from "./validation";

// TODO: check if manager can mint the token in burning mode (on solana it's
// simple. on evm we need to simulate with prank)
const overrides: WormholeConfigOverrides<Network> = loadOverrides();

// CclConfig and CCL_CONTRACT_ADDRESSES imported from ./commands/shared

/**
 * Parse the --unsafe-custom-finality flag value
 * Format: "level:blocks" where level is 200/201/202 and blocks is additional wait
 * Example: "200:5" means instant + 5 blocks
 */
export function parseCclFlag(
  value: string,
  network: Network,
  chain: Chain
): CclConfig | null {
  if (!value) return null;

  const parts = value.split(":");
  if (parts.length !== 2) {
    throw new Error(
      "Invalid --unsafe-custom-finality format. Expected 'level:blocks' (e.g., '200:5')"
    );
  }

  const customConsistencyLevel = parseInt(parts[0], 10);
  const additionalBlocks = parseInt(parts[1], 10);

  // Validate consistency level
  if (![200, 201, 202].includes(customConsistencyLevel)) {
    throw new Error(
      `Invalid consistency level: ${customConsistencyLevel}. Must be 200 (instant), 201 (safe), or 202 (finalized)`
    );
  }

  // Validate additional blocks
  if (isNaN(additionalBlocks) || additionalBlocks < 0) {
    throw new Error(
      `Invalid additional blocks: ${parts[1]}. Must be a non-negative integer`
    );
  }

  // Get CCL contract address for the chain and network
  const networkAddresses = CCL_CONTRACT_ADDRESSES[network];
  const cclContractAddress = networkAddresses?.[chain];
  if (!cclContractAddress) {
    throw new Error(
      `No CCL contract address known for chain ${chain} on ${network}. Please contact Wormhole team for the correct address.`
    );
  }

  return {
    customConsistencyLevel,
    additionalBlocks,
    cclContractAddress,
  };
}

/**
 * Display warning and get confirmation for custom finality usage
 */
export async function confirmCustomFinality(): Promise<boolean> {
  const warningMessage = `
${colors.yellow("⚠️⚠️⚠️ Custom finality is an advanced feature. Wormhole Contributors recommend to use this with caution.")}

${colors.yellow("Choosing a level of finality other than ")}${colors.cyan("`finalized`")}${colors.yellow(" on EVM chains exposes you to re-org risk")} (https://www.alchemy.com/overviews/what-is-a-reorg). ${colors.yellow("This is especially dangerous when moving assets cross-chain, because it means that assets released or minted on the destination chain may not have been burned or locked on the source chain.")}

${colors.yellow('To select a custom finality level, Wormhole Contributors recommend referring to information on forked blocks in blockchain explorers, paying attention to the "ReorgDepth" column.')}
  ${colors.cyan("- Ethereum: https://etherscan.io/blocks_forked?p=1")}
  ${colors.cyan("- Polygon: https://polygonscan.com/blocks_forked")}
  ${colors.cyan("- …")}

${colors.yellow("By proceeding, you affirm that you understand, and are comfortable with, the risks of setting a custom finality level, and you understand the re-org/rollback risks of Custom finality, accept sole responsibility, and agree the Wormhole Parties have no liability for losses arising from your selection.")}
`;

  console.log(warningMessage);
  return await promptYesNo("Do you want to proceed?", { defaultYes: false });
}

// Setup Sui environment for consistent CLI usage with automatic cleanup
async function withSuiEnv<N extends Network, C extends Chain, T>(
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
        execSync(`sui keytool import "${privateKey}" ed25519 --alias default`, {
          stdio: undefined,
          env: process.env,
        });
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

// SuiDeploymentResult and options imported from ./commands/shared
export type { SuiDeploymentResult } from "./commands/shared";

/**
 * Executes a callback with deployment scripts, optionally overriding them with version 1 scripts.
 *
 * Version 1 Script Override:
 * --------------------------
 * For version 1 deployments (scripts without DEPLOY_SCRIPT_VERSION comment), we extract the
 * scripts from commit 3f56da6541eb9d09f84cc676391e6fbc5b687dd7. This commit contains the last
 * known-good version 1 scripts that are compatible with all old NTT versions.
 *
 * Why override version 1 scripts?
 * - Version 1 scripts in old worktrees don't all work
 * - The scripts at commit 3f56da6541eb9d09f84cc676391e6fbc5b687dd7 is known to work for all old versions
 * - This ensures consistent behaviour across all version 1 deployments
 *
 * Starting from version 2, scripts in the worktree are reliable and can be used as-is.
 * Version 2+ scripts include the DEPLOY_SCRIPT_VERSION comment and use environment variables.
 */
async function withDeploymentScript<A>(
  pwd: string,
  useBundledV1Scripts: boolean,
  then: () => Promise<A>
): Promise<A> {
  ensureNttRoot(pwd);

  const scriptDir = `${pwd}/evm/script`;
  const backupDir = `${pwd}/evm/script.backup`;

  // Override with v1 scripts from git commit if needed
  if (useBundledV1Scripts && pwd !== ".") {
    // Remove any existing backup
    if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }

    // Backup original worktree scripts
    if (fs.existsSync(scriptDir)) {
      fs.cpSync(scriptDir, backupDir, { recursive: true });
    }

    // Extract v1 scripts from the specific git commit
    const tempDir = `${pwd}/evm/script.temp`;
    const absoluteTempDir = path.resolve(tempDir);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      // Use git archive to extract evm/script from commit 3f56da6541eb9d09f84cc676391e6fbc5b687dd7
      // - git archive must run from repository root (process.cwd())
      // - Extract to absolute path to handle worktree locations correctly
      // - --strip-components=2 removes both "evm/" and "script/" path prefixes
      execSync(
        `git archive 3f56da6541eb9d09f84cc676391e6fbc5b687dd7 evm/script | tar -x -C "${absoluteTempDir}" --strip-components=2`,
        { cwd: process.cwd(), stdio: "pipe" }
      );

      // Replace the script directory with the extracted version
      fs.rmSync(scriptDir, { recursive: true, force: true });
      fs.cpSync(tempDir, scriptDir, { recursive: true });
    } finally {
      // Clean up temp directory
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }

  try {
    return await then();
  } finally {
    // Restore original scripts if we overrode them
    if (useBundledV1Scripts && pwd !== ".") {
      fs.rmSync(scriptDir, { recursive: true, force: true });
      if (fs.existsSync(backupDir)) {
        fs.cpSync(backupDir, scriptDir, { recursive: true });
        fs.rmSync(backupDir, { recursive: true, force: true });
      }
    }
  }
}

/**
 * Detects the deploy script version by checking for DEPLOY_SCRIPT_VERSION comment
 * Version 1: Scripts with run() method that takes explicit parameters
 * Version 2+: Scripts with run() method that reads from environment variables
 */
function detectDeployScriptVersion(pwd: string): number {
  const scriptPath = `${pwd}/evm/script/DeployWormholeNtt.s.sol`;

  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Deploy script not found: ${scriptPath}`);
  }

  const scriptContent = fs.readFileSync(scriptPath, "utf8");

  // Look for DEPLOY_SCRIPT_VERSION comment
  const versionMatch = scriptContent.match(
    /\/\/\s*DEPLOY_SCRIPT_VERSION:\s*(\d+)/
  );

  if (versionMatch) {
    return parseInt(versionMatch[1], 10);
  }

  // Default to version 1 if no version comment found
  return 1;
}

/**
 * Checks if manager variants are supported by checking if NttManagerNoRateLimiting.sol exists
 */
function supportsManagerVariants(pwd: string): boolean {
  const noRateLimitingPath = `${pwd}/evm/src/NttManager/NttManagerNoRateLimiting.sol`;
  return fs.existsSync(noRateLimitingPath);
}

yargs(hideBin(process.argv))
  .wrap(Math.min(process.stdout.columns || 120, 160)) // Use terminal width, but no more than 160 characters
  .scriptName("ntt")
  .version(
    (() => {
      const ver = nttVersion();
      if (!ver) {
        return "unknown";
      }
      const { version, commit, path, remote } = ver;
      const defaultPath = `${process.env.HOME}/.ntt-cli/.checkout`;
      const remoteString = remote.includes("wormhole-foundation")
        ? ""
        : `${remote}@`;
      if (path === defaultPath) {
        return `ntt v${version} (${remoteString}${commit})`;
      } else {
        return `ntt v${version} (${remoteString}${commit}) from ${path}`;
      }
    })()
  )
  // Commands (extracted to individual files in commands/)
  .command(createConfigCommand())
  .command(createUpdateCommand())
  .command(createNewCommand())
  .command(createAddChainCommand(overrides))
  .command(createUpgradeCommand(overrides))
  .command(createCloneCommand(overrides))
  .command(createInitCommand())
  .command(createPullCommand(overrides))
  .command(createPushCommand(overrides))
  .command(createStatusCommand(overrides))
  .command(createSetMintAuthorityCommand(overrides))
  .command(createTransferOwnershipCommand(overrides))
  .command(createTokenTransferCommand(overrides))
  .command(createSolanaCommand(overrides))
  .command(createHypeCommand(overrides))
  .command(createManualCommand(overrides))
  .help()
  .strict()
  .demandCommand()
  .parse();

export function checkConfigErrors(
  deps: Partial<{ [C in Chain]: Deployment<Chain> }>
): number {
  let fatal = 0;
  for (const [chain, deployment] of Object.entries(deps)) {
    assertChain(chain);
    const config = deployment.config.local!;
    if (!checkNumberFormatting(config.limits.outbound, deployment.decimals)) {
      console.error(
        `ERROR: ${chain} has an outbound limit (${config.limits.outbound}) with the wrong number of decimals. The number should have ${deployment.decimals} decimals.`
      );
      fatal++;
    }
    if (config.limits.outbound === formatNumber(0n, deployment.decimals)) {
      console.warn(colors.yellow(`${chain} has an outbound limit of 0`));
    }
    for (const [c, limit] of Object.entries(config.limits.inbound)) {
      if (!checkNumberFormatting(limit, deployment.decimals)) {
        console.error(
          `ERROR: ${chain} has an inbound limit with the wrong number of decimals for ${c} (${limit}). The number should have ${deployment.decimals} decimals.`
        );
        fatal++;
      }
      if (limit === formatNumber(0n, deployment.decimals)) {
        console.warn(
          colors.yellow(`${chain} has an inbound limit of 0 from ${c}`)
        );
      }
    }
  }
  return fatal;
}

export function createWorkTree(platform: Platform, version: string): string {
  const tag = getGitTagName(platform, version);
  if (!tag) {
    console.error(`No tag found matching ${version} for ${platform}`);
    process.exit(1);
  }

  const worktreeName = `.deployments/${platform}-${version}`;

  if (fs.existsSync(worktreeName)) {
    console.log(
      colors.yellow(
        `Worktree already exists at ${worktreeName}. Resetting to ${tag}`
      )
    );
    execSync(`git -C ${worktreeName} reset --hard ${tag}`, {
      stdio: "inherit",
    });
  } else {
    // create worktree
    execSync(`git worktree add ${worktreeName} ${tag}`, {
      stdio: "inherit",
    });
  }

  // NOTE: we create this symlink whether or not the file exists.
  // this way, if it's created later, the symlink will be correct
  execSync(
    `ln -fs $(pwd)/overrides.json $(pwd)/${worktreeName}/overrides.json`,
    {
      stdio: "inherit",
    }
  );

  console.log(
    colors.green(`Created worktree at ${worktreeName} from tag ${tag}`)
  );
  return worktreeName;
}

export async function upgrade<N extends Network, C extends Chain>(
  _fromVersion: string,
  toVersion: string | null,
  ntt: Ntt<N, C>,
  ctx: ChainContext<N, C>,
  signerType: SignerType,
  evmVerify: boolean,
  managerVariant?: string,
  solanaPayer?: string,
  solanaProgramKeyPath?: string,
  solanaBinaryPath?: string,
  gasEstimateMultiplier?: number
): Promise<void> {
  // TODO: check that fromVersion is safe to upgrade to toVersion from
  const platform = chainToPlatform(ctx.chain);
  const worktree = toVersion ? createWorkTree(platform, toVersion) : ".";
  switch (platform) {
    case "Evm":
      const evmNtt = ntt as EvmNtt<N, EvmChains>;
      const evmCtx = ctx as ChainContext<N, EvmChains>;
      return upgradeEvm(
        worktree,
        evmNtt,
        evmCtx,
        signerType,
        evmVerify,
        managerVariant,
        gasEstimateMultiplier
      );
    case "Solana":
      if (solanaPayer === undefined || !fs.existsSync(solanaPayer)) {
        console.error("Payer not found. Specify with --payer");
        process.exit(1);
      }
      const solanaNtt = ntt as SolanaNtt<N, SolanaChains>;
      const solanaCtx = ctx as ChainContext<N, SolanaChains>;
      return upgradeSolana(
        worktree,
        toVersion,
        solanaNtt,
        solanaCtx,
        solanaPayer,
        solanaProgramKeyPath,
        solanaBinaryPath
      );
    case "Sui":
      const suiNtt = ntt as SuiNtt<N, SuiChains>;
      const suiCtx = ctx as ChainContext<N, SuiChains>;
      return upgradeSui(worktree, toVersion, suiNtt, suiCtx, signerType);
    default:
      throw new Error("Unsupported platform");
  }
}

async function upgradeEvm<N extends Network, C extends EvmChains>(
  pwd: string,
  ntt: EvmNtt<N, C>,
  ctx: ChainContext<N, C>,
  signerType: SignerType,
  evmVerify: boolean,
  managerVariant?: string,
  gasEstimateMultiplier?: number
): Promise<void> {
  ensureNttRoot(pwd);

  console.log("Upgrading EVM chain", ctx.chain);

  const signer = await getSigner(ctx, signerType);
  const signerArgs = forgeSignerArgs(signer.source);

  console.log("Installing forge dependencies...");
  execSync("forge install", {
    cwd: `${pwd}/evm`,
    stdio: "pipe",
  });

  let verifyArgs: string = "";
  if (evmVerify) {
    const verifyArgsArray = buildVerifierArgs(ctx.chain);
    verifyArgs = verifyArgsArray.join(" ");
  }

  // Detect script version to determine upgrade strategy
  const scriptVersion = detectDeployScriptVersion(pwd);
  console.log(`Detected deploy script version: ${scriptVersion}`);

  // Validate manager variant support for upgrades
  const variant = managerVariant || "standard";
  if (variant !== "standard") {
    if (!supportsManagerVariants(pwd)) {
      console.error(
        `Manager variant '${variant}' is not supported in this version. ` +
          `The NttManagerNoRateLimiting.sol contract does not exist.`
      );
      process.exit(1);
    }
    if (scriptVersion < 2) {
      console.error(
        `Manager variant selection requires deploy script version 2+, but found version ${scriptVersion}. ` +
          `Please upgrade to a newer version that supports manager variants.`
      );
      process.exit(1);
    }
  }

  console.log("Upgrading manager...");
  const slowFlag = getSlowFlag(ctx.chain);
  const gasMultiplier = getGasMultiplier(gasEstimateMultiplier);

  // Use bundled v1 scripts if version 1 detected
  const useBundledV1 = scriptVersion === 1;

  await withDeploymentScript(pwd, useBundledV1, async () => {
    const command = `forge script --via-ir script/DeployWormholeNtt.s.sol \
--rpc-url "${ctx.config.rpc}" \
--sig "upgrade(address)" \
${ntt.managerAddress} \
${signerArgs} \
--broadcast ${slowFlag} ${gasMultiplier} \
${verifyArgs} | tee last-run.stdout`;

    execSync(command, {
      cwd: `${pwd}/evm`,
      stdio: "inherit",
      env: {
        ...process.env,
        MANAGER_VARIANT: variant,
      },
    });
  });
}

async function upgradeSolana<N extends Network, C extends SolanaChains>(
  pwd: string,
  version: string | null,
  ntt: SolanaNtt<N, C>,
  ctx: ChainContext<N, C>,
  payer: string,
  programKeyPath?: string,
  binaryPath?: string
): Promise<void> {
  if (version === null) {
    throw new Error("Cannot upgrade Solana to local version"); // TODO: this is not hard to enabled
  }
  const mint = (await ntt.getConfig()).mint;
  await deploySvm(
    pwd,
    version,
    await ntt.getMode(),
    ctx,
    mint.toBase58(),
    payer,
    false,
    programKeyPath,
    binaryPath
  );
  // TODO: call initializeOrUpdateLUT. currently it's done in the following 'ntt push' step.
}

async function upgradeSui<N extends Network, C extends SuiChains>(
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

// Helper function to perform complete package upgrade in a single PTB
async function performPackageUpgradeInPTB<
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

export async function deploy<N extends Network, C extends Chain>(
  version: string | null,
  mode: Ntt.Mode,
  ch: ChainContext<N, C>,
  token: string,
  signerType: SignerType,
  evmVerify: boolean,
  yes: boolean,
  managerVariant?: string,
  solanaPayer?: string,
  solanaProgramKeyPath?: string,
  solanaBinaryPath?: string,
  solanaPriorityFee?: number,
  suiGasBudget?: number,
  suiPackagePath?: string,
  suiWormholeState?: string,
  suiTreasuryCap?: string,
  gasEstimateMultiplier?: number,
  cclConfig?: CclConfig | null
): Promise<ChainAddress<C> | SuiDeploymentResult<C>> {
  if (version === null) {
    await warnLocalDeployment(yes);
  }
  const platform = chainToPlatform(ch.chain);
  const worktree = version ? createWorkTree(platform, version) : ".";
  switch (platform) {
    case "Evm":
      return await deployEvm(
        worktree,
        mode,
        ch,
        token,
        signerType,
        evmVerify,
        managerVariant || "standard",
        gasEstimateMultiplier,
        cclConfig
      );
    case "Solana":
      if (solanaPayer === undefined || !fs.existsSync(solanaPayer)) {
        console.error("Payer not found. Specify with --payer");
        process.exit(1);
      }
      const solanaCtx = ch as ChainContext<N, SolanaChains>;
      return (await deploySvm(
        worktree,
        version,
        mode,
        solanaCtx,
        token,
        solanaPayer,
        true,
        solanaProgramKeyPath,
        solanaBinaryPath,
        solanaPriorityFee
      )) as ChainAddress<C>;
    case "Sui":
      const suiCtx = ch as ChainContext<N, Chain>; // TODO: Use proper SuiChains type
      return (await deploySui(
        worktree,
        version,
        mode,
        suiCtx,
        token,
        signerType,
        true,
        evmVerify,
        suiGasBudget,
        suiPackagePath,
        suiWormholeState,
        suiTreasuryCap
      )) as any;
    default:
      throw new Error("Unsupported platform");
  }
}

async function deployEvm<N extends Network, C extends Chain>(
  pwd: string,
  mode: Ntt.Mode,
  ch: ChainContext<N, C>,
  token: string,
  signerType: SignerType,
  verify: boolean,
  managerVariant: string,
  gasEstimateMultiplier?: number,
  cclConfig?: CclConfig | null
): Promise<ChainAddress<C>> {
  ensureNttRoot(pwd);

  const wormhole = ch.config.contracts.coreBridge;
  if (!wormhole) {
    console.error("Core bridge not found");
    process.exit(1);
  }

  const rpc = ch.config.rpc;
  let provider: ethers.JsonRpcProvider;
  let decimals: number;

  try {
    provider = new ethers.JsonRpcProvider(rpc);
    const abi = ["function decimals() external view returns (uint8)"];
    const tokenContract = new ethers.Contract(token, abi, provider);
    decimals = await tokenContract.decimals();
  } catch (error) {
    handleDeploymentError(error, ch.chain, ch.network, rpc);
  }

  const modeUint = mode === "locking" ? 0 : 1;
  const signer = await getSigner(ch, signerType);
  const signerArgs = forgeSignerArgs(signer.source);

  let verifyArgs: string[] = [];
  if (verify) {
    verifyArgs = buildVerifierArgs(ch.chain);
  }

  console.log("Installing forge dependencies...");
  execSync("forge install", {
    cwd: `${pwd}/evm`,
    stdio: "pipe",
  });

  // Detect script version to determine deployment strategy
  const scriptVersion = detectDeployScriptVersion(pwd);
  console.log(`Detected deploy script version: ${scriptVersion}`);

  // Validate manager variant support
  if (managerVariant !== "standard") {
    if (!supportsManagerVariants(pwd)) {
      console.error(
        `Manager variant '${managerVariant}' is not supported in this version. ` +
          `The NttManagerNoRateLimiting.sol contract does not exist.`
      );
      process.exit(1);
    }
    if (scriptVersion < 2) {
      console.error(
        `Manager variant selection requires deploy script version 2+, but found version ${scriptVersion}. ` +
          `Please upgrade to a newer version that supports manager variants.`
      );
      process.exit(1);
    }
  }

  console.log("Deploying manager...");
  const deploy = async (simulate: boolean): Promise<string> => {
    const simulateArg = simulate ? "" : "--skip-simulation";
    const slowFlag = getSlowFlag(ch.chain);
    const gasMultiplier = getGasMultiplier(gasEstimateMultiplier);

    // Use bundled v1 scripts if version 1 detected
    const useBundledV1 = scriptVersion === 1;

    await withDeploymentScript(pwd, useBundledV1, async () => {
      try {
        let command: string;
        let env: NodeJS.ProcessEnv = { ...process.env };

        if (scriptVersion === 1) {
          // Version 1: Use explicit signature with parameters (6 params including relayers)
          // The bundled v1 scripts expect relayer addresses, use zero addresses as defaults
          const zeroAddress = "0x0000000000000000000000000000000000000000";
          const sig = "run(address,address,address,address,uint8,uint8)";
          command = `forge script --via-ir script/DeployWormholeNtt.s.sol \
--rpc-url "${rpc}" \
${simulateArg} \
--sig "${sig}" ${wormhole} ${token} ${zeroAddress} ${zeroAddress} ${decimals} ${modeUint} \
--broadcast ${slowFlag} ${gasMultiplier} ${verifyArgs.join(
            " "
          )} ${signerArgs} 2>&1 | tee last-run.stdout`;
        } else {
          // Version 2+: Use environment variables
          env = {
            ...env,
            RELEASE_CORE_BRIDGE_ADDRESS: wormhole,
            RELEASE_TOKEN_ADDRESS: token,
            RELEASE_DECIMALS: decimals.toString(),
            RELEASE_MODE: modeUint.toString(),
            RELEASE_CONSISTENCY_LEVEL: cclConfig ? "203" : "202",
            RELEASE_GAS_LIMIT: "500000",
            MANAGER_VARIANT: managerVariant,
          };

          // Add CCL-specific environment variables when CCL is enabled
          if (cclConfig) {
            env.RELEASE_CUSTOM_CONSISTENCY_LEVEL =
              cclConfig.customConsistencyLevel.toString();
            env.RELEASE_ADDITIONAL_BLOCKS =
              cclConfig.additionalBlocks.toString();
            env.RELEASE_CUSTOM_CONSISTENCY_LEVEL_ADDRESS =
              cclConfig.cclContractAddress;
          }

          command = `forge script --via-ir script/DeployWormholeNtt.s.sol \
--rpc-url "${rpc}" \
${simulateArg} \
--broadcast ${slowFlag} ${gasMultiplier} ${verifyArgs.join(
            " "
          )} ${signerArgs} 2>&1 | tee last-run.stdout`;
        }

        execSync(command, {
          cwd: `${pwd}/evm`,
          encoding: "utf8",
          stdio: "inherit",
          env,
        });
      } catch (error) {
        console.error("Failed to deploy manager");
        // NOTE: we don't exit here. instead, we check if the manager was
        // deployed successfully (below) and proceed if it was.
        // process.exit(1);
      }
    });
    return fs.readFileSync(`${pwd}/evm/last-run.stdout`).toString();
  };

  // we attempt to deploy with simulation first, then without if it fails
  let out = await deploy(true);
  if (out.includes("Simulated execution failed")) {
    if (out.includes("NotActivated")) {
      console.error(
        "Simulation failed, likely because the token contract is compiled against a different EVM version. It's probably safe to continue without simulation."
      );
      await askForConfirmation(
        "Do you want to proceed with the deployment without simulation?"
      );
    } else {
      console.error(
        "Simulation failed. Please read the error message carefully, and proceed with caution."
      );
      await askForConfirmation(
        "Do you want to proceed with the deployment without simulation?"
      );
    }
    out = await deploy(false);
  }

  if (!out) {
    console.error("Failed to deploy manager");
    process.exit(1);
  }
  const logs = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const manager = logs.find((l) => l.includes("NttManager: 0x"))?.split(" ")[1];
  if (!manager) {
    // Extract error lines from output to show the actual failure reason
    const errorLine = logs.find((l) => l.startsWith("Error:"));
    if (errorLine) {
      console.error(colors.red(`\nDeployment failed: ${errorLine}`));
    } else {
      console.error(colors.red("Manager not found in deployment output"));
    }
    process.exit(1);
  }
  const universalManager = toUniversal(ch.chain, manager);

  // Display CCL configuration summary if CCL was used
  if (cclConfig) {
    const levelNames: Record<number, string> = {
      200: "instant",
      201: "safe",
      202: "finalized",
    };
    console.log("");
    console.log(colors.cyan("Custom Consistency Level Configuration:"));
    console.log(colors.cyan(`  - Consistency Level: 203 (Custom)`));
    console.log(
      colors.cyan(
        `  - Base Finality: ${cclConfig.customConsistencyLevel} (${levelNames[cclConfig.customConsistencyLevel]})`
      )
    );
    console.log(
      colors.cyan(`  - Additional Blocks: ${cclConfig.additionalBlocks}`)
    );
    console.log(
      colors.cyan(`  - CCL Contract: ${cclConfig.cclContractAddress}`)
    );
    console.log("");
  }

  return { chain: ch.chain, address: universalManager };
}

/**
 * Check if the Solana program supports the bridge-address-from-env feature
 * @param pwd - Project root directory
 * @returns true if the feature exists in Cargo.toml
 */
function hasBridgeAddressFromEnvFeature(pwd: string): boolean {
  try {
    const cargoTomlPath = `${pwd}/solana/programs/example-native-token-transfers/Cargo.toml`;
    if (!fs.existsSync(cargoTomlPath)) {
      return false;
    }
    const cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
    // Check if bridge-address-from-env feature is defined
    return cargoToml.includes("bridge-address-from-env");
  } catch (error) {
    return false;
  }
}

/**
 * Build the Solana NTT program using anchor build.
 * Uses bridge-address-from-env feature if available, otherwise uses network-specific features.
 * For legacy builds on non-Solana chains, patches the binary after building.
 * @param pwd - Project root directory
 * @param network - Network to build for
 * @param chain - Target chain (used to determine if patching is needed)
 * @param wormhole - Wormhole core bridge address
 * @returns Exit code from anchor build
 */
async function runAnchorBuild(
  pwd: string,
  network: Network,
  chain: Chain,
  wormhole: string
): Promise<number> {
  checkAnchorVersion(pwd);

  const useBridgeFromEnv = hasBridgeAddressFromEnvFeature(pwd);

  let buildArgs: string[];
  let buildEnv: NodeJS.ProcessEnv;

  if (useBridgeFromEnv) {
    // New method: use bridge-address-from-env feature with BRIDGE_ADDRESS env var
    console.log(
      `Building with bridge-address-from-env feature (BRIDGE_ADDRESS=${wormhole})...`
    );
    buildArgs = [
      "anchor",
      "build",
      "-p",
      "example_native_token_transfers",
      "--",
      "--no-default-features",
      "--features",
      "bridge-address-from-env",
    ];
    buildEnv = {
      ...process.env,
      BRIDGE_ADDRESS: wormhole,
    };
  } else {
    // Old method: use network-specific feature (mainnet, solana-devnet, tilt-devnet)
    const networkFeature = cargoNetworkFeature(network);
    console.log(`Building with ${networkFeature} feature (legacy method)...`);
    buildArgs = [
      "anchor",
      "build",
      "-p",
      "example_native_token_transfers",
      "--",
      "--no-default-features",
      "--features",
      networkFeature,
    ];
    buildEnv = process.env;
  }

  const proc = Bun.spawn(buildArgs, {
    cwd: `${pwd}/solana`,
    env: buildEnv,
  });

  await proc.exited;
  const exitCode = proc.exitCode ?? 1;

  if (exitCode !== 0) {
    return exitCode;
  }

  // For legacy builds on non-Solana chains, patch the binary
  if (!useBridgeFromEnv && chain !== "Solana") {
    const binary = `${pwd}/solana/target/deploy/example_native_token_transfers.so`;

    // Get Solana mainnet address for patching
    const wh = new Wormhole(network, [solana.Platform], overrides);
    const sol = wh.getChain("Solana");
    const solanaAddress = sol.config.contracts.coreBridge;
    if (!solanaAddress) {
      console.error("Core bridge address not found in Solana config");
      return 1;
    }

    console.log(`Patching binary for ${chain}...`);
    await patchSolanaBinary(binary, wormhole, solanaAddress);
  }

  return exitCode;
}

/**
 * Build the Solana NTT program binary
 * @param pwd - Project root directory
 * @param network - Network to build for (affects cargo features)
 * @param chain - Target chain (for patching non-Solana chains)
 * @param wormhole - Wormhole core bridge address for verification
 * @param version - Version string for verification (optional)
 * @param programKeyPath - Optional path to program keypair (if not provided, will look for {programId}.json)
 * @param binaryPath - Optional path to pre-built binary (if provided, building is skipped)
 * @returns Object containing binary path, program ID, and program keypair path
 */
export async function buildSvm(
  pwd: string,
  network: Network,
  chain: Chain,
  wormhole: string,
  version: string | null,
  programKeyPath?: string,
  binaryPath?: string
): Promise<{ binary: string; programId: string; programKeypairPath: string }> {
  ensureNttRoot(pwd);
  checkSolanaVersion(pwd);

  // If binary is provided, still need to get program ID
  const existingProgramId = fs
    .readFileSync(`${pwd}/solana/Anchor.toml`)
    .toString()
    .match(/example_native_token_transfers = "(.*)"/)?.[1];
  if (!existingProgramId) {
    console.error(
      'Program ID not found in Anchor.toml (looked for example_native_token_transfers = "(.*)")'
    );
    process.exit(1);
  }

  let programKeypairPath: string;
  let programKeypair: Keypair;

  if (programKeyPath) {
    if (!fs.existsSync(programKeyPath)) {
      console.error(`Program keypair not found: ${programKeyPath}`);
      process.exit(1);
    }
    programKeypairPath = programKeyPath;
    programKeypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(programKeyPath).toString()))
    );
  } else {
    const programKeyJson = `${existingProgramId}.json`;
    if (!fs.existsSync(programKeyJson)) {
      console.error(`Program keypair not found: ${programKeyJson}`);
      console.error(
        "Run `solana-keygen` to create a new keypair (either with 'new', or with 'grind'), and pass it to this command with --program-key"
      );
      console.error(
        "For example: solana-keygen grind --starts-with ntt:1 --ignore-case"
      );
      process.exit(1);
    }
    programKeypairPath = programKeyJson;
    programKeypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(programKeyJson).toString()))
    );
    if (existingProgramId !== programKeypair.publicKey.toBase58()) {
      console.error(
        `The private key in ${programKeyJson} does not match the existing program ID: ${existingProgramId}`
      );
      process.exit(1);
    }
  }

  // see if the program key matches the existing program ID. if not, we need
  // to update the latter in the Anchor.toml file and the lib.rs file(s)
  const providedProgramId = programKeypair.publicKey.toBase58();
  if (providedProgramId !== existingProgramId) {
    // only ask for confirmation if the current directory is ".". if it's
    // something else (a worktree) then it's a fresh checkout and we just
    // override the address anyway.
    if (pwd === ".") {
      console.error(
        `Program keypair does not match the existing program ID: ${existingProgramId}`
      );
      await askForConfirmation(
        `Do you want to update the program ID in the Anchor.toml file and the lib.rs file to ${providedProgramId}?`
      );
    }

    const anchorTomlPath = `${pwd}/solana/Anchor.toml`;
    const libRsPath = `${pwd}/solana/programs/example-native-token-transfers/src/lib.rs`;

    const anchorToml = fs.readFileSync(anchorTomlPath).toString();
    const newAnchorToml = anchorToml.replace(
      existingProgramId,
      providedProgramId
    );
    fs.writeFileSync(anchorTomlPath, newAnchorToml);
    const libRs = fs.readFileSync(libRsPath).toString();
    const newLibRs = libRs.replace(existingProgramId, providedProgramId);
    fs.writeFileSync(libRsPath, newLibRs);
  }

  let binary: string;

  if (binaryPath) {
    console.log(`Using provided binary: ${binaryPath}`);
    binary = binaryPath;
  } else {
    // build the program
    console.log(`Building SVM program for ${network}...`);
    const exitCode = await runAnchorBuild(pwd, network, chain, wormhole);
    if (exitCode !== 0) {
      process.exit(exitCode);
    }

    binary = `${pwd}/solana/target/deploy/example_native_token_transfers.so`;
    console.log(`Build complete: ${binary}`);
  }

  // Verify the binary contains expected addresses and version
  console.log(`Verifying binary...`);
  await checkSvmBinary(
    binary,
    wormhole,
    providedProgramId,
    version ?? undefined
  );
  console.log(`✓ Binary verification passed`);

  return {
    binary,
    programId: providedProgramId,
    programKeypairPath,
  };
}

async function deploySvm<N extends Network, C extends SolanaChains>(
  pwd: string,
  version: string | null,
  mode: Ntt.Mode,
  ch: ChainContext<N, C>,
  token: string,
  payer: string,
  initialize: boolean,
  managerKeyPath?: string,
  binaryPath?: string,
  priorityFee?: number
): Promise<ChainAddress<C>> {
  const wormhole = ch.config.contracts.coreBridge;
  if (!wormhole) {
    console.error("Core bridge not found");
    process.exit(1);
  }

  // Build the Solana program (or use provided binary)
  const buildResult = await buildSvm(
    pwd,
    ch.network,
    ch.chain,
    wormhole,
    version,
    managerKeyPath,
    binaryPath
  );
  const {
    binary,
    programId: providedProgramId,
    programKeypairPath,
  } = buildResult;

  // First we check that the provided mint's mint authority is the program's token authority PDA when in burning mode.
  // This is checked in the program initialiser anyway, but we can save some
  // time by checking it here and failing early (not to mention better
  // diagnostics).

  const emitter = NTT.transceiverPdas(providedProgramId)
    .emitterAccount()
    .toBase58();
  const payerKeypair = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(payer).toString()))
  );

  // this is not super pretty... I want to initialise the 'ntt' object, but
  // because it's not deployed yet, fetching the version will fail, and thus default to whatever the default version is.
  // We want to use the correct version (because the sdk's behaviour depends on it), so we first create a dummy ntt instance,
  // let that fill in all the necessary fields, and then create a new instance with the correct version.
  // It should be possible to avoid this dummy object and just instantiate 'SolanaNtt' directly, but I wasn't
  // sure where the various pieces are plugged together and this seemed easier.
  // TODO: refactor this to avoid the dummy object
  const dummy: SolanaNtt<N, C> = (await ch.getProtocol("Ntt", {
    ntt: {
      manager: providedProgramId,
      token: token,
      transceiver: { wormhole: emitter },
    },
  })) as SolanaNtt<N, C>;

  const ntt: SolanaNtt<N, C> = new SolanaNtt(
    dummy.network,
    dummy.chain,
    dummy.connection,
    dummy.contracts,
    version ?? undefined
  );

  // get the mint authority of 'token'
  const tokenMint = new PublicKey(token);
  const connection: Connection = await ch.getRpc();
  let mintInfo;
  try {
    mintInfo = await connection.getAccountInfo(tokenMint);
  } catch (error) {
    handleDeploymentError(error, ch.chain, ch.network, ch.config.rpc);
  }
  if (!mintInfo) {
    console.error(`Mint ${token} not found on ${ch.chain} ${ch.network}`);
    process.exit(1);
  }
  const mint = spl.unpackMint(tokenMint, mintInfo, mintInfo.owner);
  const tokenAuthority = ntt.pdas.tokenAuthority();

  if (mode === "burning") {
    // verify mint authority is token authority or valid SPL Multisig
    const actualMintAuthority: string | null =
      mint.mintAuthority?.toBase58() ?? null;
    if (actualMintAuthority !== tokenAuthority.toBase58()) {
      const isValidSplMultisig =
        actualMintAuthority &&
        (await checkSvmValidSplMultisig(
          connection,
          new PublicKey(actualMintAuthority),
          mintInfo.owner,
          tokenAuthority
        ));
      if (!isValidSplMultisig) {
        console.error(`Mint authority mismatch for ${token}`);
        console.error(
          `Expected: ${tokenAuthority.toBase58()} or valid SPL Multisig`
        );
        console.error(`Actual: ${actualMintAuthority}`);
        console.error(
          `Set the mint authority to the program's token authority PDA with e.g.:`
        );
        console.error(
          `ntt set-mint-authority --token ${token} --manager ${providedProgramId} --chain Solana`
        );
        process.exit(1);
      }
    }
  }

  // Deploy the binary (patching was already done during build for legacy builds on non-Solana chains)
  const skipDeploy = false;

  if (!skipDeploy) {
    // if buffer.json doesn't exist, create it
    if (!fs.existsSync(`buffer.json`)) {
      execSync(`solana-keygen new -o buffer.json --no-bip39-passphrase`);
    } else {
      console.info("buffer.json already exists.");
      await askForConfirmation(
        "Do you want continue an exiting deployment? If not, delete the buffer.json file and run the command again."
      );
    }

    const deployCommand = [
      "solana",
      "program",
      "deploy",
      "--program-id",
      programKeypairPath,
      "--buffer",
      `buffer.json`,
      binary,
      "--keypair",
      payer,
      "-u",
      ch.config.rpc,
      "--commitment",
      "finalized",
    ];

    if (priorityFee !== undefined) {
      deployCommand.push("--with-compute-unit-price", priorityFee.toString());
    }

    const deployProc = Bun.spawn(deployCommand);

    const out = await new Response(deployProc.stdout).text();

    await deployProc.exited;

    if (deployProc.exitCode !== 0) {
      process.exit(deployProc.exitCode ?? 1);
    }

    // success. remove buffer.json
    fs.unlinkSync("buffer.json");

    console.log(out);
  }

  if (initialize) {
    // wait 3 seconds
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const tx = ntt.initialize(
      toUniversal(ch.chain, payerKeypair.publicKey.toBase58()),
      {
        mint: new PublicKey(token),
        mode,
        outboundLimit: 100000000n,
        ...(mode === "burning" &&
          !mint.mintAuthority!.equals(tokenAuthority) && {
            multisigTokenAuthority: mint.mintAuthority!,
          }),
      }
    );

    const signer = await getSigner(
      ch,
      "privateKey",
      encoding.b58.encode(payerKeypair.secretKey)
    );

    try {
      await signSendWait(ch, tx, signer.signer);
    } catch (e: any) {
      console.error(e.logs);
    }

    // After initialize, attempt to register the Wormhole transceiver
    try {
      await registerSolanaTransceiver(ntt as any, ch, signer);
    } catch (e: any) {
      console.error(e.logs);
    }
  }

  return { chain: ch.chain, address: toUniversal(ch.chain, providedProgramId) };
}

// Helper function to update Move.toml files for network-specific dependencies
function updateMoveTomlForNetwork(
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

async function deploySui<N extends Network, C extends Chain>(
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

export async function pushDeployment<C extends Chain>(
  deployment: Deployment<C>,
  signSendWaitFunc: ReturnType<typeof newSignSendWaiter>,
  signerType: SignerType,
  evmVerify: boolean,
  yes: boolean,
  filePath?: string,
  gasEstimateMultiplier?: number,
  dangerouslyTransferOwnershipInOneStep?: boolean
): Promise<void> {
  const diff = diffObjects(
    deployment.config.local!,
    deployment.config.remote!,
    EXCLUDED_DIFF_PATHS
  );
  if (Object.keys(diff).length === 0) {
    return;
  }

  const canonical = canonicalAddress(deployment.manager);
  console.log(`Pushing changes to ${deployment.manager.chain} (${canonical})`);

  console.log(colors.reset(colorizeDiff(diff)));
  if (!yes) {
    await askForConfirmation();
  }

  const ctx = deployment.ctx;

  const signer = await getSigner(ctx, signerType, undefined, filePath);

  let txs = [];
  // we perform this last to make sure we don't accidentally lock ourselves out
  let updateOwner: ReturnType<typeof deployment.ntt.setOwner> | undefined =
    undefined;
  let managerUpgrade: { from: string; to: string } | undefined;
  for (const k of Object.keys(diff)) {
    if (k === "version") {
      // TODO: check against existing version, and make sure no major version changes
      managerUpgrade = { from: diff[k]!.pull!, to: diff[k]!.push! };
    } else if (k === "owner") {
      const address: AccountAddress<C> = toUniversal(
        deployment.manager.chain,
        diff[k]?.push!
      );
      // For Solana, we need to use the low-level transfer ownership instructions
      if (chainToPlatform(deployment.manager.chain) === "Solana") {
        const solanaNtt = deployment.ntt as SolanaNtt<
          typeof deployment.ctx.config.network,
          SolanaChains
        >;
        const owner = new SolanaAddress(signer.address.address).unwrap();
        const newOwner = new SolanaAddress(address).unwrap();

        // Use one-step or two-step based on flag
        const ix = dangerouslyTransferOwnershipInOneStep
          ? await NTT.createTransferOwnershipOneStepUncheckedInstruction(
              solanaNtt.program,
              { owner, newOwner }
            )
          : await NTT.createTransferOwnershipInstruction(solanaNtt.program, {
              owner,
              newOwner,
            });

        const tx = new solanaWeb3.Transaction();
        tx.add(ix);
        tx.feePayer = owner;
        // Convert to AsyncGenerator format expected by updateOwner
        updateOwner = (async function* () {
          yield solanaNtt.createUnsignedTx(
            { transaction: tx },
            dangerouslyTransferOwnershipInOneStep
              ? "Transfer ownership (1-step)"
              : "Propose ownership transfer (2-step)"
          ) as UnsignedTransaction<any, any>;
        })();
      } else {
        updateOwner = deployment.ntt.setOwner(address, signer.address.address);
      }
    } else if (k === "pauser") {
      const address: AccountAddress<C> = toUniversal(
        deployment.manager.chain,
        diff[k]?.push!
      );
      txs.push(deployment.ntt.setPauser(address, signer.address.address));
    } else if (k === "paused") {
      if (diff[k]?.push === true) {
        txs.push(deployment.ntt.pause(signer.address.address));
      } else {
        txs.push(deployment.ntt.unpause(signer.address.address));
      }
    } else if (k === "limits") {
      const newOutbound = diff[k]?.outbound?.push;
      if (newOutbound) {
        // TODO: verify amount has correct number of decimals?
        // remove "." from string and convert to bigint
        const newOutboundBigint = BigInt(newOutbound.replace(".", ""));
        txs.push(
          deployment.ntt.setOutboundLimit(
            newOutboundBigint,
            signer.address.address
          )
        );
      }
      const inbound = diff[k]?.inbound;
      if (inbound) {
        for (const chain of Object.keys(inbound)) {
          assertChain(chain);
          const newInbound = inbound[chain]?.push;
          if (newInbound) {
            // TODO: verify amount has correct number of decimals?
            const newInboundBigint = BigInt(newInbound.replace(".", ""));
            txs.push(
              deployment.ntt.setInboundLimit(
                chain,
                newInboundBigint,
                signer.address.address
              )
            );
          }
        }
      }
    } else if (k === "transceivers") {
      // TODO: refactor this nested loop stuff into separate functions at least
      // alternatively we could first recursively collect all the things
      // to do into a flattened list (with entries like
      // transceivers.wormhole.pauser), and have a top-level mapping of
      // these entries to how they should be handled
      for (const j of Object.keys(diff[k] as object)) {
        if (j === "threshold") {
          const newThreshold = diff[k]![j]!.push;
          if (newThreshold !== undefined) {
            txs.push(
              deployment.ntt.setThreshold(newThreshold, signer.address.address)
            );
          }
        } else if (j === "wormhole") {
          for (const l of Object.keys(diff[k]![j] as object)) {
            if (l === "pauser") {
              const newTransceiverPauser = toUniversal(
                deployment.manager.chain,
                diff[k]![j]![l]!.push!
              );
              txs.push(
                deployment.whTransceiver.setPauser(
                  newTransceiverPauser,
                  signer.address.address
                )
              );
            } else {
              console.error(`Unsupported field: ${k}.${j}.${l}`);
              process.exit(1);
            }
          }
        } else {
          console.error(`Unsupported field: ${k}.${j}`);
          process.exit(1);
        }
      }
    } else {
      console.error(`Unsupported field: ${k}`);
      process.exit(1);
    }
  }
  if (managerUpgrade) {
    await upgrade(
      managerUpgrade.from,
      managerUpgrade.to,
      deployment.ntt,
      ctx,
      signerType,
      evmVerify,
      undefined,
      undefined,
      undefined,
      undefined,
      gasEstimateMultiplier
    );
  }
  for (const tx of txs) {
    await signSendWaitFunc(ctx, tx, signer.signer);
  }
  if (updateOwner) {
    await signSendWaitFunc(ctx, updateOwner, signer.signer);
  }
}

export async function pullDeployments(
  deployments: Config,
  network: Network,
  verbose: boolean
): Promise<Partial<{ [C in Chain]: Deployment<Chain> }>> {
  let deps: Partial<{ [C in Chain]: Deployment<Chain> }> = {};

  for (const [chain, deployment] of Object.entries(deployments.chains)) {
    if (verbose) {
      process.stdout.write(`Fetching config for ${chain}......\n`);
    }
    assertChain(chain);
    const managerAddress: string | undefined = deployment.manager;
    if (managerAddress === undefined) {
      console.error(`manager field not found for chain ${chain}`);
      // process.exit(1);
      continue;
    }
    const [remote, ctx, ntt, decimals] = await pullChainConfig(
      network,
      { chain, address: toUniversal(chain, managerAddress) },
      overrides
    );
    const local = deployments.chains[chain];

    // TODO: what if it's not index 0...
    // we should check that the address of this transceiver matches the
    // address in the config. currently we just assume that ix 0 is the wormhole one
    const whTransceiver = await ntt.getTransceiver(0);
    if (whTransceiver === null) {
      console.error(`Wormhole transceiver not found for ${chain}`);
      process.exit(1);
    }

    deps[chain] = {
      ctx,
      ntt,
      decimals,
      manager: { chain, address: toUniversal(chain, managerAddress) },
      whTransceiver,
      config: {
        remote,
        local,
      },
    };
  }

  const config = Object.fromEntries(
    Object.entries(deps).map(([k, v]) => [k, v.config.remote])
  );
  const ntts = Object.fromEntries(
    Object.entries(deps).map(([k, v]) => [k, v.ntt])
  );
  await pullInboundLimits(ntts, config, verbose);
  return deps;
}

export async function pullChainConfig<N extends Network, C extends Chain>(
  network: N,
  manager: ChainAddress<C>,
  overrides?: WormholeConfigOverrides<N>
): Promise<
  [ChainConfig, ChainContext<typeof network, C>, Ntt<typeof network, C>, number]
> {
  const wh = new Wormhole(
    network,
    [solana.Platform, evm.Platform, sui.Platform],
    overrides
  );
  const ch = wh.getChain(manager.chain);

  const nativeManagerAddress = canonicalAddress(manager);

  const {
    ntt,
    addresses,
  }: { ntt: Ntt<N, C>; addresses: Partial<Ntt.Contracts> } =
    await nttFromManager<N, C>(ch, nativeManagerAddress);

  const mode = await ntt.getMode();
  const outboundLimit = await ntt.getOutboundLimit();
  const threshold = await ntt.getThreshold();

  const decimals = await ntt.getTokenDecimals();
  // insert decimal point into number
  const outboundLimitDecimals = formatNumber(outboundLimit, decimals);

  const paused = await ntt.isPaused();
  const owner = await ntt.getOwner();
  const pauser = await ntt.getPauser();

  const version = getVersion(manager.chain, ntt);

  const transceiverPauser = await ntt
    .getTransceiver(0)
    .then((t) => t?.getPauser() ?? null);

  const config: ChainConfig = {
    version,
    mode,
    paused,
    owner: owner.toString(),
    manager: nativeManagerAddress,
    token: addresses.token!,
    transceivers: {
      threshold,
      wormhole: { address: addresses.transceiver!.wormhole! },
    },
    limits: {
      outbound: outboundLimitDecimals,
      inbound: {},
    },
  };
  if (transceiverPauser) {
    config.transceivers.wormhole.pauser = transceiverPauser.toString();
  }
  if (pauser) {
    config.pauser = pauser.toString();
  }
  return [config, ch, ntt, decimals];
}

export async function getImmutables<N extends Network, C extends Chain>(
  chain: C,
  ntt: Ntt<N, C>
) {
  const platform = chainToPlatform(chain);
  if (platform !== "Evm") {
    return null;
  }
  const evmNtt = ntt as EvmNtt<N, EvmChains>;
  const transceiver = (await evmNtt.getTransceiver(
    0
  )) as EvmNttWormholeTranceiver<N, EvmChains>;
  const consistencyLevel = await transceiver.transceiver.consistencyLevel();

  const token = await evmNtt.manager.token();
  const tokenDecimals = await evmNtt.manager.tokenDecimals();

  // Fetch CCL parameters if consistency level is 203 (custom)
  let customConsistencyLevel: bigint | undefined;
  let additionalBlocks: bigint | undefined;
  let customConsistencyLevelAddress: string | undefined;

  if (consistencyLevel === 203n) {
    try {
      customConsistencyLevel =
        await transceiver.transceiver.customConsistencyLevel();
      additionalBlocks = await transceiver.transceiver.additionalBlocks();
      customConsistencyLevelAddress =
        await transceiver.transceiver.customConsistencyLevelAddress();
    } catch (error) {
      // CCL parameters might not be available in older versions
      console.warn("Warning: Could not fetch CCL parameters from transceiver");
    }
  }

  const whTransceiverImmutables = {
    consistencyLevel,
    ...(customConsistencyLevel !== undefined && { customConsistencyLevel }),
    ...(additionalBlocks !== undefined && { additionalBlocks }),
    ...(customConsistencyLevelAddress !== undefined && {
      customConsistencyLevelAddress,
    }),
  };
  return {
    manager: {
      token,
      tokenDecimals,
    },
    wormholeTransceiver: whTransceiverImmutables,
  };
}

export async function getPdas<N extends Network, C extends Chain>(
  chain: C,
  ntt: Ntt<N, C>
) {
  const platform = chainToPlatform(chain);
  if (platform !== "Solana") {
    return null;
  }
  const solanaNtt = ntt as SolanaNtt<N, SolanaChains>;
  const config = solanaNtt.pdas.configAccount();
  const emitter = NTT.transceiverPdas(
    solanaNtt.program.programId
  ).emitterAccount();
  const outboxRateLimit = solanaNtt.pdas.outboxRateLimitAccount();
  const tokenAuthority = solanaNtt.pdas.tokenAuthority();
  const lutAccount = solanaNtt.pdas.lutAccount();
  const lutAuthority = solanaNtt.pdas.lutAuthority();

  return {
    config,
    emitter,
    outboxRateLimit,
    tokenAuthority,
    lutAccount,
    lutAuthority,
  };
}

export function getVersion<N extends Network, C extends Chain>(
  chain: C,
  ntt: Ntt<N, C>
): string {
  const platform = chainToPlatform(chain);
  switch (platform) {
    case "Evm":
      return (ntt as EvmNtt<N, EvmChains>).version;
    case "Solana":
      return (ntt as SolanaNtt<N, SolanaChains>).version;
    case "Sui":
      // For Sui, return a default version since version property is not implemented yet
      return "dev";
    default:
      throw new Error("Unsupported platform");
  }
}

// TODO: there should be a more elegant way to do this, than creating a
// "dummy" NTT, then calling verifyAddresses to get the contract diff, then
// finally reconstructing the "real" NTT object from that
export async function nttFromManager<N extends Network, C extends Chain>(
  ch: ChainContext<N, C>,
  nativeManagerAddress: string
): Promise<{ ntt: Ntt<N, C>; addresses: Partial<Ntt.Contracts> }> {
  const onlyManager = await ch.getProtocol("Ntt", {
    ntt: {
      manager: nativeManagerAddress,
      transceiver: {},
    },
  });
  const diff = await onlyManager.verifyAddresses();

  const addresses: Partial<Ntt.Contracts> = {
    manager: nativeManagerAddress,
    ...diff,
  };

  // For other chains, use the standard protocol creation
  const ntt = await ch.getProtocol("Ntt", {
    ntt: addresses,
  });
  return { ntt, addresses };
}

function formatNumber(num: bigint, decimals: number) {
  if (num === 0n) {
    return "0." + "0".repeat(decimals);
  }
  const str = num.toString();
  const formatted = str.slice(0, -decimals) + "." + str.slice(-decimals);
  if (formatted.startsWith(".")) {
    return "0" + formatted;
  }
  return formatted;
}

function checkNumberFormatting(formatted: string, decimals: number): boolean {
  // check that the string has the correct number of decimals
  const parts = formatted.split(".");
  if (parts.length !== 2) {
    return false;
  }
  if (parts[1].length !== decimals) {
    return false;
  }
  return true;
}

function cargoNetworkFeature(network: Network): string {
  switch (network) {
    case "Mainnet":
      return "mainnet";
    case "Testnet":
      return "solana-devnet";
    case "Devnet":
      return "tilt-devnet";
    default:
      throw new Error("Unsupported network");
  }
}

export async function askForConfirmation(
  prompt: string = "Do you want to continue?"
): Promise<void> {
  const confirmed = await promptYesNo(prompt);
  if (!confirmed) {
    console.log("Aborting");
    process.exit(0);
  }
}

// NOTE: modifies the config object in place
// TODO: maybe introduce typestate for having pulled inbound limits?
export async function pullInboundLimits(
  ntts: Partial<{ [C in Chain]: Ntt<Network, C> }>,
  config: Config["chains"],
  verbose: boolean
) {
  for (const [c1, ntt1] of Object.entries(ntts)) {
    assertChain(c1);
    const chainConf = config[c1];
    if (!chainConf) {
      console.error(`Chain ${c1} not found in deployment`);
      process.exit(1);
    }
    const decimals = await ntt1.getTokenDecimals();
    for (const [c2, ntt2] of Object.entries(ntts)) {
      assertChain(c2);
      if (ntt1 === ntt2) {
        continue;
      }
      if (verbose) {
        process.stdout.write(
          `Fetching inbound limit for ${c1} -> ${c2}.......\n`
        );
      }
      const peer = await retryWithExponentialBackoff(
        () => ntt1.getPeer(c2),
        5,
        5000
      );
      if (chainConf.limits?.inbound === undefined) {
        chainConf.limits.inbound = {};
      }

      const limit = peer?.inboundLimit ?? 0n;

      chainConf.limits.inbound[c2] = formatNumber(limit, decimals);
    }
  }
}

async function patchSolanaBinary(
  binary: string,
  wormhole: string,
  solanaAddress: string
) {
  // Ensure binary path exists
  if (!fs.existsSync(binary)) {
    console.error(`.so file not found: ${binary}`);
    process.exit(1);
  }

  // Convert addresses from base58 to Buffer
  const wormholeBuffer = new PublicKey(wormhole).toBuffer();
  const solanaAddressBuffer = new PublicKey(solanaAddress).toBuffer();

  // Read the binary file
  let binaryData = fs.readFileSync(binary);

  // Find and count occurrences of core bridge address
  let occurrences = 0;
  let searchIndex = 0;

  // Replace all occurrences of core bridge with wormhole
  searchIndex = 0;
  while (true) {
    const index = binaryData.indexOf(solanaAddressBuffer, searchIndex);
    if (index === -1) break;
    occurrences++;

    // Replace the bytes at this position
    wormholeBuffer.copy(binaryData, index);
    searchIndex = index + solanaAddressBuffer.length;
  }

  // Write the patched binary back to file
  fs.writeFileSync(binary, binaryData);

  if (occurrences > 0) {
    console.log(
      `Patched binary, replacing ${solanaAddress} with ${wormhole} in ${occurrences} places.`
    );
  }
}

async function checkSvmBinary(
  binary: string,
  wormhole: string,
  providedProgramId: string,
  version?: string
) {
  // ensure binary path exists
  if (!fs.existsSync(binary)) {
    console.error(`.so file not found: ${binary}`);
    process.exit(1);
  }

  // convert addresses from base58 to Buffer
  const wormholeBuffer = new PublicKey(wormhole).toBuffer();
  const providedProgramIdBuffer = new PublicKey(providedProgramId).toBuffer();
  const versionBuffer = version ? Buffer.from(version, "utf8") : undefined;

  if (!searchBufferInBinary(binary, wormholeBuffer)) {
    console.error(`Wormhole address not found in binary: ${wormhole}`);
    process.exit(1);
  }
  if (!searchBufferInBinary(binary, providedProgramIdBuffer)) {
    console.error(
      `Provided program ID not found in binary: ${providedProgramId}`
    );
    process.exit(1);
  }
  if (versionBuffer && !searchBufferInBinary(binary, versionBuffer)) {
    // TODO: figure out how to search for the version string in the binary
    // console.error(`Version string not found in binary: ${version}`);
    // process.exit(1);
  }
}

// Search for a buffer pattern within a binary file using direct buffer operations
function searchBufferInBinary(
  binaryPath: string,
  searchBuffer: Buffer
): boolean {
  const binaryData = fs.readFileSync(binaryPath);
  return binaryData.indexOf(searchBuffer) !== -1;
}

function getSlowFlag(chain: Chain): string {
  return chain === "Mezo" ||
    chain === "HyperEVM" ||
    chain == "XRPLEVM" ||
    chain === "CreditCoin"
    ? "--slow"
    : "";
}

function getGasMultiplier(userMultiplier?: number): string {
  if (userMultiplier !== undefined) {
    return `--gas-estimate-multiplier ${userMultiplier}`;
  }

  return "";
}

// Re-export ensureNttRoot from validation (moved there to fix circular dependency)
export { ensureNttRoot } from "./validation";

// Check Solana toolchain version against Anchor.toml requirements
function checkSolanaVersion(pwd: string): void {
  try {
    // Read required version from Anchor.toml
    const anchorToml = fs.readFileSync(`${pwd}/solana/Anchor.toml`, "utf8");
    const versionMatch = anchorToml.match(/solana_version = "(.+)"/);

    if (!versionMatch) {
      console.warn(
        colors.yellow("Warning: Could not find solana_version in Anchor.toml")
      );
      return;
    }

    const requiredVersion = versionMatch[1];

    // Get current Solana version and detect client type
    let currentVersion: string;
    let clientType: "agave" | "solanalabs";
    try {
      const output = execSync("solana --version", {
        encoding: "utf8",
        stdio: "pipe",
      });
      const versionMatch = output.match(/solana-cli (\d+\.\d+\.\d+)/);
      if (!versionMatch) {
        console.error(colors.red("Error: Could not parse solana CLI version"));
        process.exit(1);
      }
      currentVersion = versionMatch[1];

      // Detect client type
      if (output.includes("Agave")) {
        clientType = "agave";
      } else if (output.includes("SolanaLabs")) {
        clientType = "solanalabs";
      } else {
        // Default to agave if we can't detect
        clientType = "agave";
      }
    } catch (error) {
      console.error(
        colors.red(
          "Error: solana CLI not found. Please install the Solana toolchain."
        )
      );
      console.error(
        colors.yellow(
          'Install with: sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"'
        )
      );
      process.exit(1);
    }

    if (currentVersion !== requiredVersion) {
      console.log(colors.yellow(`Solana version mismatch detected:`));
      console.log(
        colors.yellow(`  Required: ${requiredVersion} (from Anchor.toml)`)
      );
      console.log(colors.yellow(`  Current:  ${currentVersion}`));
      console.log(colors.yellow(`\nSwitching to required version...`));

      // Run the appropriate version switch command
      const installCommand =
        clientType === "agave"
          ? `agave-install init ${requiredVersion}`
          : `solana-install init ${requiredVersion}`;

      try {
        execSync(installCommand, { stdio: "inherit" });
        console.log(
          colors.green(
            `Successfully switched to Solana version ${requiredVersion}`
          )
        );
      } catch (error) {
        console.error(
          colors.red(`Failed to switch Solana version using ${installCommand}`)
        );
        console.error(colors.red(`Please run manually: ${installCommand}`));
        process.exit(1);
      }
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      console.warn(colors.yellow("Warning: Could not read Anchor.toml file"));
    } else {
      console.warn(
        colors.yellow(
          `Warning: Failed to check Solana version: ${
            error instanceof Error ? error.message : error
          }`
        )
      );
    }
  }
}

function checkAnchorVersion(pwd: string) {
  try {
    // Read required version from Anchor.toml
    const anchorToml = fs.readFileSync(`${pwd}/solana/Anchor.toml`, "utf8");
    const versionMatch = anchorToml.match(/anchor_version = "(.+)"/);

    if (!versionMatch) {
      console.error(
        colors.red("Error: Could not find anchor_version in Anchor.toml")
      );
      process.exit(1);
    }

    const expected = versionMatch[1];

    // Check if Anchor CLI is installed
    try {
      execSync("which anchor");
    } catch {
      console.error(
        "Anchor CLI is not installed.\nSee https://www.anchor-lang.com/docs/installation"
      );
      process.exit(1);
    }

    // Get current Anchor version
    const version = execSync("anchor --version").toString().trim();
    // version looks like "anchor-cli 0.14.0"
    const [_, v] = version.split(" ");
    if (v !== expected) {
      console.error(colors.red(`Anchor CLI version mismatch!`));
      console.error(colors.red(`  Required: ${expected} (from Anchor.toml)`));
      console.error(colors.red(`  Current:  ${v}`));
      console.error(
        colors.yellow(`\nTo fix this, install the correct version of Anchor`)
      );
      console.error(
        colors.gray("See https://www.anchor-lang.com/docs/installation")
      );
      process.exit(1);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      console.error(colors.red("Error: Could not read Anchor.toml file"));
      console.error(
        colors.yellow(`Expected file at: ${pwd}/solana/Anchor.toml`)
      );
      process.exit(1);
    } else {
      throw error;
    }
  }
}

export function resolveVersion(
  latest: boolean,
  ver: string | undefined,
  local: boolean,
  platform: Platform
): string | null {
  if ((latest ? 1 : 0) + (ver ? 1 : 0) + (local ? 1 : 0) !== 1) {
    console.error("Specify exactly one of --latest, --ver, or --local");
    const available = getAvailableVersions(platform);
    console.error(
      `Available versions for ${platform}:\n${available.join("\n")}`
    );
    process.exit(1);
  }
  if (latest) {
    const available = getAvailableVersions(platform);
    return available.sort().reverse()[0];
  } else if (ver) {
    return ver;
  } else {
    // local version
    return null;
  }
}

export function warnLocalDeployment(yes: boolean): Promise<void> {
  if (!yes) {
    console.warn(
      colors.yellow(
        "WARNING: You are deploying from your local working directory."
      )
    );
    console.warn(
      colors.yellow(
        "This bypasses version control and may deploy untested changes."
      )
    );
    console.warn(
      colors.yellow(
        "Ensure your local changes are thoroughly tested and compatible."
      )
    );
    return askForConfirmation(
      "Are you sure you want to continue with the local deployment?"
    );
  }
  return Promise.resolve();
}

export function validateChain<N extends Network, C extends Chain>(
  network: N,
  chain: C
) {
  if (network === "Testnet") {
    if (chain === "Ethereum") {
      console.error(
        "Ethereum is deprecated on Testnet. Use EthereumSepolia instead."
      );
      process.exit(1);
    }
    // if on testnet, and the chain has a *Sepolia counterpart, use that instead
    if (chains.find((c) => c === `${c}Sepolia`)) {
      console.error(
        `Chain ${chain} is deprecated. Use ${chain}Sepolia instead.`
      );
      process.exit(1);
    }
  }
}

function buildVerifierArgs(chain: Chain): string[] {
  const verifier = configuration.get(chain, "verifier", { reportError: true });
  const verifierType = verifier || "etherscan";

  if (verifierType === "blockscout") {
    const verifierUrl = configuration.get(chain, "verifier_url", {
      reportError: true,
    });
    if (!verifierUrl) {
      console.error(
        `verifier_url is required when using blockscout verifier for ${chain}`
      );
      process.exit(1);
    }

    return [
      "--verify",
      "--verifier",
      "blockscout",
      "--verifier-url",
      verifierUrl,
    ];
  } else if (verifierType === "sourcify") {
    const verifierUrl = configuration.get(chain, "verifier_url", {
      reportError: true,
    });
    if (!verifierUrl) {
      console.error(
        `verifier_url is required when using sourcify verifier for ${chain}`
      );
      process.exit(1);
    }

    return [
      "--verify",
      "--verifier",
      "sourcify",
      "--verifier-url",
      verifierUrl,
    ];
  } else {
    const apiKey = configuration.get(chain, "scan_api_key", {
      reportError: true,
    });
    if (!apiKey) {
      process.exit(1);
    }

    return ["--verify", "--etherscan-api-key", apiKey];
  }
}

function nttVersion(): {
  version: string;
  commit: string;
  path: string;
  remote: string;
} | null {
  const nttDir = `${process.env.HOME}/.ntt-cli`;
  try {
    const versionFile = fs.readFileSync(`${nttDir}/version`).toString().trim();
    const [commit, installPath, version, remote] = versionFile.split("\n");
    return { version, commit, path: installPath, remote };
  } catch {
    return null;
  }
}

export async function checkSvmValidSplMultisig(
  connection: Connection,
  address: PublicKey,
  programId: PublicKey,
  tokenAuthority: PublicKey
): Promise<boolean> {
  let isMultisigTokenAuthority = false;
  try {
    const multisigInfo = await spl.getMultisig(
      connection,
      address,
      undefined,
      programId
    );
    if (multisigInfo.m === 1) {
      const n = multisigInfo.n;
      for (let i = 0; i < n; ++i) {
        // TODO: not sure if there's an easier way to loop through and check
        if (
          (
            multisigInfo[`signer${i + 1}` as keyof spl.Multisig] as PublicKey
          ).equals(tokenAuthority)
        ) {
          isMultisigTokenAuthority = true;
          break;
        }
      }
    }
  } catch {}
  return isMultisigTokenAuthority;
}
