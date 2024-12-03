import { type ExampleNativeTokenTransfers } from "../../idl/2_0_0/ts/example_native_token_transfers.js";
import { IDL as ntt } from "../../idl/2_0_0/ts/example_native_token_transfers.js";
import { type NttQuoter } from "../../idl/2_0_0/ts/ntt_quoter.js";
import { IDL as quoter } from "../../idl/2_0_0/ts/ntt_quoter.js";
import { type WormholeGovernance } from "../../idl/2_0_0/ts/wormhole_governance.js";
import { IDL as governance } from "../../idl/2_0_0/ts/wormhole_governance.js";

export namespace _2_0_0 {
  export const idl = { ntt, transceiver: ntt, quoter, governance };
  export type RawExampleNativeTokenTransfers = ExampleNativeTokenTransfers;
  export type RawNttQuoter = NttQuoter;
  export type RawWormholeGovernance = WormholeGovernance;
}
