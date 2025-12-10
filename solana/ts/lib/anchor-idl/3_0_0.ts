import { type ExampleNativeTokenTransfers } from "../../idl/3_0_0/ts/example_native_token_transfers.js";
import { IDL as ntt } from "../../idl/3_0_0/ts/example_native_token_transfers.js";
import { type NttTransceiver } from "../../idl/3_0_0/ts/ntt_transceiver.js";
import { IDL as transceiver } from "../../idl/3_0_0/ts/ntt_transceiver.js";
import { type NttTransceiverLegacy } from "../../idl/3_0_0/ts/ntt_transceiver_legacy.js";
import { IDL as transceiverLegacy } from "../../idl/3_0_0/ts/ntt_transceiver_legacy.js";
import { type NttQuoter } from "../../idl/3_0_0/ts/ntt_quoter.js";
import { IDL as quoter } from "../../idl/3_0_0/ts/ntt_quoter.js";
import { type WormholeGovernance } from "../../idl/3_0_0/ts/wormhole_governance.js";
import { IDL as governance } from "../../idl/3_0_0/ts/wormhole_governance.js";

export namespace _3_0_0 {
  export const idl = {
    ntt,
    transceiver,
    transceiverLegacy,
    quoter,
    governance,
  };
  export type RawExampleNativeTokenTransfers = ExampleNativeTokenTransfers;
  export type RawNttTransceiver = NttTransceiver;
  export type RawNttTransceiverLegacy = NttTransceiverLegacy;
  export type RawNttQuoter = NttQuoter;
  export type RawWormholeGovernance = WormholeGovernance;
}
