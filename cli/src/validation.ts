import { PublicKey } from "@solana/web3.js";
import fs from "fs";
import {
  assertChain,
  chainToPlatform,
  chains,
  type Chain,
  type ChainAddress,
  type ChainContext,
  type Network,
  type Platform,
} from "@wormhole-foundation/sdk";
import type {
  Ntt,
  NttTransceiver,
} from "@wormhole-foundation/sdk-definitions-ntt";
import type { SolanaChains } from "@wormhole-foundation/sdk-solana";
import { SolanaNtt } from "@wormhole-foundation/sdk-solana-ntt";
import type { ChainConfig } from "./deployments";
import { runTaskPoolWithSequential } from "./utils/concurrency";

export function ensureNttRoot(pwd: string = ".") {
  if (
    !fs.existsSync(`${pwd}/evm/foundry.toml`) ||
    !fs.existsSync(`${pwd}/solana/Anchor.toml`)
  ) {
    console.error("Run this command from the root of an NTT project.");
    process.exit(1);
  }
}

export type ErrorFactory = (message: string) => Error;

export const SUPPORTED_PLATFORMS: ReadonlySet<Platform> = new Set([
  "Evm",
  "Solana",
  "Sui",
]);

export type Deployment<C extends Chain> = {
  ctx: ChainContext<Network, C>;
  ntt: Ntt<Network, C>;
  whTransceiver: NttTransceiver<Network, C, Ntt.Attestation>;
  decimals: number;
  manager: ChainAddress<C>;
  config: {
    remote?: ChainConfig;
    local?: ChainConfig;
  };
};

// Implicit configuration that's missing from a contract deployment. These are
// implicit in the sense that they don't need to be explicitly set in the
// deployment file.
export type MissingImplicitConfig = {
  managerPeers: Ntt.Peer<Chain>[];
  transceiverPeers: ChainAddress<Chain>[];
  solanaWormholeTransceiver: boolean;
  solanaUpdateLUT: boolean;
};

const PLACEHOLDER_PUBKEY = new PublicKey(0);

/** Ensure the selected chain runs on a platform the CLI supports. */
export function ensurePlatformSupported(
  chain: Chain,
  errorFactory: ErrorFactory = (message) => new Error(message)
): void {
  const platform = chainToPlatform(chain);
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw errorFactory(
      `Chain ${chain} (platform ${platform}) is not supported by this CLI operation`
    );
  }
}

/** Normalize and validate a payer flag, enforcing Solana-only usage. */
export function validatePayerOption(
  rawPayer: unknown,
  sourceChain: Chain,
  errorFactory: ErrorFactory,
  warn: (message: string) => void = console.warn
): string | undefined {
  if (Array.isArray(rawPayer)) {
    throw errorFactory("--payer may only be specified once");
  }
  const payerPath = typeof rawPayer === "string" ? rawPayer.trim() : undefined;
  if (rawPayer !== undefined && (!payerPath || payerPath.length === 0)) {
    throw errorFactory("--payer must be a path to a Solana keypair JSON file");
  }
  if (payerPath && chainToPlatform(sourceChain) !== "Solana") {
    warn(
      "--payer is only used when the source chain is Solana. Ignoring provided path."
    );
    return undefined;
  }
  if (payerPath && !fs.existsSync(payerPath)) {
    throw errorFactory(`--payer path not found: ${payerPath}`);
  }
  return payerPath;
}

/** Normalize RPC override inputs (Chain=URL) and enforce non-empty values. */
export function normalizeRpcArgs(
  rawRpc: unknown,
  errorFactory: ErrorFactory
): string[] | undefined {
  const rpcArgs = Array.isArray(rawRpc)
    ? rawRpc
    : rawRpc
      ? [rawRpc]
      : undefined;
  if (
    rpcArgs &&
    (rpcArgs.length === 0 ||
      rpcArgs.some(
        (value) => typeof value !== "string" || value.trim().length === 0
      ))
  ) {
    throw errorFactory(
      "--rpc expects values in the form Chain=URL. Remove the flag or provide a valid endpoint."
    );
  }
  return rpcArgs?.map((value) => value.trim());
}

/** Validate an optional timeout flag and coerce it into seconds when present. */
export function validateTimeout(
  rawTimeout: unknown,
  wasProvided: boolean,
  errorFactory: ErrorFactory
): number | undefined {
  if (!wasProvided) {
    return undefined;
  }
  if (
    rawTimeout === undefined ||
    rawTimeout === null ||
    Array.isArray(rawTimeout)
  ) {
    throw errorFactory(
      "--timeout expects a numeric value in seconds. Remove the flag or provide a valid number."
    );
  }
  if (typeof rawTimeout !== "number" || Number.isNaN(rawTimeout)) {
    throw errorFactory(
      "--timeout expects a numeric value in seconds. Remove the flag or provide a valid number."
    );
  }
  if (rawTimeout <= 0) {
    throw errorFactory("--timeout must be a positive number of seconds.");
  }
  return rawTimeout;
}

/** Print a human-readable report for missing implicit configs; returns true if any were found. */
export function printMissingConfigReport(
  missing: Partial<{ [C in Chain]: MissingImplicitConfig }>
): boolean {
  if (Object.keys(missing).length === 0) {
    return false;
  }
  for (const [chain, missingConfig] of Object.entries(missing)) {
    console.error(`${chain} status:`);
    for (const manager of missingConfig.managerPeers) {
      console.error(`  Missing manager peer: ${manager.address.chain}`);
    }
    for (const transceiver of missingConfig.transceiverPeers) {
      console.error(`  Missing transceiver peer: ${transceiver.chain}`);
    }
    if (missingConfig.solanaWormholeTransceiver) {
      console.error("  Missing Solana wormhole transceiver");
    }
    if (missingConfig.solanaUpdateLUT) {
      console.error("  Missing or outdated LUT");
    }
  }
  return true;
}

/** Collect missing implicit config across deployments (peers, Solana LUT/transceiver). */
export async function collectMissingConfigs(
  deps: Partial<{ [C in Chain]: Deployment<Chain> }>,
  verbose: boolean,
  concurrency: number = 1
): Promise<Partial<{ [C in Chain]: MissingImplicitConfig }>> {
  const missingConfigs: Partial<{ [C in Chain]: MissingImplicitConfig }> = {};
  const entries = Object.entries(deps).filter(
    ([, deployment]) => deployment !== undefined
  ) as [string, Deployment<Chain>][];

  const missingByChain: Partial<{ [C in Chain]: MissingImplicitConfig }> = {};
  const missingCounts: Partial<Record<Chain, number>> = {};

  // Initialize per-chain structures and handle Solana-specific checks (sequential)
  for (const [fromChain, from] of entries) {
    assertChain(fromChain);

    const missing: MissingImplicitConfig = {
      managerPeers: [],
      transceiverPeers: [],
      solanaWormholeTransceiver: false,
      solanaUpdateLUT: false,
    };
    missingByChain[fromChain] = missing;
    missingCounts[fromChain] = 0;

    if (chainToPlatform(fromChain) === "Solana") {
      const solanaNtt = from.ntt as SolanaNtt<Network, SolanaChains>;
      const selfWormholeTransceiver = solanaNtt.pdas
        .registeredTransceiver(new PublicKey(solanaNtt.contracts.ntt!.manager))
        .toBase58();
      const registeredSelfTransceiver = await retryWithExponentialBackoff(
        () =>
          solanaNtt.connection.getAccountInfo(
            new PublicKey(selfWormholeTransceiver)
          ),
        5,
        5000
      );
      if (registeredSelfTransceiver === null) {
        missingCounts[fromChain] = (missingCounts[fromChain] ?? 0) + 1;
        missing.solanaWormholeTransceiver = true;
      }

      // Placeholder key is only used for address derivation in this check.
      const updateLUT = solanaNtt.initializeOrUpdateLUT({
        payer: PLACEHOLDER_PUBKEY,
        owner: PLACEHOLDER_PUBKEY,
      });
      if (!(await updateLUT.next()).done) {
        missingCounts[fromChain] = (missingCounts[fromChain] ?? 0) + 1;
        missing.solanaUpdateLUT = true;
      }
    }
  }

  // Build pair tasks for parallel peer verification
  type PairTask = {
    fromChain: Chain;
    toChain: Chain;
    from: Deployment<Chain>;
    to: Deployment<Chain>;
  };
  const tasks: PairTask[] = [];
  for (const [fromChain, from] of entries) {
    assertChain(fromChain);
    for (const [toChain, to] of entries) {
      assertChain(toChain);
      if (fromChain === toChain) {
        continue;
      }
      tasks.push({ fromChain, toChain, from, to });
    }
  }

  const runTask = async (task: PairTask) => {
    const { fromChain, toChain, from, to } = task;
    const missing = missingByChain[fromChain];
    if (!missing) {
      return;
    }
    if (verbose) {
      process.stdout.write(
        `Verifying registration for ${fromChain} -> ${toChain}......\n`
      );
    }
    const peer = await retryWithExponentialBackoff(
      () => from.ntt.getPeer(toChain),
      5,
      5000
    );
    if (peer === null) {
      const configLimit = from.config.local?.limits?.inbound?.[
        toChain
      ]?.replace(/\./g, "");
      missingCounts[fromChain] = (missingCounts[fromChain] ?? 0) + 1;
      missing.managerPeers.push({
        address: to.manager,
        tokenDecimals: to.decimals,
        inboundLimit: BigInt(configLimit ?? 0),
      });
    } else {
      if (
        !Buffer.from(peer.address.address.address.toString()).equals(
          Buffer.from(to.manager.address.address.toString())
        )
      ) {
        console.error(`Peer address mismatch for ${fromChain} -> ${toChain}`);
      }
      if (peer.tokenDecimals !== to.decimals) {
        console.error(`Peer decimals mismatch for ${fromChain} -> ${toChain}`);
      }
    }

    const transceiverPeer = await retryWithExponentialBackoff(
      () => from.whTransceiver.getPeer(toChain),
      5,
      5000
    );
    const transceiverAddress = await to.whTransceiver.getAddress();
    if (transceiverPeer === null) {
      missingCounts[fromChain] = (missingCounts[fromChain] ?? 0) + 1;
      missing.transceiverPeers.push(transceiverAddress);
    } else {
      if (
        !Buffer.from(transceiverPeer.address.address.toString()).equals(
          Buffer.from(transceiverAddress.address.address.toString())
        )
      ) {
        console.error(
          `Transceiver peer address mismatch for ${fromChain} -> ${toChain}`
        );
      }
    }
  };

  await runTaskPoolWithSequential(
    tasks,
    concurrency,
    (task) => chainToPlatform(task.fromChain) === "Solana",
    runTask
  );

  for (const [chain, missing] of Object.entries(missingByChain)) {
    assertChain(chain);
    if ((missingCounts[chain] ?? 0) > 0) {
      missingConfigs[chain] = missing!;
    }
  }
  return missingConfigs;
}

/** Retry an async action with exponential backoff and jitter, up to a max retry count. */
export function retryWithExponentialBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  delay: number
): Promise<T> {
  const MAX_BACKOFF_MS = 10_000;
  const MAX_JITTER_MS = 1_000;
  const backoff = (retry: number) =>
    Math.min(2 ** retry * delay, MAX_BACKOFF_MS) +
    Math.random() * MAX_JITTER_MS;
  const attempt = async (retry: number): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (retry >= maxRetries) {
        throw e;
      }
      const time = backoff(retry);
      await new Promise((resolve) => setTimeout(resolve, time));
      return await attempt(retry + 1);
    }
  };
  return attempt(0);
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
    if (chains.find((c) => c === `${chain}Sepolia`)) {
      console.error(
        `Chain ${chain} is deprecated. Use ${chain}Sepolia instead.`
      );
      process.exit(1);
    }
  }
}
