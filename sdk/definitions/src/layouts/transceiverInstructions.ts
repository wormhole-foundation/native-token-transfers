import {
  customizableBytes,
  type CustomizableBytes,
  type Layout,
} from "@wormhole-foundation/sdk-base";

export const transceiverInstructionLayout = <
  const P extends CustomizableBytes = undefined,
>(
  customPayload?: P
) =>
  [
    { name: "index", binary: "uint", size: 1 },
    customizableBytes({ name: "payload", lengthSize: 1 }, customPayload),
  ] as const satisfies Layout;
