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
import { retryWithExponentialBackoff } from "./validation";

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

export function formatNumber(num: bigint, decimals: number) {
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

export function checkNumberFormatting(
  formatted: string,
  decimals: number
): boolean {
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
