import { Provider } from "ethers";
import { _1_1_0 } from "./ethers-contracts/multiTokenNtt/index.js";
import { Ntt } from "@wormhole-foundation/sdk-definitions-ntt";
import { NttTransceiverBindings } from "./bindings.js";

// This is a descending list of all ABI versions the SDK is aware of.
// We check for the first match in descending order, allowing for higher minor and patch versions
// being used by the live contract (these are supposed to still be compatible with older ABIs).
export const abiVersions = [["1.1.0", _1_1_0]] as const;
export type AbiVersion = (typeof abiVersions)[number][0];

export interface MultiTokenNttBindings {
  NttManager: MultiTokenNttManagerBindings;
  GmpManager: GmpManagerBindings;
  NttTransceiver: NttTransceiverBindings;
}

export namespace MultiTokenNttManagerBindings {
  export type NttManager = ReturnType<typeof _1_1_0.NttManager.connect>;
}

export interface MultiTokenNttManagerBindings {
  connect(
    address: string,
    provider: Provider
  ): MultiTokenNttManagerBindings.NttManager;
}

export namespace GmpManagerBindings {
  export type GmpManager = ReturnType<typeof _1_1_0.GmpManager.connect>;
}

export interface GmpManagerBindings {
  connect(address: string, provider: Provider): GmpManagerBindings.GmpManager;
}

export function loadAbiVersion(targetVersion: string) {
  for (const [abiVersion, abi] of abiVersions) {
    if (Ntt.abiVersionMatches(targetVersion, abiVersion)) {
      return abi;
    }
  }
  throw new Error(`Unknown ABI version: ${targetVersion}`);
}
