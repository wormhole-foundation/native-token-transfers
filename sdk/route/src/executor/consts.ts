import {
  Chain,
  ChainAddress,
  chainToPlatform,
  encoding,
  type Layout,
  Network,
  Wormhole,
} from "@wormhole-foundation/sdk-connect";
import { prefixItem } from "@wormhole-foundation/sdk-definitions-ntt";

export const apiBaseUrl: Partial<Record<Network, string>> = {
  Mainnet: "https://executor.labsapis.com",
  Testnet: "https://executor-testnet.labsapis.com",
};

export const XRPL_EXECUTOR_MEMO_FORMAT_HEX = encoding.hex
  .encode("application/x-executor-request")
  .toUpperCase();

// Executor request layouts, duplicated from xrpl/ts/src/layouts.ts to avoid
// pulling the xrpl package into every sdk-route-ntt consumer.
export const xrplExecutorRequestLayout = [
  prefixItem([0x45, 0x52, 0x4e, 0x31]),
  { name: "srcChain", binary: "uint", size: 2 },
  { name: "srcManager", binary: "bytes", size: 32 },
  { name: "messageId", binary: "uint", size: 32 },
] as const satisfies Layout;

export const xrplRequestForExecutionLayout = [
  {
    name: "version",
    binary: "bytes",
    custom: Uint8Array.from([0x00]),
    omit: true,
  },
  { name: "dstChain", binary: "uint", size: 2 },
  { name: "dstAddr", binary: "bytes", size: 32 },
  { name: "refundAddr", binary: "bytes", size: 20 },
  { name: "signedQuote", binary: "bytes", lengthSize: 2 },
  { name: "requestBytes", binary: "bytes", lengthSize: 2 },
  { name: "relayInstructions", binary: "bytes", lengthSize: 2 },
] as const satisfies Layout;

// Referrer addresses (to whom the referrer fee should be paid)
export const getDefaultReferrerAddress = (chain: Chain): ChainAddress => {
  const platform = chainToPlatform(chain);
  let address = "";
  if (platform === "Evm") {
    address = "0x9b2A3B92b1D86938D3Ed37B0519952C227bA6D09";
  } else if (platform === "Solana") {
    address = "9q2q3EtP1VNdyaxzju1CGfh3EDj7heGABgxAJNyQDXgT";
  } else if (platform === "Sui") {
    address =
      "0xbfa1240e48c622d97881473953be730091161b7931d89bd6afe667841cf69ef4";
  } else if (platform === "Xrpl") {
    address = "rrrrrrrrrrrrrrrrrrrrrhoLvTp";
  } else {
    throw new Error(`No referrer address for chain ${chain}`);
  }
  return Wormhole.chainAddress(chain, address);
};
