import type { Chain, Network } from "@wormhole-foundation/sdk-base";
import {
  AccountAddress,
  ChainAddress,
  ChainsConfig,
  Contracts,
  UnsignedTransaction,
} from "@wormhole-foundation/sdk-definitions";
import { Ntt, NttTransceiver } from "@wormhole-foundation/sdk-definitions-ntt";
import {
  XrplChains,
  XrplPlatform,
  XrplPlatformType,
  XrplUnsignedTransaction,
} from "@wormhole-foundation/sdk-xrpl";
import { Client } from "xrpl";
import { buildNttPayment, toXrplAddress } from "./utils.js";

export class XrplNtt<N extends Network, C extends XrplChains>
  implements Ntt<N, C>
{
  readonly network: N;
  readonly chain: C;
  readonly provider: Client;

  constructor(
    network: N,
    chain: C,
    provider: Client,
    readonly contracts: Contracts & { ntt?: Ntt.Contracts }
  ) {
    if (!contracts.ntt) {
      throw new Error("NTT contracts not found");
    }

    this.network = network;
    this.chain = chain;
    this.provider = provider;
  }

  static async fromRpc<N extends Network>(
    provider: Client,
    config: ChainsConfig<N, XrplPlatformType>
  ): Promise<XrplNtt<N, XrplChains>> {
    const [network, chain] = await XrplPlatform.chainFromRpc(provider);
    const conf = config[chain]!;

    if (conf.network !== network)
      throw new Error(`Network mismatch: ${conf.network} != ${network}`);

    if (!("ntt" in conf.contracts)) throw new Error("Ntt contracts not found");

    const ntt = conf.contracts["ntt"];

    return new XrplNtt(network as N, chain, provider, {
      ...conf.contracts,
      ntt,
    });
  }

  // State & Configuration Methods
  async getMode(): Promise<Ntt.Mode> {
    // TODO: check if the account has an IOU or MPT and assume if it does it's burning
    return "locking";
  }

  async isPaused(): Promise<boolean> {
    return false;
  }

  async getOwner(): Promise<AccountAddress<C>> {
    // TODO: this would need to check the Sequencer on Solana
    throw new Error("Not implemented");
  }

  async getPauser(): Promise<AccountAddress<C> | null> {
    return null;
  }

  async getThreshold(): Promise<number> {
    return 1;
  }

  async *setThreshold(
    threshold: number,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    throw new Error("unsupported");
  }

  async getTokenDecimals(): Promise<number> {
    if (this.contracts.ntt?.tokenDecimals === undefined) {
      throw new Error("No token decimals configured for source");
    }
    return this.contracts.ntt.tokenDecimals;
  }

  async getCustodyAddress(): Promise<string> {
    return toXrplAddress(this.contracts.ntt!["manager"]);
  }

  // Admin Methods
  async *pause(): AsyncGenerator<UnsignedTransaction<N, C>> {
    throw new Error("unsupported");
  }

  async *unpause(): AsyncGenerator<UnsignedTransaction<N, C>> {
    throw new Error("unsupported");
  }

  async *setOwner(
    newOwner: AccountAddress<C>,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    // TODO: this would need to relay to the Sequencer on Solana
    throw new Error("Not implemented");
  }

  async *setPauser(
    newPauser: AccountAddress<C>,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    throw new Error("unsupported");
  }

  // Peer Management
  async *setPeer(
    peer: ChainAddress,
    tokenDecimals: number,
    inboundLimit: bigint,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    throw new Error("unsupported: XRPL only uses the transceiver");
  }

  async getPeer<PC extends Chain>(chain: PC): Promise<Ntt.Peer<PC> | null> {
    // TODO: this might need to be passed in via constructor
    throw new Error("Not implemented");
  }

  async *setTransceiverPeer(
    ix: number,
    peer: ChainAddress,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    // TODO: this would need to relay to the Sequencer on Solana
    throw new Error("Not implemented");
  }

  // Transfer Methods
  async *transfer(
    sender: AccountAddress<C>,
    amount: bigint,
    destination: ChainAddress,
    options: Ntt.TransferOptions
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    const { payment } = await buildNttPayment({
      sender,
      amount,
      destination,
      contracts: this.contracts,
      getTokenDecimals: () => this.getTokenDecimals(),
    });

    yield new XrplUnsignedTransaction(
      payment,
      this.network,
      this.chain,
      "NTT transfer"
    );
  }

  async *redeem(
    attestations: Ntt.Attestation[],
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
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
    return 0n;
  }

  async getOutboundLimit(): Promise<bigint> {
    return 0n;
  }

  async *setOutboundLimit(
    limit: bigint,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    throw new Error("unsupported");
  }

  async getCurrentInboundCapacity<PC extends Chain>(
    fromChain: PC
  ): Promise<bigint> {
    return 0n;
  }

  async getInboundLimit<PC extends Chain>(fromChain: PC): Promise<bigint> {
    return 0n;
  }

  async *setInboundLimit<PC extends Chain>(
    fromChain: PC,
    limit: bigint,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    throw new Error("unsupported");
  }

  async getRateLimitDuration(): Promise<bigint> {
    // Rate limit duration is a constant in the Move contract
    return 0n;
  }

  // Transfer Status
  async getIsApproved(attestation: Ntt.Attestation): Promise<boolean> {
    throw new Error("Not implemented");
  }

  async getIsExecuted(attestation: Ntt.Attestation): Promise<boolean> {
    throw new Error("Not implemented");
  }

  async getIsTransferInboundQueued(
    attestation: Ntt.Attestation
  ): Promise<boolean> {
    return false;
  }

  async getInboundQueuedTransfer<PC extends Chain>(
    fromChain: PC,
    transceiverMessage: Ntt.Message
  ): Promise<Ntt.InboundQueuedTransfer<C> | null> {
    return null;
  }

  async *completeInboundQueuedTransfer<PC extends Chain>(
    fromChain: PC,
    transceiverMessage: Ntt.Message,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    throw new Error("unsupported");
  }

  // Transceiver Management
  async getTransceiver(
    ix: number
  ): Promise<NttTransceiver<N, C, Ntt.Attestation> | null> {
    return null;
  }

  async getTransceiverPeer<PC extends Chain>(
    ix: number,
    targetChain: PC
  ): Promise<ChainAddress<PC> | null> {
    // TODO: this would need to check the Sequencer on Solana
    throw new Error("Not implemented");
  }

  async getTransceiverType(transceiverIndex: number = 0): Promise<string> {
    // For now, only support index 0 which is the wormhole transceiver
    if (transceiverIndex !== 0) {
      throw new Error(`Transceiver index ${transceiverIndex} not supported`);
    }

    return "wormhole";
  }

  async verifyAddresses(): Promise<Partial<Ntt.Contracts> | null> {
    throw new Error("Not implemented");
  }
}
