import { IdlAccounts, Program } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import { _1_0_0, _2_0_0, _3_0_0 } from "./anchor-idl/index.js";
import { Ntt } from "@wormhole-foundation/sdk-definitions-ntt";

export interface IdlBinding<V extends IdlVersion> {
  idl: {
    ntt: NttBindings.NativeTokenTransfer<V>;
    transceiver: NttBindings.Transceiver<V>;
    quoter: NttBindings.Quoter<V>;
  };
}

// This is a descending list of all ABI versions the SDK is aware of.
// We check for the first match in descending order, allowing for higher minor and patch versions
// being used by the live contract (these are supposed to still be compatible with older ABIs).
export const IdlVersions = [
  ["3.0.0", _3_0_0],
  ["2.0.0", _2_0_0],
  ["1.0.0", _1_0_0],
] as const;

export type IdlVersion = (typeof IdlVersions)[number][0];

export namespace NttBindings {
  export type NativeTokenTransfer<V extends IdlVersion> = V extends "1.0.0"
    ? _1_0_0.RawExampleNativeTokenTransfers
    : V extends "2.0.0"
    ? _2_0_0.RawExampleNativeTokenTransfers
    : _3_0_0.RawExampleNativeTokenTransfers;

  export type Quoter<V extends IdlVersion> = V extends "1.0.0"
    ? _1_0_0.RawNttQuoter
    : V extends "2.0.0"
    ? _2_0_0.RawNttQuoter
    : _3_0_0.RawNttQuoter;

  export type Transceiver<V extends IdlVersion> = V extends "1.0.0"
    ? _1_0_0.RawExampleNativeTokenTransfers
    : V extends "2.0.0"
    ? _2_0_0.RawExampleNativeTokenTransfers
    : _3_0_0.RawNttTransceiver;

  type ProgramAccounts<V extends IdlVersion> = IdlAccounts<
    NttBindings.NativeTokenTransfer<V>
  >;

  export type Config<V extends IdlVersion> = ProgramAccounts<V>["config"];
  export type InboxItem<V extends IdlVersion> = ProgramAccounts<V>["inboxItem"];
}

function loadIdlVersion<V extends IdlVersion>(targetVersion: V): IdlBinding<V> {
  for (const [idlVersion, idl] of IdlVersions) {
    if (Ntt.abiVersionMatches(targetVersion, idlVersion)) {
      return idl as unknown as IdlBinding<V>;
    }
  }
  throw new Error(`Unknown IDL version: ${targetVersion}`);
}

export function getNttProgram<V extends IdlVersion>(
  connection: Connection,
  address: string,
  version: V
): Program<NttBindings.NativeTokenTransfer<V>> {
  const {
    idl: { ntt },
  } = loadIdlVersion(version);
  return new Program<NttBindings.NativeTokenTransfer<V>>(ntt, address, {
    connection,
  });
}

export function getTransceiverProgram<V extends IdlVersion>(
  connection: Connection,
  address: string,
  version: V
) {
  const {
    idl: { transceiver },
  } = loadIdlVersion(version);
  return new Program<NttBindings.Transceiver<V>>(transceiver, address, {
    connection,
  });
}

export function getQuoterProgram<V extends IdlVersion>(
  connection: Connection,
  address: string,
  version: V
) {
  const {
    idl: { quoter },
  } = loadIdlVersion(version);
  return new Program<NttBindings.Quoter<V>>(quoter, address, {
    connection,
  });
}
