import type { Network } from "@wormhole-foundation/sdk-base";
import type { EvmChains } from "@wormhole-foundation/sdk-evm";

// Must be high enough to cover the destination chain's worst case (otherwise
// the executor's relay simulation reverts), but not so high that it inflates
// the `estimatedCost` returned by /v0/quote.
export const executorGasLimitOverrides: Partial<
  Record<Network, Partial<Record<EvmChains, bigint>>>
> = {
  Mainnet: {
    Arbitrum: 800_000n,
    CreditCoin: 1_500_000n,
    Monad: 1_000_000n,
    MegaETH: 1_000_000n,
    Seievm: 1_000_000n,
  },
  Testnet: {
    ArbitrumSepolia: 800_000n,
    Seievm: 1_000_000n,
    Tempo: 1_500_000n,
  },
};

export const DEFAULT_EXECUTOR_GAS_LIMIT = 500_000n;
