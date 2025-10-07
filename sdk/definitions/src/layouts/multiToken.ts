import {
  customizableBytes,
  CustomizableBytes,
  Layout,
} from "@wormhole-foundation/sdk-base";
import { layoutItems } from "@wormhole-foundation/sdk-definitions";
import { trimmedAmountItem } from "./amount.js";
import { prefixItem } from "./prefix.js";

const tokenMetaLayout = [
  { name: "name", ...layoutItems.fixedLengthStringItem(32) },
  { name: "symbol", ...layoutItems.fixedLengthStringItem(32) },
  { name: "decimals", binary: "uint", size: 1 },
] as const satisfies Layout;

export const tokenMetaLayoutItem = {
  binary: "bytes",
  layout: tokenMetaLayout,
} as const;

const tokenIdLayout = [
  { name: "chainId", ...layoutItems.chainItem() },
  { name: "tokenAddress", ...layoutItems.universalAddressItem },
] as const satisfies Layout;

export const tokenIdLayoutItem = {
  binary: "bytes",
  layout: tokenIdLayout,
} as const;

const tokenInfoLayout = [
  { name: "meta", ...tokenMetaLayoutItem },
  { name: "token", ...tokenIdLayoutItem },
] as const satisfies Layout;

export const tokenInfoLayoutItem = {
  binary: "bytes",
  layout: tokenInfoLayout,
} as const;

export const multiTokenNativeTokenTransferLayout = [
  // bytes4 constant MTT_PREFIX = 0x994D5454;
  prefixItem([0x99, 0x4d, 0x54, 0x54]),
  { name: "trimmedAmount", ...trimmedAmountItem },
  { name: "token", ...tokenInfoLayoutItem },
  { name: "sender", ...layoutItems.universalAddressItem },
  { name: "to", ...layoutItems.universalAddressItem },
  customizableBytes({ name: "additionalPayload", lengthSize: 2 }),
] as const satisfies Layout;

// GmpManager message layout
export const genericMessageLayout = <D extends CustomizableBytes>(data?: D) =>
  [
    prefixItem([0x99, 0x47, 0x4d, 0x50]),
    { name: "toChain", ...layoutItems.chainItem() },
    { name: "callee", ...layoutItems.universalAddressItem },
    { name: "sender", ...layoutItems.universalAddressItem },
    customizableBytes({ name: "data", lengthSize: 2 }, data),
  ] as const satisfies Layout;
