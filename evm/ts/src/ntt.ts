import {
  Chain,
  Network,
  encoding,
  nativeChainIds,
  toChainId,
} from "@wormhole-foundation/sdk-base";
import {
  AccountAddress,
  ChainAddress,
  ChainsConfig,
  Contracts,
  canonicalAddress,
  serialize,
  toUniversal,
  universalAddress,
} from "@wormhole-foundation/sdk-definitions";
import type {
  AnyEvmAddress,
  EvmChains,
  EvmPlatformType,
} from "@wormhole-foundation/sdk-evm";
import {
  EvmAddress,
  EvmPlatform,
  EvmUnsignedTransaction,
  addChainId,
  addFrom,
} from "@wormhole-foundation/sdk-evm";
import "@wormhole-foundation/sdk-evm-core";

import {
  EvmNttTransceiver,
  Ntt,
  NttTransceiver,
  WormholeNttTransceiver,
} from "@wormhole-foundation/sdk-definitions-ntt";
import { Contract, type Provider, type TransactionRequest } from "ethers";
import {
  NttBindings,
  NttManagerBindings,
  NttTransceiverBindings,
  loadAbiVersion,
} from "./bindings.js";
import { BinaryWriter } from "./executor/BinaryWriter.js";
import { fetchEstimate, fetchQuote } from "./executor/fetch.js";
import { encodeRelayInstructions } from "./executor/relayInstructions.js";

export class EvmNttWormholeTranceiver<N extends Network, C extends EvmChains>
  implements
    WormholeNttTransceiver<N, C>,
    EvmNttTransceiver<N, C, WormholeNttTransceiver.VAA>
{
  transceiver: NttTransceiverBindings.NttTransceiver;
  constructor(
    readonly manager: EvmNtt<N, C>,
    readonly address: string,
    abiBindings: NttBindings
  ) {
    this.transceiver = abiBindings.NttTransceiver.connect(
      address,
      manager.provider
    );
  }

  async getTransceiverType(): Promise<string> {
    // NOTE: We hardcode the type here as transceiver type is only available for versions >1.1.0
    // For those versions, we can return `this.transceiver.getTransceiverType()` directly
    return "wormhole";
  }

  getAddress(): ChainAddress<C> {
    return {
      chain: this.manager.chain,
      address: toUniversal(this.manager.chain, this.address),
    };
  }

  encodeFlags(flags: { skipRelay: boolean }): Uint8Array {
    return new Uint8Array([flags.skipRelay ? 1 : 0]);
  }

  async *setPeer<P extends Chain>(
    peer: ChainAddress<P>
  ): AsyncGenerator<EvmUnsignedTransaction<N, C>> {
    const tx = await this.transceiver.setWormholePeer.populateTransaction(
      toChainId(peer.chain),
      universalAddress(peer)
    );
    yield this.manager.createUnsignedTx(tx, "WormholeTransceiver.registerPeer");
  }

  async getPauser(): Promise<AccountAddress<C> | null> {
    const pauser = await this.transceiver.pauser();
    return new EvmAddress(pauser) as AccountAddress<C>;
  }

  async *setPauser(pauser: AccountAddress<C>) {
    const canonicalPauser = canonicalAddress({
      chain: this.manager.chain,
      address: pauser,
    });
    const tx =
      await this.transceiver.transferPauserCapability.populateTransaction(
        canonicalPauser
      );
    yield this.manager.createUnsignedTx(tx, "WormholeTransceiver.setPauser");
  }

  async getPeer<C extends Chain>(chain: C): Promise<ChainAddress<C> | null> {
    const peer = await this.transceiver.getWormholePeer(toChainId(chain));
    const peerAddress = encoding.hex.decode(peer);
    const zeroAddress = new Uint8Array(32);
    if (encoding.bytes.equals(zeroAddress, peerAddress)) {
      return null;
    }

    return {
      chain: chain,
      address: toUniversal(chain, peerAddress),
    };
  }

  async isEvmChain(chain: Chain): Promise<boolean> {
    return await this.transceiver.isWormholeEvmChain(toChainId(chain));
  }

  async *setIsEvmChain(chain: Chain, isEvm: boolean) {
    const tx = await this.transceiver.setIsWormholeEvmChain.populateTransaction(
      toChainId(chain),
      isEvm
    );
    yield this.manager.createUnsignedTx(
      tx,
      "WormholeTransceiver.setIsEvmChain"
    );
  }

  async *receive(attestation: WormholeNttTransceiver.VAA) {
    const tx = await this.transceiver.receiveMessage.populateTransaction(
      serialize(attestation)
    );
    yield this.manager.createUnsignedTx(
      tx,
      "WormholeTransceiver.receiveMessage"
    );
  }

  async isWormholeRelayingEnabled(destChain: Chain): Promise<boolean> {
    return await this.transceiver.isWormholeRelayingEnabled(
      toChainId(destChain)
    );
  }

  async *setIsWormholeRelayingEnabled(destChain: Chain, enabled: boolean) {
    const tx =
      await this.transceiver.setIsWormholeRelayingEnabled.populateTransaction(
        toChainId(destChain),
        enabled
      );
    yield this.manager.createUnsignedTx(
      tx,
      "WormholeTransceiver.setWormholeRelayingEnabled"
    );
  }

  async isSpecialRelayingEnabled(destChain: Chain): Promise<boolean> {
    return await this.transceiver.isSpecialRelayingEnabled(
      toChainId(destChain)
    );
  }

  async *setIsSpecialRelayingEnabled(destChain: Chain, enabled: boolean) {
    const tx =
      await this.transceiver.setIsSpecialRelayingEnabled.populateTransaction(
        toChainId(destChain),
        enabled
      );
    yield this.manager.createUnsignedTx(
      tx,
      "WormholeTransceiver.setSpecialRelayingEnabled"
    );
  }
}

export class EvmNtt<N extends Network, C extends EvmChains>
  implements Ntt<N, C>
{
  tokenAddress: string;
  readonly chainId: bigint;
  manager: NttManagerBindings.NttManager;
  xcvrs: EvmNttWormholeTranceiver<N, C>[];
  managerAddress: string;

  constructor(
    readonly network: N,
    readonly chain: C,
    readonly provider: Provider,
    readonly contracts: Contracts & { ntt?: Ntt.Contracts },
    readonly version: string = "2.0.0"
  ) {
    if (!contracts.ntt) throw new Error("No Ntt Contracts provided");

    this.chainId = nativeChainIds.networkChainToNativeChainId.get(
      network,
      chain
    ) as bigint;

    this.tokenAddress = contracts.ntt.token;
    this.managerAddress = contracts.ntt.manager;

    const abiBindings = loadAbiVersion(this.version);

    this.manager = abiBindings.NttManager.connect(
      contracts.ntt.manager,
      this.provider
    );

    this.xcvrs = [];
  }

  async getTransceiver(ix: number): Promise<NttTransceiver<N, C, any> | null> {
    // TODO: should we make an RPC call here, or just trust that the xcvrs are set up correctly?
    return this.xcvrs[ix] || null;
  }

  async getMode(): Promise<Ntt.Mode> {
    const mode: bigint = await this.manager.getMode();
    return mode === 0n ? "locking" : "burning";
  }

  async isPaused(): Promise<boolean> {
    return await this.manager.isPaused();
  }

  async *pause() {
    const tx = await this.manager.pause.populateTransaction();
    yield this.createUnsignedTx(tx, "Ntt.pause");
  }

  async *unpause() {
    const tx = await this.manager.unpause.populateTransaction();
    yield this.createUnsignedTx(tx, "Ntt.unpause");
  }

  async getOwner(): Promise<AccountAddress<C>> {
    return new EvmAddress(await this.manager.owner()) as AccountAddress<C>;
  }

  async getPauser(): Promise<AccountAddress<C> | null> {
    return new EvmAddress(await this.manager.pauser()) as AccountAddress<C>;
  }

  async *setOwner(owner: AnyEvmAddress) {
    const canonicalOwner = new EvmAddress(owner).toString();
    const tx = await this.manager.transferOwnership.populateTransaction(
      canonicalOwner
    );
    yield this.createUnsignedTx(tx, "Ntt.setOwner");
  }

  async *setPauser(pauser: AnyEvmAddress) {
    const canonicalPauser = new EvmAddress(pauser).toString();
    const tx = await this.manager.transferPauserCapability.populateTransaction(
      canonicalPauser
    );
    yield this.createUnsignedTx(tx, "Ntt.setPauser");
  }

  async getThreshold(chainId: number): Promise<number> {
    return Number(await this.manager.getThreshold(chainId));
  }

  async isRelayingAvailable(destination: Chain): Promise<boolean> {
    const enabled = await Promise.all(
      this.xcvrs.map(async (x) => {
        const [wh, special] = await Promise.all([
          x.isWormholeRelayingEnabled(destination),
          x.isSpecialRelayingEnabled(destination),
        ]);
        return wh || special;
      })
    );

    return enabled.filter((x) => x).length > 0;
  }

  async getIsExecuted(attestation: Ntt.Attestation): Promise<boolean> {
    // const payload =
    //   attestation.payloadName === "WormholeTransfer"
    //     ? attestation.payload
    //     : attestation.payload["payload"];
    const isExecuted = false;
    // TODO: err... fix this
    // await this.manager.isMessageExecuted(
    //   Ntt.messageDigest(attestation.emitterChain, payload["nttManagerPayload"])
    // );
    if (!isExecuted) return false;
    // Also check that the transfer is not queued for it to be considered complete
    return !(await this.getIsTransferInboundQueued(attestation));
  }

  async getIsTransferInboundQueued(
    attestation: Ntt.Attestation
  ): Promise<boolean> {
    const payload =
      attestation.payloadName === "WormholeTransfer"
        ? attestation.payload
        : attestation.payload["payload"];
    return (
      (await this.getInboundQueuedTransfer(
        attestation.emitterChain,
        payload["nttManagerPayload"]
      )) !== null
    );
  }

  getIsApproved(attestation: Ntt.Attestation): Promise<boolean> {
    // TODO: err... fix this
    return Promise.resolve(true);
    // const payload =
    //   attestation.payloadName === "WormholeTransfer"
    //     ? attestation.payload
    //     : attestation.payload["payload"];
    // return this.manager.isMessageApproved(
    //   Ntt.messageDigest(attestation.emitterChain, payload["nttManagerPayload"])
    // );
  }

  async getTokenDecimals(): Promise<number> {
    return await EvmPlatform.getDecimals(
      this.chain,
      this.provider,
      this.tokenAddress
    );
  }

  async getPeer<C extends Chain>(chain: C): Promise<Ntt.Peer<C> | null> {
    const peer = await this.manager.getPeer(toChainId(chain));
    const peerAddress = encoding.hex.decode(peer.peerAddress);
    const zeroAddress = new Uint8Array(32);
    if (encoding.bytes.equals(zeroAddress, peerAddress)) {
      return null;
    }

    return {
      address: { chain: chain, address: toUniversal(chain, peerAddress) },
      tokenDecimals: Number(peer.tokenDecimals),
      gasLimit: peer.gasLimit,
      inboundLimit: await this.getInboundLimit(chain),
    };
  }

  static async fromRpc<N extends Network>(
    provider: Provider,
    config: ChainsConfig<N, EvmPlatformType>
  ): Promise<EvmNtt<N, EvmChains>> {
    const [network, chain] = await EvmPlatform.chainFromRpc(provider);
    const conf = config[chain]!;
    if (conf.network !== network)
      throw new Error(`Network mismatch: ${conf.network} != ${network}`);

    const version = await EvmNtt.getVersion(provider, conf.contracts);
    return new EvmNtt(network as N, chain, provider, conf.contracts, version);
  }

  encodeOptions(options: Ntt.TransferOptions): Ntt.TransceiverInstruction[] {
    const ixs: Ntt.TransceiverInstruction[] = [];

    ixs.push({
      index: 0,
      payload: this.xcvrs[0]!.encodeFlags({ skipRelay: !options.automatic }),
    });

    return ixs;
  }

  static async getVersion(
    provider: Provider,
    contracts: Contracts & { ntt?: Ntt.Contracts }
  ) {
    const contract = new Contract(
      contracts.ntt!.manager,
      ["function NTT_MANAGER_VERSION() public view returns (string)"],
      provider
    );
    try {
      const abiVersion = await contract
        .getFunction("NTT_MANAGER_VERSION")
        .staticCall();
      if (!abiVersion) {
        throw new Error("NTT_MANAGER_VERSION not found");
      }
      return abiVersion;
    } catch (e) {
      console.error(
        `Failed to get NTT_MANAGER_VERSION from contract ${contracts.ntt?.manager}`
      );
      throw e;
    }
  }

  async getCustodyAddress() {
    return this.managerAddress;
  }

  async quoteDeliveryPrice(
    dstChain: Chain,
    options: Ntt.TransferOptions
  ): Promise<bigint> {
    const totalPrice = await this.manager.quoteDeliveryPrice(
      toChainId(dstChain),
      Ntt.encodeTransceiverInstructions(this.encodeOptions(options))
    );
    return totalPrice;
  }

  async *setPeer(
    peer: ChainAddress<C>,
    tokenDecimals: number,
    gasLimit: bigint,
    inboundLimit: bigint
  ) {
    const tx = await this.manager.setPeer.populateTransaction(
      toChainId(peer.chain),
      universalAddress(peer),
      tokenDecimals,
      gasLimit,
      inboundLimit
    );
    yield this.createUnsignedTx(tx, "Ntt.setPeer");
  }

  async *setWormholeTransceiverPeer(peer: ChainAddress<C>) {
    yield* this.setTransceiverPeer(0, peer);
  }

  async *setTransceiverPeer(ix: number, peer: ChainAddress<C>) {
    if (ix >= this.xcvrs.length) {
      throw new Error("Transceiver not found");
    }
    yield* this.xcvrs[ix]!.setPeer(peer);
  }

  async *transfer(
    sender: AccountAddress<C>,
    amount: bigint,
    destination: ChainAddress,
    options: Ntt.TransferOptions
  ): AsyncGenerator<EvmUnsignedTransaction<N, C>> {
    const senderAddress = new EvmAddress(sender).toString();

    const peer = await this.getPeer(destination.chain);
    if (!peer) {
      throw new Error(`null peer for destination chain ${destination.chain}`);
    }
    const quote = await fetchQuote(this.chain, destination.chain);
    const relayInstruction = encodeRelayInstructions([
      { type: "GasInstruction", gasLimit: peer.gasLimit, msgValue: 0n },
    ]);
    const executorEstimate = await fetchEstimate(quote, relayInstruction);

    // assemble the transceiver instructions
    // like https://github.com/wormholelabs-xyz/example-messaging-adapter-wormhole-guardians/blob/7deb17c52d95b252435740a1047902a857b5fea8/evm/src/WormholeGuardiansAdapterWithExecutor.sol#L132-L152
    // and  https://github.com/wormholelabs-xyz/example-messaging-endpoint/blob/0f853ea0335937d611217f5048d677a4f46249fd/evm/src/libraries/AdapterInstructions.sol#L37-L66
    const wgaGasLimit = 1000000n; // determine some amount of gas based on destination chain
    const wgaRelayInstruction = encodeRelayInstructions([
      { type: "GasInstruction", gasLimit: wgaGasLimit, msgValue: 0n },
    ]);
    const wgaExecutorEstimate = await fetchEstimate(quote, wgaRelayInstruction);
    const transceiversInstruction = new BinaryWriter()
      .writeUint8(1) // version
      .writeUint256(wgaExecutorEstimate)
      .writeUint16((quote.length - 2) / 2)
      .writeHex(quote)
      .writeUint16((wgaRelayInstruction.length - 2) / 2)
      .writeHex(wgaRelayInstruction)
      .data();
    const transceiversInstructions = new BinaryWriter()
      .writeUint8(1) // instructionsLength
      .writeUint8(0) // instruction.index
      .writeUint16(transceiversInstruction.length)
      .writeUint8Array(transceiversInstruction)
      .toHex();

    // Note: these flags are indexed by transceiver index
    const totalPrice =
      executorEstimate +
      (await this.manager.quoteDeliveryPrice(
        toChainId(destination.chain),
        transceiversInstructions
      ));
    // TODO: make quoteDeliveryPrice work again
    // (await this.quoteDeliveryPrice(destination.chain, options));

    //TODO check for ERC-2612 (permit) support on token?
    const tokenContract = EvmPlatform.getTokenImplementation(
      this.provider,
      this.tokenAddress
    );

    const allowance = await tokenContract.allowance(
      senderAddress,
      this.managerAddress
    );
    if (allowance < amount) {
      const txReq = await tokenContract.approve.populateTransaction(
        this.managerAddress,
        amount
      );
      yield this.createUnsignedTx(addFrom(txReq, senderAddress), "Ntt.Approve");
    }

    const receiver = universalAddress(destination);
    const txReq = await this.manager
      .getFunction(
        "transfer(uint256,uint16,bytes32,bytes32,bool,bytes,bytes,bytes)"
      )
      .populateTransaction(
        amount,
        toChainId(destination.chain),
        receiver,
        receiver,
        options.queue,
        quote,
        "0x", // TODO: optionally encode gas dropoff relay instruction
        transceiversInstructions,
        { value: totalPrice }
      );

    yield this.createUnsignedTx(addFrom(txReq, senderAddress), "Ntt.transfer");
  }

  // TODO: should this be some map of idx to transceiver?
  async *redeem(attestations: Ntt.Attestation[]) {
    if (attestations.length !== this.xcvrs.length)
      throw new Error(
        "Not enough attestations for the registered Transceivers"
      );

    for (const idx in this.xcvrs) {
      const xcvr = this.xcvrs[idx]!;
      const attestation = attestations[idx];
      if (attestation?.payloadName !== "WormholeTransfer") {
        // TODO: support standard relayer attestations
        // which must be submitted to the delivery provider
        throw new Error("Invalid attestation type for redeem");
      }
      yield* xcvr.receive(attestation);
    }
  }

  async getCurrentOutboundCapacity(): Promise<bigint> {
    return await this.manager.getCurrentOutboundCapacity();
  }

  async getOutboundLimit(): Promise<bigint> {
    const encoded: EncodedTrimmedAmount = (
      await this.manager.getOutboundLimitParams()
    ).limit;
    const trimmedAmount: TrimmedAmount = decodeTrimmedAmount(encoded);
    const tokenDecimals = await this.getTokenDecimals();

    return untrim(trimmedAmount, tokenDecimals);
  }

  async *setOutboundLimit(limit: bigint) {
    const tx = await this.manager.setOutboundLimit.populateTransaction(limit);
    yield this.createUnsignedTx(tx, "Ntt.setOutboundLimit");
  }

  async getCurrentInboundCapacity(fromChain: Chain): Promise<bigint> {
    return await this.manager.getCurrentInboundCapacity(toChainId(fromChain));
  }

  async getInboundLimit(fromChain: Chain): Promise<bigint> {
    const encoded: EncodedTrimmedAmount = (
      await this.manager.getInboundLimitParams(toChainId(fromChain))
    ).limit;
    const trimmedAmount: TrimmedAmount = decodeTrimmedAmount(encoded);
    const tokenDecimals = await this.getTokenDecimals();

    return untrim(trimmedAmount, tokenDecimals);
  }

  async *setInboundLimit(fromChain: Chain, limit: bigint) {
    const tx = await this.manager.setInboundLimit.populateTransaction(
      limit,
      toChainId(fromChain)
    );
    yield this.createUnsignedTx(tx, "Ntt.setInboundLimit");
  }

  async getRateLimitDuration(): Promise<bigint> {
    return await this.manager.rateLimitDuration();
  }

  async getInboundQueuedTransfer(
    fromChain: Chain,
    transceiverMessage: Ntt.Message
  ): Promise<Ntt.InboundQueuedTransfer<C> | null> {
    const queuedTransfer = await this.manager.getInboundQueuedTransfer(
      Ntt.messageDigest(fromChain, transceiverMessage)
    );
    if (queuedTransfer.txTimestamp > 0n) {
      const { recipient, amount, txTimestamp } = queuedTransfer;
      const duration = await this.getRateLimitDuration();
      return {
        recipient: new EvmAddress(recipient) as AccountAddress<C>,
        amount: amount,
        rateLimitExpiryTimestamp: Number(txTimestamp + duration),
      };
    }
    return null;
  }

  async *completeInboundQueuedTransfer(
    fromChain: Chain,
    transceiverMessage: Ntt.Message,
    payer?: AccountAddress<C>
  ) {
    const tx =
      await this.manager.completeInboundQueuedTransfer.populateTransaction(
        Ntt.messageDigest(fromChain, transceiverMessage)
      );
    yield this.createUnsignedTx(tx, "Ntt.completeInboundQueuedTransfer");
  }

  async verifyAddresses(): Promise<Partial<Ntt.Contracts> | null> {
    const local: Partial<Ntt.Contracts> = {
      manager: this.managerAddress,
      token: this.tokenAddress,
      transceiver: {
        ...(this.xcvrs.length > 0 && { wormhole: this.xcvrs[0]!.address }),
      },
      // TODO: what about the quoter?
    };

    const remote: Partial<Ntt.Contracts> = {
      manager: this.managerAddress,
      token: await this.manager.token(),
      transceiver: {
        // TODO: idk how this should work now
        // wormhole: (await this.manager.getTransceivers())[0]!, // TODO: make this more generic
      },
    };

    const deleteMatching = (a: any, b: any) => {
      for (const k in a) {
        if (typeof a[k] === "object") {
          deleteMatching(a[k], b[k]);
          if (Object.keys(a[k]).length === 0) delete a[k];
        } else if (a[k] === b[k]) {
          delete a[k];
        }
      }
    };

    deleteMatching(remote, local);

    return Object.keys(remote).length > 0 ? remote : null;
  }

  createUnsignedTx(
    txReq: TransactionRequest,
    description: string,
    parallelizable: boolean = false
  ): EvmUnsignedTransaction<N, C> {
    return new EvmUnsignedTransaction(
      addChainId(txReq, this.chainId),
      this.network,
      this.chain,
      description,
      parallelizable
    );
  }
}

type EncodedTrimmedAmount = bigint; // uint72

type TrimmedAmount = {
  amount: bigint;
  decimals: number;
};

function decodeTrimmedAmount(encoded: EncodedTrimmedAmount): TrimmedAmount {
  const decimals = Number(encoded & 0xffn);
  const amount = encoded >> 8n;
  return {
    amount,
    decimals,
  };
}

function untrim(trimmed: TrimmedAmount, toDecimals: number): bigint {
  const { amount, decimals: fromDecimals } = trimmed;
  return scale(amount, fromDecimals, toDecimals);
}

function scale(
  amount: bigint,
  fromDecimals: number,
  toDecimals: number
): bigint {
  if (fromDecimals == toDecimals) {
    return amount;
  }

  if (fromDecimals > toDecimals) {
    return amount / 10n ** BigInt(fromDecimals - toDecimals);
  } else {
    return amount * 10n ** BigInt(toDecimals - fromDecimals);
  }
}
