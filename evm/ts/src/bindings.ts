import { Provider } from "ethers";

import { _0_1_0, _1_0_0, _1_1_0, _2_0_0 } from "./ethers-contracts/index.js";
import { Ntt } from "@wormhole-foundation/sdk-definitions-ntt";

// This is a descending list of all ABI versions the SDK is aware of.
// We check for the first match in descending order, allowing for higher minor and patch versions
// being used by the live contract (these are supposed to still be compatible with older ABIs).
export const abiVersions = [["2.0.0", _2_0_0]] as const;
export type AbiVersion = (typeof abiVersions)[number][0];

export interface NttBindings {
  NttManager: NttManagerBindings;
  NttTransceiver: NttTransceiverBindings;
}

export namespace NttTransceiverBindings {
  // Note: this is hardcoded to 0.1.0 so we should be warned if there are changes
  // that would affect the interface
  export type NttTransceiver = ReturnType<typeof _0_1_0.NttTransceiver.connect>;
}

export interface NttTransceiverBindings {
  connect(
    address: string,
    provider: Provider
  ): NttTransceiverBindings.NttTransceiver;
}

export namespace NttManagerBindings {
  export type NttManager = ReturnType<typeof _2_0_0.NttManager.connect>;
}

export interface NttManagerBindings {
  connect(address: string, provider: Provider): NttManagerBindings.NttManager;
}

export function loadAbiVersion(targetVersion: string) {
  for (const [abiVersion, abi] of abiVersions) {
    if (Ntt.abiVersionMatches(targetVersion, abiVersion)) {
      return abi;
    }
  }
  throw new Error(`Unknown ABI version: ${targetVersion}`);
}
