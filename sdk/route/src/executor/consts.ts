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
    address = "0x9b2A3B92b1D86938D3Ed37B0519952C227bA6D09";
  } else if (chainToPlatform(chain) === "Solana") {
    address = "9q2q3EtP1VNdyaxzju1CGfh3EDj7heGABgxAJNyQDXgT";
  } else {
    throw new Error(`No referrer address for chain ${chain}`);
  }
  return Wormhole.chainAddress(chain, address);
};
