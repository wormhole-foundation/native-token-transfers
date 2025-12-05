import { Network } from "@wormhole-foundation/sdk-base";

export const NTT_MANAGER_STATE_CONTRACT_NAME = "ntt-manager-state";
export const NTT_MANAGER_CONTRACT_NAME = "ntt-manager-v1";
export const NTT_TOKEN_OWNER_CONTRACT_NAME = "token-manager";
export const WORMHOLE_TRANSCEIVER_STATE_CONTRACT_NAME =
  "wormhole-transceiver-state";

export const WORMHOLE_PROTOCOL_ID = 1;

export const DEFAULT_NTT_VERSION = "1.0.0";

export const ADDR32_CONTRACT: Partial<Record<Network, string>> = {
  Testnet: "ST2W4SFFKXMGFJW7K7NZFK3AH52ZTXDB74HKV9MRA.addr32",
};
