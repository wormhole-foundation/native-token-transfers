import type {
  AccountAddress,
  Chain,
  ChainAddress,
  EmptyPlatformMap,
  Network,
  TokenAddress,
  TokenId,
  UnsignedTransaction,
} from "@wormhole-foundation/sdk-connect";
import { NttWithExecutor } from "./nttWithExecutor.js";

export namespace MultiTokenNttWithExecutor {
  // TODO: move NttWithExecutor.Quote to a common place?
  export type Quote = NttWithExecutor.Quote;
}

// Protocol definition for MultiTokenNttWithExecutor
// This extends the regular NttWithExecutor with multi-token support
export interface MultiTokenNttWithExecutor<N extends Network, C extends Chain> {
  // The main transfer method for multi-token NTT with executor
  // Similar to NttWithExecutor but includes token parameter
  transfer(
    sender: AccountAddress<C>,
    destination: ChainAddress,
    token: TokenId<C>,
    amount: bigint,
    quote: MultiTokenNttWithExecutor.Quote
  ): AsyncGenerator<UnsignedTransaction<N, C>>;

  estimateMsgValueAndGasLimit(
    token: TokenAddress<C>,
    recipient: ChainAddress | undefined
  ): Promise<{ msgValue: bigint; gasLimit: bigint }>;
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
