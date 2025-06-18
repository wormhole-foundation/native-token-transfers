import {
  Chain,
  ChainAddress,
  chainToPlatform,
  Network,
  Wormhole,
} from "@wormhole-foundation/sdk-connect";

export const apiBaseUrl: Partial<Record<Network, string>> = {
  Mainnet: "https://executor.labsapis.com",
  Testnet: "https://executor-testnet.labsapis.com",
};

// Referrer addresses (to whom the referrer fee should be paid)
export const getDefaultReferrerAddress = (chain: Chain): ChainAddress => {
  let address = "";
  if (chainToPlatform(chain) === "Evm") {
    address = "0xF11e0efF8b11Ce382645dd75352fC16b3aB3551E";
  } else if (chain === "Solana") {
    address = "JB3rmygUVuVZzgkxvMdV8mSKLJeQAkSXEK284Dqsziah";
  } else {
    throw new Error(`No referrer address for chain ${chain}`);
  }
  return Wormhole.chainAddress(chain, address);
};
