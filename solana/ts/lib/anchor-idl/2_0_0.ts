import {
  IDL as ntt,
  type ExampleNativeTokenTransfers,
} from "../../idl/2_0_0/ts/example_native_token_transfers.js";
import {
  IDL as quoter,
  type NttQuoter,
} from "../../idl/2_0_0/ts/ntt_quoter.js";
import {
  IDL as governance,
  type WormholeGovernance,
} from "../../idl/2_0_0/ts/wormhole_governance.js";

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace _2_0_0 {
  export const idl = { ntt, transceiver: ntt, quoter, governance };
  export type RawExampleNativeTokenTransfers = ExampleNativeTokenTransfers;
  export type RawNttQuoter = NttQuoter;
  export type RawWormholeGovernance = WormholeGovernance;
}
