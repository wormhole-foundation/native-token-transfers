import type {
  AccountAddress,
  Chain,
  ChainAddress,
  EmptyPlatformMap,
  Network,
  TokenId,
  UnsignedTransaction,
} from "@wormhole-foundation/sdk-connect";
import { NttWithExecutor } from "./nttWithExecutor.js";
import { Ntt } from "./ntt.js";

export namespace MultiTokenNttWithExecutor {
  export type Quote = NttWithExecutor.Quote & {
    deliveryPrice: bigint;
    transceiverInstructions: Ntt.TransceiverInstruction[];
  };
}

export interface MultiTokenNttWithExecutor<N extends Network, C extends Chain> {
  transfer(
    sender: AccountAddress<C>,
    destination: ChainAddress,
    token: TokenId<C>,
    amount: bigint,
    quote: MultiTokenNttWithExecutor.Quote
  ): AsyncGenerator<UnsignedTransaction<N, C>>;
}

declare module "@wormhole-foundation/sdk-definitions" {
  export namespace WormholeRegistry {
    interface ProtocolToInterfaceMapping<N, C> {
      MultiTokenNttWithExecutor: MultiTokenNttWithExecutor<N, C>;
    }
    interface ProtocolToPlatformMapping {
      MultiTokenNttWithExecutor: EmptyPlatformMap<"MultiTokenNttWithExecutor">;
    }
  }
}
