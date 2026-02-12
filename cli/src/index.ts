#!/usr/bin/env bun
import "./side-effects"; // doesn't quite work for silencing the bigint error message. why?
import type { Network } from "@wormhole-foundation/sdk-connect";
import type { WormholeConfigOverrides } from "@wormhole-foundation/sdk-connect";
import fs from "fs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import "@wormhole-foundation/sdk-evm-ntt";
import "@wormhole-foundation/sdk-solana-ntt";
import "@wormhole-foundation/sdk-sui-ntt";
import "@wormhole-foundation/sdk-definitions-ntt";

import { createTokenTransferCommand } from "./commands/token-transfer";
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
import { loadOverrides } from "./overrides.js";

// TODO: check if manager can mint the token in burning mode (on solana it's
// simple. on evm we need to simulate with prank)
const overrides: WormholeConfigOverrides<Network> = loadOverrides();

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

// ── Re-exports for backward compatibility ────────────────────────────
// Commands import from "../index" — keep these re-exports so nothing breaks.

// Type re-exports
export type { ChainConfig, Config } from "./deployments";
export type { Deployment } from "./validation";
export type { SuiDeploymentResult } from "./commands/shared";

// Re-exports from query.ts
export {
  getImmutables,
  getPdas,
  getVersion,
  nttFromManager,
  formatNumber,
  checkNumberFormatting,
  pullInboundLimits,
} from "./query";

// Re-exports from validation.ts
export { ensureNttRoot, validateChain, checkConfigErrors } from "./validation";

// Re-exports from solana/helpers.ts
export { checkSvmValidSplMultisig } from "./solana/helpers";

// Re-exports from prompts.ts
export { askForConfirmation } from "./prompts";

// Re-exports from tag.ts
export { resolveVersion, createWorkTree, warnLocalDeployment } from "./tag";

// Re-exports from commands/shared.ts
export { parseCclFlag, confirmCustomFinality } from "./commands/shared";

// Re-exports from deploy.ts
export { deploy, upgrade } from "./deploy";

// Re-exports from solana/deploy.ts
export { buildSvm } from "./solana/deploy";

// Re-exports from config-mgmt.ts
export {
  pushDeployment,
  pullDeployments,
  pullChainConfig,
} from "./config-mgmt";
