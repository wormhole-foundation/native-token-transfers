import type { Network } from "@wormhole-foundation/sdk-connect";

const DEFAULT_EXECUTOR_APIS: Partial<Record<Network, string>> = {
  Testnet: "https://executor-testnet.labsapis.com/v0",
  Mainnet: "https://executor.labsapis.com/v0",
};

/**
 * Default Executor API base URL for a network. Throws if there is no default
 * for that network (e.g. not deployed yet) — pass `--executor-api` explicitly
 * in that case.
 */
export function getDefaultExecutorApiForNetwork(network: Network): string {
  const api = DEFAULT_EXECUTOR_APIS[network];
  if (!api) {
    throw new Error(
      `No default Executor API for ${network}; pass --executor-api`
    );
  }
  return api;
}
