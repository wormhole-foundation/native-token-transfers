import {
  encoding,
  serializeLayout,
  toChainId,
  type Chain,
  type Network,
} from "@wormhole-foundation/sdk-base";

import {
  AccountAddress,
  ChainAddress,
  EmptyPlatformMap,
  TokenAddress,
  TokenId,
  UniversalAddress,
  UnsignedTransaction,
  VAA,
  keccak256,
} from "@wormhole-foundation/sdk-definitions";

import {
  NttManagerMessage,
  genericMessageLayout,
  multiTokenNativeTokenTransferLayout,
  nttManagerMessageLayout,
} from "./layouts/index.js";

import { Ntt } from "./ntt.js";

export namespace MultiTokenNtt {
  const _protocol = "MultiTokenNtt";
  export type ProtocolName = typeof _protocol;

  export type Contracts = {
    chain: Chain;
    manager: string;
    gmpManager: string;
    axelarGasMultiplier?: number | "auto";
  };

  export interface TokenMeta {
    name: string;
    symbol: string;
    decimals: number;
  }

  export type Message = NttManagerMessage<
    ReturnType<
      typeof genericMessageLayout<typeof multiTokenNativeTokenTransferLayout>
    >
  >;

  export type OriginalTokenId<C extends Chain = Chain> = {
    chain: C;
    address: UniversalAddress;
  };

  export type Attestation = VAA<"MultiTokenNtt:WormholeTransfer">;

  export type InboundQueuedTransfer = {
    sourceChain: Chain;
    rateLimitExpiryTimestamp: number;
  };

  /**
   * messageDigest hashes a message for the Ntt manager, the digest is used
   * to uniquely identify the message
   * @param chain The chain that sent the message
   * @param message The ntt message to hash
   * @returns a 32 byte digest of the message
   */
  export function messageDigest(chain: Chain, message: Message): Uint8Array {
    return keccak256(
      encoding.bytes.concat(
        encoding.bignum.toBytes(toChainId(chain), 2),
        serializeLayout(
          nttManagerMessageLayout(
            genericMessageLayout(multiTokenNativeTokenTransferLayout)
          ),
          message
        )
      )
    );
  }
}

export interface MultiTokenNtt<N extends Network, C extends Chain> {
  isPaused(): Promise<boolean>;

  getSendTransceivers(dstChain: Chain): Promise<Ntt.TransceiverMeta[]>;

  getReceiveTransceivers(srcChain: Chain): Promise<Ntt.TransceiverMeta[]>;

  transceiverAttestedToMessage(
    fromChain: Chain,
    transceiverMessage: MultiTokenNtt.Message,
    index: number
  ): Promise<boolean>;

  createTransceiverInstructions(
    dstChain: Chain,
    gasLimit: bigint,
    axelarGasMultiplier?: number | "auto"
  ): Promise<Ntt.TransceiverInstruction[]>;

  quoteDeliveryPrice(
    destination: Chain,
    instructions: Ntt.TransceiverInstruction[]
  ): Promise<bigint>;

  transfer(
    sender: AccountAddress<C>,
    token: TokenAddress<C>,
    amount: bigint,
    destination: ChainAddress,
    destinationGasLimit: bigint,
    axelarGasMultiplier?: number | "auto"
  ): AsyncGenerator<UnsignedTransaction<N, C>>;

  redeem(
    attestation: MultiTokenNtt.Attestation
  ): AsyncGenerator<UnsignedTransaction<N, C>>;

  getTokenMeta(token: TokenId): Promise<MultiTokenNtt.TokenMeta>;

  getCurrentOutboundCapacity(token: TokenId): Promise<bigint>;

  getOutboundLimit(token: TokenId): Promise<bigint>;

  getCurrentInboundCapacity(
    originalToken: MultiTokenNtt.OriginalTokenId,
    fromChain: Chain
  ): Promise<bigint>;

  getRateLimitDuration(): Promise<bigint>;

  getInboundLimit(
    originalToken: MultiTokenNtt.OriginalTokenId,
    fromChain: Chain
  ): Promise<bigint | null>;

  getIsApproved(attestation: MultiTokenNtt.Attestation): Promise<boolean>;

  getIsExecuted(attestation: MultiTokenNtt.Attestation): Promise<boolean>;

  getIsTransferInboundQueued(
    attestation: MultiTokenNtt.Attestation
  ): Promise<boolean>;

  getInboundQueuedTransfer(
    fromChain: Chain,
    transceiverMessage: MultiTokenNtt.Message
  ): Promise<MultiTokenNtt.InboundQueuedTransfer | null>;

  completeInboundQueuedTransfer(
    fromChain: Chain,
    transceiverMessage: MultiTokenNtt.Message
  ): AsyncGenerator<UnsignedTransaction<N, C>>;

  getOriginalToken(localToken: TokenId): Promise<MultiTokenNtt.OriginalTokenId>;

  isWrappedToken(localToken: TokenId): Promise<boolean>;

  getLocalToken(
    originalToken: MultiTokenNtt.OriginalTokenId
  ): Promise<TokenId | null>;

  calculateLocalTokenAddress(
    originalToken: MultiTokenNtt.OriginalTokenId,
    tokenMeta: MultiTokenNtt.TokenMeta
  ): Promise<TokenAddress<C>>;

  getWrappedNativeToken(): Promise<TokenId>;

  estimateGasLimit(
    originalToken: MultiTokenNtt.OriginalTokenId
  ): Promise<bigint>;
}

declare module "@wormhole-foundation/sdk-definitions" {
  export namespace WormholeRegistry {
    interface ProtocolToInterfaceMapping<N, C> {
      MultiTokenNtt: MultiTokenNtt<N, C>;
    }
    interface ProtocolToPlatformMapping {
      MultiTokenNtt: EmptyPlatformMap<MultiTokenNtt.ProtocolName>;
    }
  }
}
