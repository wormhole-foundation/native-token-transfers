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
import { encodeAccountID, SubmittableTransaction } from "xrpl";
import { nttTransferLayout } from "./layouts.js";

/**
 * Convert a universal/hex manager address (32 bytes, 0x-prefixed)
 * to a native XRPL r-address. The XRPL account ID occupies the
 * last 20 bytes of the 32-byte universal address.
 */
export function universalToXrplAddress(hexAddress: string): string {
  const bytes = encoding.hex.decode(hexAddress.replace(/^0x/, ""));
  const accountId = bytes.slice(bytes.length - 20);
  return encodeAccountID(Buffer.from(accountId));
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

  if (contracts.ntt!["token"] !== "native") {
    throw new Error("Not implemented for non-XRP tokens");
  }

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

  const Destination = universalToXrplAddress(contracts.ntt!["manager"]);

  const payment: SubmittableTransaction = {
    TransactionType: "Payment",
    Account: sender.toString(),
    Destination,
    Amount: amount.toString(),
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
