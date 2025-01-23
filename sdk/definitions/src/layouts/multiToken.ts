import {
  customizableBytes,
  CustomizableBytes,
  Layout,
} from "@wormhole-foundation/sdk-base";
import { layoutItems } from "@wormhole-foundation/sdk-definitions";
import { trimmedAmountItem } from "./amount.js";
import { prefixItem } from "./prefix.js";

// MultiTokenNtt layouts

const tokenMetaLayout = [
  { name: "name", ...layoutItems.universalAddressItem },
  { name: "symbol", ...layoutItems.universalAddressItem },
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

// TODO: why is this different for multi-token transfers?
export const multiTokenNativeTokenTransferLayout = [
  prefixItem([0x99, 0x4e, 0x54, 0x54]),
  { name: "trimmedAmount", ...trimmedAmountItem },
  { name: "token", ...tokenInfoLayoutItem },
  { name: "sender", ...layoutItems.universalAddressItem },
  { name: "to", ...layoutItems.universalAddressItem },
] as const satisfies Layout;

/*
    /// @dev Prefix for all GenericMesage payloads
    ///      This is 0x99'G''M''P'
    bytes4 constant GMP_PREFIX = 0x99474D50;

    struct GenericMessage {
        /// @notice target chain
        uint16 toChain;
        /// @notice contract to deliver the payload to
        bytes32 callee;
        /// @notice sender of the message
        bytes32 sender;
        /// @notice calldata to pass to the recipient contract
        bytes data;
    }
*/

// TODO: where does this belong?
export const genericMessageLayout = <D extends CustomizableBytes>(data?: D) =>
  [
    prefixItem([0x99, 0x47, 0x4d, 0x50]),
    { name: "toChain", ...layoutItems.chainItem() },
    { name: "callee", ...layoutItems.universalAddressItem },
    { name: "sender", ...layoutItems.universalAddressItem },
    customizableBytes({ name: "data", lengthSize: 2 }, data),
  ] as const satisfies Layout;
