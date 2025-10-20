import { layoutItems } from "@wormhole-foundation/sdk-definitions";
import {
  CustomizableBytes,
  Layout,
  LayoutToType,
  customizableBytes,
} from "@wormhole-foundation/sdk-base";

export type NttManagerMessage<P extends CustomizableBytes = undefined> =
  LayoutToType<ReturnType<typeof nttManagerMessageLayout<P>>>;

export const nttManagerMessageLayout = <
  const P extends CustomizableBytes = undefined,
>(
  customPayload?: P
) =>
  [
    { name: "id", binary: "bytes", size: 32 },
    { name: "sender", ...layoutItems.universalAddressItem },
    customizableBytes({ name: "payload", lengthSize: 2 }, customPayload),
  ] as const satisfies Layout;
