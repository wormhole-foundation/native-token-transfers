import { type ExampleNativeTokenTransfers } from "../../idl/1_0_0/ts/example_native_token_transfers.js";
import { IDL as ntt } from "../../idl/1_0_0/ts/example_native_token_transfers.js";
import { type WormholeGovernance } from "../../idl/1_0_0/ts/wormhole_governance.js";
import { IDL as governance } from "../../idl/1_0_0/ts/wormhole_governance.js";

export namespace _1_0_0 {
  export const idl = {
    ntt,
    transceiver: ntt,
    transceiverLegacy: ntt,
    governance,
  };
  export type RawExampleNativeTokenTransfers = ExampleNativeTokenTransfers;
  export type RawWormholeGovernance = WormholeGovernance;
}
