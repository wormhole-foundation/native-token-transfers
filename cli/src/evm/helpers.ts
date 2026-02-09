import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import type { Chain } from "@wormhole-foundation/sdk";
import * as configuration from "../configuration";
import { ensureNttRoot } from "../validation";

/**
 * When deploying old NTT versions (version 1 scripts), this function overrides the evm/script/ directory with
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
export async function withDeploymentScript<A>(
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
export function detectDeployScriptVersion(pwd: string): number {
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
export function supportsManagerVariants(pwd: string): boolean {
  const noRateLimitingPath = `${pwd}/evm/src/NttManager/NttManagerNoRateLimiting.sol`;
  return fs.existsSync(noRateLimitingPath);
}

export function getSlowFlag(chain: Chain): string {
  return chain === "Mezo" ||
    chain === "HyperEVM" ||
    chain == "XRPLEVM" ||
    chain === "CreditCoin"
    ? "--slow"
    : "";
}

export function getGasMultiplier(userMultiplier?: number): string {
  if (userMultiplier !== undefined) {
    return `--gas-estimate-multiplier ${userMultiplier}`;
  }

  return "";
}

export function buildVerifierArgs(chain: Chain): string[] {
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
