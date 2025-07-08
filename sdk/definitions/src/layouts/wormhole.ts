import {
  type CustomizableBytes,
  type LayoutToType,
} from "@wormhole-foundation/sdk-base";
import { transceiverMessageLayout } from "./transceiver.js";

export type WormholeTransceiverMessage<
  MP extends CustomizableBytes = undefined,
> = LayoutToType<ReturnType<typeof wormholeTransceiverMessageLayout<MP>>>;

export const wormholeTransceiverMessageLayout = <
  MP extends CustomizableBytes = undefined,
>(
  nttManagerPayload?: MP
) =>
  transceiverMessageLayout(
    [0x99, 0x45, 0xff, 0x10],
    nttManagerPayload,
    new Uint8Array(0)
  );
