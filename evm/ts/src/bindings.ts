import { Provider } from "ethers";

import { _0_1_0, _1_0_0, _1_1_0, _2_0_0 } from "./ethers-contracts/index.js";
import { Ntt } from "@wormhole-foundation/sdk-definitions-ntt";

// This is a descending list of all ABI versions the SDK is aware of.
// We check for the first match in descending order, allowing for higher minor and patch versions
// being used by the live contract (these are supposed to still be compatible with older ABIs).
export const abiVersions = [
  ["2.0.0", _2_0_0],
  ["1.1.0", _1_1_0],
  ["1.0.0", _1_0_0],
  ["0.1.0", _0_1_0],
] as const;
export type AbiVersion = (typeof abiVersions)[number][0];

type AbiBindings = (typeof abiVersions)[number][1];

export interface NttBindings {
  NttManager: NttManagerBindings;
  NttTransceiver: NttTransceiverBindings;
}

export namespace NttTransceiverBindings {
  export type NttTransceiver = ReturnType<
    AbiBindings["NttTransceiver"]["connect"]
  >;
}

export interface NttTransceiverBindings {
  connect(
    address: string,
    provider: Provider
  ): NttTransceiverBindings.NttTransceiver;
}

export namespace NttManagerBindings {
  export type NttManager = ReturnType<AbiBindings["NttManager"]["connect"]>;
}

export interface NttManagerBindings {
  connect(address: string, provider: Provider): NttManagerBindings.NttManager;
}

export function loadAbiVersion(targetVersion: string): NttBindings {
  for (const [abiVersion, abi] of abiVersions) {
    if (Ntt.abiVersionMatches(targetVersion, abiVersion)) {
      return abi as unknown as NttBindings;
    }
  }
  throw new Error(`Unknown ABI version: ${targetVersion}`);
}
