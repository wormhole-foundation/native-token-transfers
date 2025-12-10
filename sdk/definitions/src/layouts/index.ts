import {
  NamedPayloads,
  RegisterPayloadTypes,
  deliveryInstructionLayout,
} from "@wormhole-foundation/sdk-definitions";
import { nttManagerMessageLayout } from "./manager.js";
import { transceiverInfo, transceiverRegistration } from "./transceiver.js";
import { nativeTokenTransferLayout } from "./transfer.js";
import {
  genericMessageLayout,
  multiTokenNativeTokenTransferLayout,
} from "./multiToken.js";
import { wormholeTransceiverMessageLayout } from "./wormhole.js";

export const nttNamedPayloads = [
  [
    "WormholeTransfer",
    wormholeTransceiverMessageLayout(
      nttManagerMessageLayout(nativeTokenTransferLayout)
    ),
  ],
  [
    "WormholeTransferStandardRelayer",
    deliveryInstructionLayout(
      wormholeTransceiverMessageLayout(
        nttManagerMessageLayout(nativeTokenTransferLayout)
      )
    ),
  ],
  ["TransceiverInfo", transceiverInfo],
  ["TransceiverRegistration", transceiverRegistration],
] as const satisfies NamedPayloads;

export const multiTokenNttNamedPayloads = [
  [
    "WormholeTransfer",
    wormholeTransceiverMessageLayout(
      nttManagerMessageLayout(
        genericMessageLayout(multiTokenNativeTokenTransferLayout)
      )
    ),
  ],
] as const satisfies NamedPayloads;

// factory registration:
declare module "@wormhole-foundation/sdk-definitions" {
  export namespace WormholeRegistry {
    interface PayloadLiteralToLayoutMapping
      extends RegisterPayloadTypes<"Ntt", typeof nttNamedPayloads>,
        RegisterPayloadTypes<
          "MultiTokenNtt",
          typeof multiTokenNttNamedPayloads
        > {}
  }
}

export * from "./amount.js";
export * from "./manager.js";
export * from "./multiToken.js";
export * from "./prefix.js";
export * from "./transceiver.js";
export * from "./transceiverInstructions.js";
export * from "./transfer.js";
export * from "./wormhole.js";

export type * from "./amount.js";
export type * from "./manager.js";
export type * from "./multiToken.js";
export type * from "./prefix.js";
export type * from "./transceiver.js";
export type * from "./transceiverInstructions.js";
export type * from "./transfer.js";
export type * from "./wormhole.js";
