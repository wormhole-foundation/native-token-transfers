import {
  customizableBytes,
  type CustomizableBytes,
  type Layout,
  type LayoutToType,
} from "@wormhole-foundation/sdk-base";
import { layoutItems } from "@wormhole-foundation/sdk-definitions";
import { prefixItem, type Prefix } from "./prefix.js";

export type TransceiverMessage<
  MP extends CustomizableBytes = undefined,
  TP extends CustomizableBytes = undefined,
> = LayoutToType<ReturnType<typeof transceiverMessageLayout<MP, TP>>>;

export const transceiverMessageLayout = <
  const MP extends CustomizableBytes = undefined,
  const TP extends CustomizableBytes = undefined,
>(
  prefix: Prefix,
  nttManagerPayload?: MP,
  transceiverPayload?: TP
) =>
  [
    prefixItem(prefix),
    { name: "sourceNttManager", ...layoutItems.universalAddressItem },
    { name: "recipientNttManager", ...layoutItems.universalAddressItem },
    customizableBytes(
      { name: "nttManagerPayload", lengthSize: 2 },
      nttManagerPayload
    ),
    customizableBytes(
      { name: "transceiverPayload", lengthSize: 2 },
      transceiverPayload
    ),
  ] as const satisfies Layout;

export type TransceiverInfo = LayoutToType<typeof transceiverInfo>;
export const transceiverInfo = [
  prefixItem([0x9c, 0x23, 0xbd, 0x3b]),
  { name: "managerAddress", ...layoutItems.universalAddressItem },
  { name: "mode", binary: "uint", size: 1 },
  { name: "token", ...layoutItems.universalAddressItem },
  { name: "decimals", binary: "uint", size: 1 },
] as const satisfies Layout;

//
export type TransceiverRegistration = LayoutToType<
  typeof transceiverRegistration
>;
export const transceiverRegistration = [
  prefixItem([0x18, 0xfc, 0x67, 0xc2]),
  { name: "chain", ...layoutItems.chainItem() },
  { name: "transceiver", ...layoutItems.universalAddressItem },
] as const satisfies Layout;
