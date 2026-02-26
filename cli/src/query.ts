import {
  ChainContext,
  chainToPlatform,
  assertChain,
  type Chain,
  type Network,
} from "@wormhole-foundation/sdk";
import type { Ntt } from "@wormhole-foundation/sdk-definitions-ntt";
import type {
  EvmNtt,
  EvmNttWormholeTranceiver,
} from "@wormhole-foundation/sdk-evm-ntt";
import type { EvmChains } from "@wormhole-foundation/sdk-evm";
import { type SolanaChains } from "@wormhole-foundation/sdk-solana";
import { NTT, SolanaNtt } from "@wormhole-foundation/sdk-solana-ntt";
import type { Config } from "./deployments";
import { formatNumber } from "./limitFormatting";
import { retryWithExponentialBackoff } from "./validation";
import { runTaskPoolWithSequential } from "./utils/concurrency";

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

  // Fetch CCL parameters if consistency level is 203 (custom).
  // These methods only exist on contracts with CCL support (>= v1.3.1).
  // Use `in` operator guards (same pattern as sdk-evm-ntt ntt.ts) to narrow
  // the NttTransceiverBindings.NttTransceiver union type at runtime.
  let customConsistencyLevel: bigint | undefined;
  let additionalBlocks: bigint | undefined;
  let customConsistencyLevelAddress: string | undefined;

  if (consistencyLevel === 203n) {
    try {
      const tc = transceiver.transceiver;
      if ("customConsistencyLevel" in tc) {
        customConsistencyLevel = await tc.customConsistencyLevel();
      }
      if ("additionalBlocks" in tc) {
        additionalBlocks = await tc.additionalBlocks();
      }
      if ("customConsistencyLevelAddress" in tc) {
        customConsistencyLevelAddress =
          await tc.customConsistencyLevelAddress();
      }
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

export { formatNumber, checkNumberFormatting } from "./limitFormatting";

// NOTE: modifies the config object in place
// TODO: maybe introduce typestate for having pulled inbound limits?
export async function pullInboundLimits(
  ntts: Partial<{ [C in Chain]: Ntt<Network, C> }>,
  config: Config["chains"],
  verbose: boolean,
  concurrency: number = 1
) {
  const entries = Object.entries(ntts).filter(
    ([, ntt]) => ntt !== undefined
  ) as [string, Ntt<Network, Chain>][];

  const decimalsByChain: Partial<Record<Chain, number>> = {};

  // Ensure config structures exist before parallel writes
  for (const [chain] of entries) {
    assertChain(chain);
    const chainConf = config[chain];
    if (!chainConf) {
      console.error(`Chain ${chain} not found in deployment`);
      process.exit(1);
    }
    chainConf.limits ??= { outbound: "0", inbound: {} };
    chainConf.limits.inbound ??= {};
  }

  // Phase 1: fetch token decimals for each chain
  await runTaskPoolWithSequential(
    entries,
    concurrency,
    ([chain]) => {
      assertChain(chain);
      return chainToPlatform(chain) === "Solana";
    },
    async ([chain, ntt]) => {
      assertChain(chain);
      decimalsByChain[chain] = await ntt.getTokenDecimals();
    }
  );

  // Phase 2: fetch inbound limits for each pair
  type InboundTask = {
    fromChain: Chain;
    toChain: Chain;
    fromNtt: Ntt<Network, Chain>;
  };
  type InboundResult =
    | { fromChain: Chain; toChain: Chain; status: "ok"; formatted: string }
    | { fromChain: Chain; toChain: Chain; status: "error"; error: unknown };

  const tasks: InboundTask[] = [];
  for (const [fromChain, fromNtt] of entries) {
    assertChain(fromChain);
    for (const [toChain, toNtt] of entries) {
      assertChain(toChain);
      if (fromNtt === toNtt) {
        continue;
      }
      tasks.push({ fromChain, toChain, fromNtt });
    }
  }

  const runTask = async (task: InboundTask): Promise<InboundResult> => {
    const { fromChain, toChain, fromNtt } = task;
    if (verbose) {
      process.stdout.write(
        `Fetching inbound limit for ${fromChain} -> ${toChain}.......\n`
      );
    }
    try {
      const peer = await retryWithExponentialBackoff(
        () => fromNtt.getPeer(toChain),
        5,
        5000
      );
      const limit = peer?.inboundLimit ?? 0n;
      const decimals = decimalsByChain[fromChain];
      if (decimals === undefined) {
        return {
          fromChain,
          toChain,
          status: "error",
          error: new Error(`Token decimals not found for chain ${fromChain}`),
        };
      }
      return {
        fromChain,
        toChain,
        status: "ok",
        formatted: formatNumber(limit, decimals),
      };
    } catch (e) {
      return { fromChain, toChain, status: "error", error: e };
    }
  };

  const results = await runTaskPoolWithSequential(
    tasks,
    concurrency,
    (task) => chainToPlatform(task.fromChain) === "Solana",
    runTask
  );

  const errors: { fromChain: Chain; toChain: Chain; error: unknown }[] = [];
  for (const result of results) {
    if (result.status === "ok") {
      config[result.fromChain]!.limits!.inbound![result.toChain] =
        result.formatted;
    } else {
      errors.push({
        fromChain: result.fromChain,
        toChain: result.toChain,
        error: result.error,
      });
    }
  }
  if (errors.length > 0) {
    for (const { fromChain, toChain, error } of errors) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(
        `Failed to fetch inbound limit for ${fromChain} -> ${toChain}: ${msg}`
      );
    }
  }
}
