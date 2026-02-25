import {
  chains,
  networks,
  platforms,
  type Chain,
  type ChainAddress,
  type Network,
} from "@wormhole-foundation/sdk";
import { colors } from "../colors.js";
import { promptYesNo } from "../prompts.js";

// Cap for the parallel lane of read-only RPC calls; the sequential Solana lane
// runs alongside it, so total in-flight can be this value + 1.
// Override with --rpc-concurrency.
export const DEFAULT_PARALLEL_CONCURRENCY = 6;

// Reusable yargs option definitions shared across commands
export const options = {
  network: {
    alias: "n",
    describe: "Network",
    choices: networks,
    demandOption: true,
  },
  deploymentPath: {
    alias: "p",
    describe: "Path to the deployment file",
    default: "deployment.json",
    type: "string",
  },
  yes: {
    alias: "y",
    describe: "Skip confirmation",
    type: "boolean",
    default: false,
  },
  signerType: {
    alias: "s",
    describe: "Signer type",
    type: "string",
    choices: ["privateKey", "ledger"],
    default: "privateKey",
  },
  verbose: {
    alias: "v",
    describe: "Verbose output",
    type: "boolean",
    default: false,
  },
  chain: {
    describe: "Chain",
    type: "string",
    choices: chains,
    demandOption: true,
  },
  address: {
    describe: "Address",
    type: "string",
    demandOption: true,
  },
  local: {
    describe: "Use the current local version for deployment (advanced).",
    type: "boolean",
    default: false,
  },
  version: {
    describe: "Version of NTT to deploy",
    type: "string",
    demandOption: false,
  },
  latest: {
    describe: "Use the latest version",
    type: "boolean",
    default: false,
  },
  platform: {
    describe: "Platform",
    type: "string",
    choices: platforms,
    demandOption: true,
  },
  skipVerify: {
    describe: "Skip contract verification",
    type: "boolean",
    default: false,
  },
  gasEstimateMultiplier: {
    describe: "Gas estimate multiplier for EVM deployments (e.g., 200 for 2x)",
    type: "number",
  },
  payer: {
    describe: "Path to the payer json file (SVM)",
    type: "string",
  },
  skipChain: {
    describe: "Skip chains",
    type: "array",
    choices: chains,
  },
  onlyChain: {
    describe: "Only do these chains (can be skipped)",
    type: "array",
    choices: chains,
  },
  rpcConcurrency: {
    describe:
      "Max concurrent read-only RPC calls for the parallel lane (sequential chains like Solana run alongside it, so total in-flight can be +1)",
    type: "number",
    default: DEFAULT_PARALLEL_CONCURRENCY,
  },
} as const;

// Custom Consistency Level (CCL) configuration
export type CclConfig = {
  customConsistencyLevel: number; // 200, 201, or 202
  additionalBlocks: number;
  cclContractAddress: string;
};

// Known CCL contract addresses by chain and network
export const CCL_CONTRACT_ADDRESSES: Partial<
  Record<Network, Partial<Record<Chain, string>>>
> = {
  Testnet: {
    Sepolia: "0x6A4B4A882F5F0a447078b4Fd0b4B571A82371ec2",
    Linea: "0x6A4B4A882F5F0a447078b4Fd0b4B571A82371ec2",
  },
  Mainnet: {
    // Add mainnet addresses here when available
  },
};

// Configuration fields that should be excluded from diff operations
// These are local-only configurations that don't have on-chain representations
export const EXCLUDED_DIFF_PATHS = ["managerVariant"];

// Extended ChainAddress type for Sui deployments that includes additional metadata
export type SuiDeploymentResult<C extends Chain> = ChainAddress<C> & {
  adminCaps?: {
    wormholeTransceiver?: string;
  };
  transceiverStateIds?: {
    wormhole?: string;
  };
  packageIds?: {
    ntt?: string;
    nttCommon?: string;
    wormholeTransceiver?: string;
  };
};

// Helper functions for nested object access
export function getNestedValue(obj: any, path: string[]): any {
  return path.reduce((current, key) => current?.[key], obj);
}

export function setNestedValue(obj: any, path: string[], value: any): void {
  const lastKey = path.pop()!;
  const target = path.reduce((current, key) => {
    if (!current[key]) current[key] = {};
    return current[key];
  }, obj);
  target[lastKey] = value;
}

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

/** Resolve and validate the --rpc-concurrency flag. */
export function resolveRpcConcurrency(raw: unknown): number {
  if (Array.isArray(raw)) {
    console.error("--rpc-concurrency may only be specified once");
    process.exit(1);
  }
  if (raw === undefined) {
    return DEFAULT_PARALLEL_CONCURRENCY;
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error("--rpc-concurrency must be a positive number");
    process.exit(1);
  }
  return Math.max(1, Math.floor(value));
}
