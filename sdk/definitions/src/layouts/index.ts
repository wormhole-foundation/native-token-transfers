import {
  deliveryInstructionLayout,
  type NamedPayloads,
  type RegisterPayloadTypes,
} from "@wormhole-foundation/sdk-definitions";
import { nttManagerMessageLayout } from "./manager.js";
import { transceiverInfo, transceiverRegistration } from "./transceiver.js";
import { nativeTokenTransferLayout } from "./transfer.js";
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

// factory registration:
declare module "@wormhole-foundation/sdk-definitions" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace WormholeRegistry {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface PayloadLiteralToLayoutMapping
      extends RegisterPayloadTypes<"Ntt", typeof nttNamedPayloads> {}
  }
}

export * from "./amount.js";
export * from "./manager.js";
export * from "./prefix.js";
export * from "./transceiver.js";
export * from "./transceiverInstructions.js";
export * from "./transfer.js";
export * from "./wormhole.js";

export type * from "./amount.js";
export type * from "./manager.js";
export type * from "./prefix.js";
export type * from "./transceiver.js";
export type * from "./transceiverInstructions.js";
export type * from "./transfer.js";
export type * from "./wormhole.js";
