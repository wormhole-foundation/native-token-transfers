import {
  Chain,
  chainToPlatform,
  Network,
} from "@wormhole-foundation/sdk-connect";

export const apiBaseUrl: Partial<Record<Network, string>> = {
  Mainnet: "https://executor.labsapis.com",
  Testnet: "https://executor-testnet.labsapis.com",
};

// Referrer addresses (to whom the referrer fee should be paid)
export const getReferrerAddress = (chain: Chain): string | undefined => {
  if (chainToPlatform(chain) === "Evm") {
    return "0xF11e0efF8b11Ce382645dd75352fC16b3aB3551E";
  }
  if (chain === "Solana") {
    return "JB3rmygUVuVZzgkxvMdV8mSKLJeQAkSXEK284Dqsziah";
  }
};
