import { Chain, Network } from "@wormhole-foundation/sdk-connect";

export const apiBaseUrl: Partial<Record<Network, string>> = {
  Testnet: "https://executor-testnet.labsapis.com",
  Mainnet: "https://executor.labsapis.com",
};

export const nttManagerWithExecutorContracts: Partial<
  Record<Network, Partial<Record<Chain, string>>>
> = {
  Mainnet: {},
  Testnet: {},
};

// Referrer addresses (to whom the referrer fee should be paid)
export const referrers: Partial<
  Record<Network, Partial<Record<Chain, string>>>
> = {
  Mainnet: {},
  Testnet: {},
};
