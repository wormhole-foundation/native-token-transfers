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
    address = "0x82d9A407f99a95db4671e7021D625CBd0787a407";
  } else if (chainToPlatform(chain) === "Solana") {
    address = "14MtvNdzYPKM3kYrBya51fsjbh5WLKot8fZu7szbgC66";
  } else if (chainToPlatform(chain) === "Sui") {
    address =
      "0x1047ebae522f969bdb62930f38407b2a178f2fcba00285c4ba4abe415fe159ad";
  } else {
    throw new Error(`No referrer address for chain ${chain}`);
  }
  return Wormhole.chainAddress(chain, address);
};
