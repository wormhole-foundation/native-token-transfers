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
import type { MultiTokenNtt } from "./multiTokenNtt.js";

export namespace MultiTokenNttWithExecutor {
  export type Quote = NttWithExecutor.Quote;
}

export interface MultiTokenNttWithExecutor<N extends Network, C extends Chain> {
  transfer(
    sender: AccountAddress<C>,
    destination: ChainAddress,
    token: TokenId<C>,
    amount: bigint,
    quote: MultiTokenNttWithExecutor.Quote,
    multiTokenNtt: MultiTokenNtt<N, C>
  ): AsyncGenerator<UnsignedTransaction<N, C>>;

  estimateMsgValueAndGasLimit(
    originalToken: MultiTokenNtt.OriginalTokenId,
    multiTokenNtt: MultiTokenNtt<N, C>
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
