import {
  AccountAddress,
  ChainAddress,
  UnsignedTransaction,
} from "@wormhole-foundation/sdk-definitions";
import type { Chain, Network } from "@wormhole-foundation/sdk-base";
import {
  Ntt,
  NttTransceiver,
} from "@wormhole-foundation/sdk-definitions-ntt";
import { SuiChains } from "@wormhole-foundation/sdk-sui";
import { SuiClient } from "@mysten/sui/client";

export class SuiNtt<N extends Network, C extends SuiChains> implements Ntt<N, C> {
  readonly network: N;
  readonly chain: C;
  readonly provider: SuiClient;
  readonly contracts: Ntt.Contracts;

  constructor(
    network: N,
    chain: C,
    provider: SuiClient,
    contracts: any // TODO: Fix type - should be platform contracts + ntt
  ) {
    if (!contracts.ntt) {
      throw new Error("NTT contracts not found");
    }

    this.network = network;
    this.chain = chain;
    this.provider = provider;
    this.contracts = contracts.ntt;
  }

  static async fromRpc<N extends Network>(
    provider: SuiClient,
    config: any // TODO: Fix type once we have proper config type
  ): Promise<SuiNtt<N, SuiChains>> {
    throw new Error("Not implemented");
  }

  // State & Configuration Methods
  async getMode(): Promise<Ntt.Mode> {
    throw new Error("Not implemented");
  }

  async isPaused(): Promise<boolean> {
    throw new Error("Not implemented");
  }

  async getOwner(): Promise<AccountAddress<C>> {
    throw new Error("Not implemented");
  }

  async getPauser(): Promise<AccountAddress<C> | null> {
    throw new Error("Not implemented");
  }

  async getThreshold(): Promise<number> {
    throw new Error("Not implemented");
  }

  async getTokenDecimals(): Promise<number> {
    throw new Error("Not implemented");
  }

  async getCustodyAddress(): Promise<string> {
    throw new Error("Not implemented");
  }

  // Admin Methods
  async *pause(): AsyncGenerator<UnsignedTransaction<N, C>> {
    throw new Error("Not implemented");
  }

  async *unpause(): AsyncGenerator<UnsignedTransaction<N, C>> {
    throw new Error("Not implemented");
  }

  async *setOwner(newOwner: AccountAddress<C>, payer?: AccountAddress<C>): AsyncGenerator<UnsignedTransaction<N, C>> {
    throw new Error("Not implemented");
  }

  async *setPauser(newPauser: AccountAddress<C>, payer?: AccountAddress<C>): AsyncGenerator<UnsignedTransaction<N, C>> {
    throw new Error("Not implemented");
  }

  // Peer Management
  async *setPeer(
    peer: ChainAddress,
    tokenDecimals: number,
    inboundLimit: bigint
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    throw new Error("Not implemented");
  }

  async getPeer<PC extends Chain>(chain: PC): Promise<Ntt.Peer<PC> | null> {
    throw new Error("Not implemented");
  }

  async *setTransceiverPeer(
    ix: number,
    peer: ChainAddress,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    throw new Error("Not implemented");
  }

  // Transfer Methods
  async *transfer(
    sender: AccountAddress<C>,
    amount: bigint,
    destination: ChainAddress,
    options: Ntt.TransferOptions
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    throw new Error("Not implemented");
  }

  async *redeem(attestations: Ntt.Attestation[]): AsyncGenerator<UnsignedTransaction<N, C>> {
    throw new Error("Not implemented");
  }

  async quoteDeliveryPrice(
    destination: Chain,
    options: Ntt.TransferOptions
  ): Promise<bigint> {
    throw new Error("Not implemented");
  }

  async isRelayingAvailable(destination: Chain): Promise<boolean> {
    return false;
  }

  // Rate Limiting
  async getCurrentOutboundCapacity(): Promise<bigint> {
    throw new Error("Not implemented");
  }

  async getOutboundLimit(): Promise<bigint> {
    throw new Error("Not implemented");
  }

  async *setOutboundLimit(limit: bigint, payer?: AccountAddress<C>): AsyncGenerator<UnsignedTransaction<N, C>> {
    throw new Error("Not implemented");
  }

  async getCurrentInboundCapacity<PC extends Chain>(fromChain: PC): Promise<bigint> {
    throw new Error("Not implemented");
  }

  async getInboundLimit<PC extends Chain>(fromChain: PC): Promise<bigint> {
    throw new Error("Not implemented");
  }

  async *setInboundLimit<PC extends Chain>(
    fromChain: PC,
    limit: bigint,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    throw new Error("Not implemented");
  }

  async getRateLimitDuration(): Promise<bigint> {
    throw new Error("Not implemented");
  }

  // Transfer Status
  async getIsApproved(attestation: Ntt.Attestation): Promise<boolean> {
    throw new Error("Not implemented");
  }

  async getIsExecuted(attestation: Ntt.Attestation): Promise<boolean> {
    throw new Error("Not implemented");
  }

  async getIsTransferInboundQueued(attestation: Ntt.Attestation): Promise<boolean> {
    throw new Error("Not implemented");
  }

  async getInboundQueuedTransfer<PC extends Chain>(
    fromChain: PC,
    transceiverMessage: Ntt.Message
  ): Promise<Ntt.InboundQueuedTransfer<C> | null> {
    throw new Error("Not implemented");
  }

  async *completeInboundQueuedTransfer<PC extends Chain>(
    fromChain: PC,
    transceiverMessage: Ntt.Message,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    throw new Error("Not implemented");
  }

  // Transceiver Management
  async getTransceiver(ix: number): Promise<NttTransceiver<N, C, Ntt.Attestation> | null> {
    throw new Error("Not implemented");
  }

  async verifyAddresses(): Promise<Partial<Ntt.Contracts> | null> {
    throw new Error("Not implemented");
  }
}
