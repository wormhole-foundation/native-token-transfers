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
    transceiver: {
      wormhole?: string;
    };
  };

  export type Message = NttManagerMessage<
    ReturnType<
      typeof genericMessageLayout<typeof multiTokenNativeTokenTransferLayout>
    >
  >;

  export type TransferOptions = {
    // The gas limit used by the wormhole standard relayer to deliver the message
    // to the destination chain. Should be high enough to cover
    // the cost of the message delivery or delivery will fail.
    relayerGasLimit: bigint;
  };

  export type OriginalTokenId<C extends Chain = Chain> = {
    chain: C;
    address: UniversalAddress;
  };

  // TODO: what are the set of attestation types for Ntt?
  // can we know this ahead of time or does it need to be
  // flexible enough for folks to add their own somehow?
  export type Attestation =
    VAA<"MultiTokenNtt:WormholeTransferStandardRelayer">;

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

  /** Check to see if relaying service is available for automatic transfers */
  isRelayingAvailable(destination: Chain): Promise<boolean>;

  /**
   * quoteDeliveryPrice returns the price to deliver a message to a given chain
   * the price is quote in native gas
   *
   * @param destination the destination chain
   * @param flags the flags to use for the delivery
   */
  quoteDeliveryPrice(
    destination: Chain,
    options: MultiTokenNtt.TransferOptions
  ): Promise<bigint>;

  /**
   * transfer sends a message to the Ntt manager to initiate a transfer
   * @param sender the address of the sender
   * @param token the token to transfer
   * @param amount the amount to transfer
   * @param destination the destination chain
   * @param queue whether to queue the transfer if the outbound capacity is exceeded
   * @param relay whether to relay the transfer
   */
  transfer(
    sender: AccountAddress<C>,
    token: TokenAddress<C>,
    amount: bigint,
    destination: ChainAddress,
    options: MultiTokenNtt.TransferOptions
  ): AsyncGenerator<UnsignedTransaction<N, C>>;

  /**
   * redeem redeems a set of Attestations to the corresponding transceivers on the destination chain
   * @param attestations The attestations to redeem, the length should be equal to the number of transceivers
   */
  redeem(
    attestations: MultiTokenNtt.Attestation[],
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>>;

  // TODO: these methods probably belong on the platform
  getTokenName(token: TokenId): Promise<string>;
  getTokenSymbol(token: TokenId): Promise<string>;
  getTokenDecimals(token: TokenId): Promise<number>;

  /**
   * getCurrentOutboundCapacity returns the current outbound capacity of the token
   */
  getCurrentOutboundCapacity(token: TokenId): Promise<bigint>;

  /**
   * getOutboundLimit returns the maximum outbound capacity of the token
   */
  getOutboundLimit(token: TokenId): Promise<bigint>;

  /**
   * getCurrentInboundCapacity returns the current inbound capacity of the token from a given chain
   */
  getCurrentInboundCapacity(
    originalToken: MultiTokenNtt.OriginalTokenId,
    fromChain: Chain
  ): Promise<bigint>;

  /**
   * getRateLimitDuration returns the duration of the rate limit for queued transfers in seconds
   */
  getRateLimitDuration(): Promise<bigint>;

  /**
   * getInboundLimit returns the maximum inbound capacity of the token from a given chain
   */
  getInboundLimit(
    originalToken: MultiTokenNtt.OriginalTokenId,
    fromChain: Chain
  ): Promise<bigint | null>;

  /**
   * getIsApproved returns whether an attestation is approved
   * an attestation is approved when it has been validated but has not necessarily
   * been executed
   *
   * @param attestation the attestation to check
   */
  getIsApproved(attestation: MultiTokenNtt.Attestation): Promise<boolean>;

  /**
   * getIsExecuted returns whether an attestation is executed
   * an attestation being executed means the transfer is complete
   *
   * @param attestation the attestation to check
   */
  getIsExecuted(attestation: MultiTokenNtt.Attestation): Promise<boolean>;

  /**
   * getIsTransferInboundQueued returns whether the transfer is inbound queued
   * @param attestation the attestation to check
   */
  getIsTransferInboundQueued(
    attestation: MultiTokenNtt.Attestation
  ): Promise<boolean>;

  /**
   * getInboundQueuedTransfer returns the details of an inbound queued transfer
   * @param transceiverMessage the transceiver message
   * @param fromChain the chain the transfer is from
   */
  getInboundQueuedTransfer(
    fromChain: Chain,
    transceiverMessage: MultiTokenNtt.Message
  ): Promise<Ntt.InboundQueuedTransfer<C> | null>;
  /**
   * completeInboundQueuedTransfer completes an inbound queued transfer
   * @param fromChain the chain the transfer is from
   * @param transceiverMessage the transceiver message
   * @param payer the address to pay for the transfer
   */
  completeInboundQueuedTransfer(
    fromChain: Chain,
    transceiverMessage: MultiTokenNtt.Message,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>>;

  getOriginalToken(localToken: TokenId): Promise<MultiTokenNtt.OriginalTokenId>;

  getLocalToken(
    originalToken: MultiTokenNtt.OriginalTokenId
  ): Promise<TokenId | null>;

  calculateLocalTokenAddress(
    originalToken: MultiTokenNtt.OriginalTokenId,
    tokenName: string,
    tokenSymbol: string,
    tokenDecimals: number
  ): Promise<TokenAddress<C>>;

  getWrappedNativeToken(): Promise<TokenId>;
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
