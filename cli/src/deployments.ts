import type { Chain, Network } from "@wormhole-foundation/sdk";
import type { Ntt } from "@wormhole-foundation/sdk-definitions-ntt";
import fs from "fs";

export type ChainConfig = {
  version: string;
  mode: Ntt.Mode;
  paused: boolean;
  owner: string;
  pauser?: string;
  manager: string;
  token: string;
  transceivers: {
    threshold: number;
    wormhole: { address: string; pauser?: string };
  };
  limits: {
    outbound: string;
    inbound: Partial<{ [C in Chain]: string }>;
  };
  // Local-only config (not pushed to chain)
  managerVariant?: string;
};

export type HyperCoreConfig = {
  tokenIndex: number;
  szDecimals?: number;
  weiDecimals?: number;
};

// XRPL custody-account config. Kept as a dedicated top-level section (not under
// `chains`) since the XRPL NTT account is set up incrementally and doesn't fit
// the full ChainConfig shape.
export type XrplConfig = {
  manager?: string;
  // The NTT token: "native" for native XRP, otherwise the Wormhole SDK XRPL
  // platform address (`XrplAddress` from `@wormhole-foundation/sdk-xrpl`) — an
  // IOU "CODE.rIssuer" or a 48-char hex MPT issuance id. Recorded by
  // `ntt xrpl set-token`.
  token?: string;
  // Token decimals on XRPL (e.g. 6 for XRP, the MPT AssetScale, or the chosen
  // precision for an IOU). Recorded by `ntt xrpl set-token`.
  decimals?: number;
};

export type Config = {
  network: Network;
  chains: Partial<{
    [C in Chain]: ChainConfig;
  }>;
  defaultLimits?: {
    outbound: string;
  };
  hypercore?: HyperCoreConfig;
  xrpl?: XrplConfig;
};

export function loadConfig(path: string): Config {
  if (!fs.existsSync(path)) {
    console.error(`File not found: ${path}`);
    console.error(`Create with 'ntt init' or specify another file with --path`);
    process.exit(1);
  }
  const deployments: Config = JSON.parse(fs.readFileSync(path).toString());
  return deployments;
}
