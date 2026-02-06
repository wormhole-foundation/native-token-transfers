import {
  chains,
  networks,
  platforms,
  type Chain,
  type ChainAddress,
  type Network,
} from "@wormhole-foundation/sdk";

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
    describe:
      "Gas estimate multiplier for EVM deployments (e.g., 200 for 2x)",
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
