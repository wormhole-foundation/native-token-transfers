import {
  encoding,
  serializeLayout,
  toChainId,
} from "@wormhole-foundation/sdk-base";
import {
  ChainAddress,
  Contracts,
  toUniversal,
} from "@wormhole-foundation/sdk-definitions";
import { Ntt } from "@wormhole-foundation/sdk-definitions-ntt";
import {
  Amount,
  decodeAccountID,
  encodeAccountID,
  isValidClassicAddress,
  MPTAmount,
  SubmittableTransaction,
} from "xrpl";
import { nttTransferLayout } from "./layouts.js";

/**
 * Convert an address to a native XRPL r-address.
 * Accepts either a universal hex address (32 bytes, optionally 0x-prefixed)
 * or a native XRPL r-address (returned as-is).
 */
export function toXrplAddress(address: string): string {
  if (isValidClassicAddress(address)) {
    return address;
  }
  const bytes = encoding.hex.decode(address.replace(/^0x/, ""));
  const accountId = bytes.slice(bytes.length - 20);
  return encodeAccountID(Buffer.from(accountId));
}

/**
 * Convert an address to a 32-byte universal representation.
 * Accepts either a hex universal address (returned as raw bytes)
 * or a native XRPL r-address (decoded and zero-padded to 32 bytes).
 */
export function xrplAddressToUniversalBytes(address: string): Uint8Array {
  if (isValidClassicAddress(address)) {
    const accountId = decodeAccountID(address);
    const universal = new Uint8Array(32);
    universal.set(accountId, 32 - accountId.length);
    return universal;
  }
  return encoding.hex.decode(address.replace(/^0x/, ""));
}

/** Convert a ChainAddress destination to its 32-byte representation. */
export function destinationAddressToBytes(
  destination: ChainAddress
): Uint8Array {
  try {
    if (typeof destination.address.toUint8Array === "function") {
      return destination.address.toUint8Array();
    } else if (typeof destination.address.toUniversalAddress === "function") {
      const universalAddr = destination.address.toUniversalAddress();
      if (!universalAddr) {
        throw new Error("toUniversalAddress() returned null or undefined");
      }
      return universalAddr.toUint8Array();
    } else {
      throw new Error(
        `destination.address does not have expected methods. Type: ${typeof destination.address}`
      );
    }
  } catch (error) {
    throw new Error(
      `Failed to convert destination address to bytes: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Convert a bigint amount in the smallest unit to a decimal string
 * representation for XRPL IOU amounts.
 * e.g. toDecimalValue(1000n, 9) => "0.000001"
 */
export function toDecimalValue(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();

  const str = amount.toString().padStart(decimals + 1, "0");
  const intPart = str.slice(0, str.length - decimals);
  const fracPart = str.slice(str.length - decimals).replace(/0+$/, "");

  return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
}

export function prepareAmount(
  amount: bigint,
  contracts: Contracts & { ntt?: Ntt.Contracts },
  decimals: number
): Amount | MPTAmount {
  const token: string = contracts.ntt!["token"];

  if (token === "native") {
    return amount.toString();
  }

  // IOU token: "CURRENCY.rIssuerAddress"
  if (token.includes(".")) {
    const [currency, issuer] = token.split(".", 2) as [string, string];
    return { currency, issuer, value: toDecimalValue(amount, decimals) };
  }

  // MPT token: hex issuance ID (e.g. "00ef0c086c...")
  if (/^[0-9a-fA-F]{48}$/.test(token)) {
    return { mpt_issuance_id: token, value: amount.toString() };
  }

  throw new Error(`unsupported token: ${token}`);
}

/** Build the NTT Payment transaction and return it along with the recipientManagerAddress. */
export async function buildNttPayment(opts: {
  sender: { toString(): string };
  amount: bigint;
  destination: ChainAddress;
  contracts: Contracts & { ntt?: Ntt.Contracts };
  getTokenDecimals: () => Promise<number>;
}): Promise<{
  payment: SubmittableTransaction;
  recipientManagerAddress: Uint8Array;
}> {
  const { sender, amount, destination, contracts } = opts;

  const peer = contracts.ntt!.peers?.[destination.chain];
  if (!peer) {
    throw new Error(`No peer configured for chain: ${destination.chain}`);
  }
  if (peer.tokenDecimals === undefined) {
    throw new Error("No token decimals configured for peer");
  }

  const recipientManagerAddress = toUniversal(
    destination.chain,
    peer.manager
  ).toUint8Array();

  const destinationAddressBytes = destinationAddressToBytes(destination);

  const memoData = encoding.hex.encode(
    new Uint8Array(
      serializeLayout(nttTransferLayout, {
        recipient_ntt_manager_address: recipientManagerAddress,
        recipient_address: destinationAddressBytes,
        recipient_chain: toChainId(destination.chain),
        from_decimals: await opts.getTokenDecimals(),
        to_decimals: peer.tokenDecimals,
      })
    )
  );

  const Destination = toXrplAddress(contracts.ntt!["manager"]);

  const payment: SubmittableTransaction = {
    TransactionType: "Payment",
    Account: sender.toString(),
    Destination,
    Amount: prepareAmount(amount, contracts, await opts.getTokenDecimals()),
    Memos: [
      {
        Memo: {
          MemoFormat: encoding.hex.encode("application/x-ntt-transfer"),
          MemoData: memoData,
        },
      },
    ],
  };

  return { payment, recipientManagerAddress };
}
