import {
  CustomConversion,
  customizableBytes,
  CustomizableBytes,
  Layout,
  LayoutToType,
} from "@wormhole-foundation/sdk-base";
import { layoutItems } from "@wormhole-foundation/sdk-definitions";
import { trimmedAmountItem } from "./amount.js";
import { prefixItem } from "./prefix.js";

function deserializeNum(encoded: Uint8Array, size: number): number {
  let val = 0n;
  for (let i = 0; i < size; ++i)
    val |= BigInt(encoded[i]!) << BigInt(8 * (size - i - 1));

  return Number(val);
}

export function serializeNum(val: number, size: number): Uint8Array {
  const bound = 2n ** BigInt(size * 8);
  if (val >= bound)
    throw new Error(`Value ${val} is too large for ${size} bytes`);

  const arr = new Uint8Array(size);

  //correctly handles both signed and unsigned values
  for (let i = 0; i < size; ++i)
    arr[i] = Number((BigInt(val) >> BigInt(8 * (size - i - 1))) & 0xffn);

  return arr;
}

const optionalAdditionalPayloadItem = {
  binary: "bytes",
  custom: {
    to: (val: Uint8Array) => {
      if (val.byteLength >= 2) {
        const additionalPayloadLen = deserializeNum(val, 2);
        return val.slice(2, 2 + additionalPayloadLen);
      }
      return new Uint8Array();
    },
    from: (val: Uint8Array) => {
      if (val.byteLength > 0) {
        return new Uint8Array([...serializeNum(val.byteLength, 2), ...val]);
      }
      return new Uint8Array();
    },
  } satisfies CustomConversion<Uint8Array, Uint8Array>,
} as const satisfies Layout;

export type NativeTokenTransfer = LayoutToType<
  typeof nativeTokenTransferLayout
>;
/** Describes binary layout for a native token transfer payload */
export const nativeTokenTransferLayout = [
  prefixItem([0x99, 0x4e, 0x54, 0x54]),
  { name: "trimmedAmount", ...trimmedAmountItem },
  { name: "sourceToken", ...layoutItems.universalAddressItem },
  { name: "recipientAddress", ...layoutItems.universalAddressItem },
  { name: "recipientChain", ...layoutItems.chainItem() },
  { name: "additionalPayload", ...optionalAdditionalPayloadItem },
] as const satisfies Layout;

////////////////////////// multi-token-transfer //////////////////////////

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

// TODO: this doesn't belong here, put it in a gmp layout file
export const genericMessageLayout = <D extends CustomizableBytes>(data?: D) =>
  [
    prefixItem([0x99, 0x47, 0x4d, 0x50]),
    { name: "toChain", ...layoutItems.chainItem() },
    { name: "callee", ...layoutItems.universalAddressItem },
    { name: "sender", ...layoutItems.universalAddressItem },
    customizableBytes({ name: "data", lengthSize: 2 }, data),
  ] as const satisfies Layout;
