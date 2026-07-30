import { type ExampleNativeTokenTransfers } from "../../idl/4_0_0/ts/example_native_token_transfers.js";
import { IDL as ntt } from "../../idl/4_0_0/ts/example_native_token_transfers.js";
// The transceiver/quoter/governance programs are independent of the NTT manager
// and were not changed in v4. Re-use the 3.0.0 IDL for those until they need
// their own version bumps. (The quoter IDL was only emitted under 4_0_0; the
// program is unchanged, so it's equivalent.)
import { type NttTransceiver } from "../../idl/3_0_0/ts/ntt_transceiver.js";
import { IDL as transceiver } from "../../idl/3_0_0/ts/ntt_transceiver.js";
import { type NttTransceiverLegacy } from "../../idl/3_0_0/ts/ntt_transceiver_legacy.js";
import { IDL as transceiverLegacy } from "../../idl/3_0_0/ts/ntt_transceiver_legacy.js";
import { type NttQuoter } from "../../idl/4_0_0/ts/ntt_quoter.js";
import { IDL as quoter } from "../../idl/4_0_0/ts/ntt_quoter.js";
import { type WormholeGovernance } from "../../idl/3_0_0/ts/wormhole_governance.js";
import { IDL as governance } from "../../idl/3_0_0/ts/wormhole_governance.js";

export namespace _4_0_0 {
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
