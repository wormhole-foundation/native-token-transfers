import type { Chain, Network } from "@wormhole-foundation/sdk-base";
import {
  type AccountAddress,
  type ChainAddress,
  type EmptyPlatformMap,
  UnsignedTransaction,
} from "@wormhole-foundation/sdk-definitions";
import { Ntt } from "./ntt.js";

export namespace NttWithExecutor {
  export type Quote = {
    signedQuote: Uint8Array; // The signed quote from the /v0/quote endpoint
    relayInstructions: Uint8Array; // The relay instructions for the transfer
    estimatedCost: bigint; // The estimated cost of the transfer in native token base units
    payeeAddress: Uint8Array; // The wallet address on the source chain, designated by the Quoter, to receive funds when requesting an execution
    referrer: ChainAddress; // The referrer address (to whom the fees should be paid)
    transferTokenFee: bigint; // Fee in transfer token base units, deducted from the transfer amount
    nativeTokenFee: bigint; // Fee in native token base units
    remainingAmount: bigint; // The amount after fee deduction (what gets bridged)
    expires: Date; // The expiry time of the quote
    gasDropOff: bigint; // The gas drop-off amount in native token base units
  };
}

export interface NttWithExecutor<N extends Network, C extends Chain> {
  transfer(
    sender: AccountAddress<C>,
    destination: ChainAddress,
    amount: bigint,
    quote: NttWithExecutor.Quote,
    ntt: Ntt<N, C>,
    wrapNative?: boolean
  ): AsyncGenerator<UnsignedTransaction<N, C>>;

  estimateMsgValueAndGasLimit(
    recipient: ChainAddress | undefined
  ): Promise<{ msgValue: bigint; gasLimit: bigint }>;
}

declare module "@wormhole-foundation/sdk-definitions" {
  export namespace WormholeRegistry {
    interface ProtocolToInterfaceMapping<N, C> {
      NttWithExecutor: NttWithExecutor<N, C>;
    }
    interface ProtocolToPlatformMapping {
      NttWithExecutor: EmptyPlatformMap<"NttWithExecutor">;
    }
  }
}
