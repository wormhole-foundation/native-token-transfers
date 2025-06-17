import { Network } from "@wormhole-foundation/sdk-connect";

export const apiBaseUrl: Partial<Record<Network, string>> = {
  Mainnet: "https://executor.labsapis.com",
  Testnet: "https://executor-testnet.labsapis.com",
};
