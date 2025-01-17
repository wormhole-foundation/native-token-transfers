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
  ProtocolPayload,
  ProtocolVAA,
  UnsignedTransaction,
  VAA,
  keccak256,
} from "@wormhole-foundation/sdk-definitions";

import {
  NttManagerMessage,
  nativeTokenTransferLayout,
  nttManagerMessageLayout,
  transceiverInfo,
  transceiverInstructionLayout,
  transceiverRegistration,
} from "./layouts/index.js";
import { PublicKey } from "@solana/web3.js";

/**
 * @namespace Ntt
 */
export namespace Ntt {
  const _protocol = "Ntt";
  export type ProtocolName = typeof _protocol;

  export type Mode = "locking" | "burning";
  export type Contracts = {
    token: string;
    manager: string;
    transceiver: {
      [type: string]: string;
    };
    quoter?: string;
  };

  export type Message = NttManagerMessage<typeof nativeTokenTransferLayout>;

  export type TransceiverInfo = NttManagerMessage<typeof transceiverInfo>;
  export type TransceiverRegistration = NttManagerMessage<
    typeof transceiverRegistration
  >;

  export type TransferOptions = {
    /** Whether or not to queue the transfer if the outbound capacity is exceeded */
    queue: boolean;
    /** Whether or not to request this transfer should be relayed, otherwise manual redemption is required */
    automatic?: boolean;
    /** How much native gas on the destination to send along with the transfer */
    gasDropoff?: bigint;
  };

  // TODO: what are the set of attestation types for Ntt?
  // can we know this ahead of time or does it need to be
  // flexible enough for folks to add their own somehow?
  export type Attestation =
    | VAA<"Ntt:WormholeTransfer">
    | VAA<"Ntt:WormholeTransferStandardRelayer">;

  /**
   * InboundQueuedTransfer is a queued transfer from another chain
   * @property recipient the recipient of the transfer
   * @property amount the amount of the transfer
   * @property rateLimitExpiryTimestamp the timestamp when the rate limit expires
   */
  export type InboundQueuedTransfer<C extends Chain> = {
    recipient: AccountAddress<C>;
    amount: bigint;
    rateLimitExpiryTimestamp: number;
  };
  /**
   * TransceiverInstruction is a single instruction for the transceiver
   * @property index the index of the instruction, may not be > 255
   * @property payload the payload of the instruction, may not exceed 255 bytes
   */
  export type TransceiverInstruction = {
    index: number;
    payload: Uint8Array;
  };

  export type Peer<C extends Chain> = {
    address: ChainAddress<C>;
    tokenDecimals: number;
    gasLimit: bigint;
    inboundLimit: bigint;
  };

  // TODO: should layoutify this but couldnt immediately figure out how to
  // specify the length of the array as an encoded value
  export function encodeTransceiverInstructions(ixs: TransceiverInstruction[]) {
    if (ixs.length > 255)
      throw new Error(`Too many instructions (${ixs.length})`);
    return encoding.bytes.concat(
      new Uint8Array([ixs.length]),
      ...ixs.map((ix) => serializeLayout(transceiverInstructionLayout(), ix))
    );
  }

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
          nttManagerMessageLayout(nativeTokenTransferLayout),
          message
        )
      )
    );
  }

  // Checks for compatibility between the Contract version in use on chain,
  // and the ABI version the SDK has. Major version must match, minor version on chain
  // should be gte SDK's ABI version.
  //
  // For example, if the contract is using 1.1.0, we would use 1.0.0 but not 1.2.0.
  export function abiVersionMatches(
    targetVersion: string,
    abiVersion: string
  ): boolean {
    const parseVersion = (version: string) => {
      // allow optional tag on patch version
      const versionRegex = /^(\d+)\.(\d+)\.(.*)$/;
      const match = version.match(versionRegex);
      if (!match) {
        throw new Error(`Invalid version format: ${version}`);
      }
      const [, major, minor, patchAndTag] = match;
      return { major: Number(major), minor: Number(minor), patchAndTag };
    };
    const { major: majorTarget, minor: minorTarget } =
      parseVersion(targetVersion);
    const { major: majorAbi, minor: minorAbi } = parseVersion(abiVersion);
    return majorTarget === majorAbi && minorTarget >= minorAbi;
  }
}

/**
 * Ntt is the interface for the Ntt
 *
 * The Ntt is responsible for managing the coordination between the token contract and
 * the transceiver(s). It is also responsible for managing the capacity of inbound or outbount transfers.
 *
 * @typeparam N the network
 * @typeparam C the chain
 */
export interface Ntt<N extends Network, C extends Chain> {
  getMode(): Promise<Ntt.Mode>;

  isPaused(): Promise<boolean>;

  pause(payer?: AccountAddress<C>): AsyncGenerator<UnsignedTransaction<N, C>>;

  unpause(payer?: AccountAddress<C>): AsyncGenerator<UnsignedTransaction<N, C>>;

  getOwner(): Promise<AccountAddress<C>>;

  getPauser(): Promise<AccountAddress<C> | null>;

  setOwner(
    newOwner: AccountAddress<C>,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>>;

  setPauser(
    newOwner: AccountAddress<C>,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>>;

  getThreshold(chainId: number): Promise<number>;

  setPeer(
    peer: ChainAddress,
    tokenDecimals: number,
    gasLimit: bigint,
    inboundLimit: bigint,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>>;

  // TODO: replace ix with transceiver type
  setTransceiverPeer(
    ix: number,
    peer: ChainAddress,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>>;

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
    options: Ntt.TransferOptions
  ): Promise<bigint>;

  /**
   * transfer sends a message to the Ntt manager to initiate a transfer
   * @param sender the address of the sender
   * @param amount the amount to transfer
   * @param destination the destination chain
   * @param queue whether to queue the transfer if the outbound capacity is exceeded
   * @param relay whether to relay the transfer
   */
  transfer(
    sender: AccountAddress<C>,
    amount: bigint,
    destination: ChainAddress,
    options: Ntt.TransferOptions
  ): AsyncGenerator<UnsignedTransaction<N, C>>;

  /**
   * redeem redeems a set of Attestations to the corresponding transceivers on the destination chain
   * @param attestations The attestations to redeem, the length should be equal to the number of transceivers
   *
   * TODO: replace with Map<transceiver type, Attestation>
   */
  redeem(
    attestations: Ntt.Attestation[],
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>>;

  /** Get the address for the account that custodies locked tokens  */
  getCustodyAddress(): Promise<string>;

  /** Get the number of decimals associated with the token under management */
  getTokenDecimals(): Promise<number>;

  /** Get the peer information for the given chain if it exists */
  getPeer<C extends Chain>(chain: C): Promise<Ntt.Peer<C> | null>;

  /** Get the transceiver corresponding to index (0 = Wormhole)
   *
   * TODO: replace ix with transceiver type
   */
  getTransceiver(
    ix: number
  ): Promise<NttTransceiver<N, C, Ntt.Attestation> | null>;

  /**
   * getCurrentOutboundCapacity returns the current outbound capacity of the Ntt manager
   */
  getCurrentOutboundCapacity(): Promise<bigint>;

  /**
   * getOutboundLimit returns the maximum outbound capacity of the Ntt manager
   */
  getOutboundLimit(): Promise<bigint>;

  /**
   * setOutboundLimit sets the maximum outbound capacity of the Ntt manager
   */
  setOutboundLimit(
    limit: bigint,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>>;

  /**
   * getCurrentInboundCapacity returns the current inbound capacity of the Ntt manager
   * @param fromChain the chain to check the inbound capacity for
   */
  getCurrentInboundCapacity(fromChain: Chain): Promise<bigint>;

  /**
   * getRateLimitDuration returns the duration of the rate limit for queued transfers in seconds
   */
  getRateLimitDuration(): Promise<bigint>;

  /**
   * getInboundLimit returns the maximum inbound capacity of the Ntt manager
   * @param fromChain the chain to check the inbound limit for
   */
  getInboundLimit(fromChain: Chain): Promise<bigint>;

  setInboundLimit(
    fromChain: Chain,
    limit: bigint,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>>;

  /**
   * getIsApproved returns whether an attestation is approved
   * an attestation is approved when it has been validated but has not necessarily
   * been executed
   *
   * @param attestation the attestation to check
   */
  getIsApproved(attestation: Ntt.Attestation): Promise<boolean>;

  /**
   * getIsExecuted returns whether an attestation is executed
   * an attestation being executed means the transfer is complete
   *
   * @param attestation the attestation to check
   */
  getIsExecuted(attestation: Ntt.Attestation): Promise<boolean>;

  /**
   * getIsTransferInboundQueued returns whether the transfer is inbound queued
   * @param attestation the attestation to check
   */
  getIsTransferInboundQueued(attestation: Ntt.Attestation): Promise<boolean>;

  /**
   * getInboundQueuedTransfer returns the details of an inbound queued transfer
   * @param transceiverMessage the transceiver message
   * @param fromChain the chain the transfer is from
   */
  getInboundQueuedTransfer(
    fromChain: Chain,
    transceiverMessage: Ntt.Message
  ): Promise<Ntt.InboundQueuedTransfer<C> | null>;
  /**
   * completeInboundQueuedTransfer completes an inbound queued transfer
   * @param fromChain the chain the transfer is from
   * @param transceiverMessage the transceiver message
   * @param payer the address to pay for the transfer
   */
  completeInboundQueuedTransfer(
    fromChain: Chain,
    transceiverMessage: Ntt.Message,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>>;

  /**
   * Given a manager address, the rest of the addresses (token address and
   * transceiver addresses) can be queried from the manager contract directly.
   * This method verifies that the addresses that were used to construct the Ntt
   * instance match the addresses that are stored in the manager contract.
   *
   * TODO: perhaps a better way to do this would be by allowing async protocol
   * initializers so this can be done when constructing the Ntt instance.
   * That would be a larger change (in the connect sdk) so we do this for now.
   *
   * @returns the addresses that don't match the expected addresses, or null if
   * they all match
   */
  verifyAddresses(): Promise<Partial<Ntt.Contracts> | null>;
}

export interface NttTransceiver<
  N extends Network,
  C extends Chain,
  A extends Ntt.Attestation
> {
  getTransceiverType(payer?: AccountAddress<C>): Promise<string>;

  /**
   * Returns transceiver contract address on EVM and `emitterAccount` PDA address on Solana
   */
  getAddress(): ChainAddress<C>;

  /** setPeer sets a peer address for a given chain
   * Note: Admin only
   */
  setPeer(
    peer: ChainAddress<Chain>,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>>;

  getPeer<C extends Chain>(chain: C): Promise<ChainAddress<C> | null>;

  setPauser(
    newPauser: AccountAddress<C>,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>>;

  getPauser(): Promise<AccountAddress<C> | null>;

  /**
   * receive calls the `receive*` method on the transceiver
   *
   * @param attestation the attestation to redeem against the transceiver
   * @param sender the address of the sender
   */
  receive(
    attestation: A,
    sender?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>>;
}

export namespace WormholeNttTransceiver {
  const _payloads = [
    "WormholeTransfer",
    "WormholeTransferStandardRelayer",
  ] as const;
  export type PayloadNames = (typeof _payloads)[number];
  export type VAA<PayloadName extends PayloadNames = PayloadNames> =
    ProtocolVAA<Ntt.ProtocolName, PayloadName>;
  export type Payload<PayloadName extends PayloadNames = PayloadNames> =
    ProtocolPayload<Ntt.ProtocolName, PayloadName>;
}

/**
 * WormholeNttTransceiver is the interface for the Wormhole Ntt transceiver
 *
 * The WormholeNttTransceiver is responsible for verifying VAAs against the core
 * bridge and signaling the NttManager that it can mint tokens.
 */
export interface WormholeNttTransceiver<N extends Network, C extends Chain>
  extends NttTransceiver<N, C, WormholeNttTransceiver.VAA> {}

export interface SolanaNttTransceiver<
  N extends Network,
  C extends Chain,
  A extends Ntt.Attestation
> extends NttTransceiver<N, C, A> {
  programId: PublicKey;
}

export interface EvmNttTransceiver<
  N extends Network,
  C extends Chain,
  A extends Ntt.Attestation
> extends NttTransceiver<N, C, A> {}

declare module "@wormhole-foundation/sdk-definitions" {
  export namespace WormholeRegistry {
    interface ProtocolToInterfaceMapping<N, C> {
      Ntt: Ntt<N, C>;
    }
    interface ProtocolToPlatformMapping {
      Ntt: EmptyPlatformMap<Ntt.ProtocolName>;
    }
  }
}
