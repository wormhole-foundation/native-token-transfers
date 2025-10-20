import { Chain, chainToChainId, Network } from "@wormhole-foundation/sdk-base";
import { AccountAddress, UnsignedTransaction, ChainAddress } from "@wormhole-foundation/sdk-connect";
import { Ntt, NttTransceiver } from "@wormhole-foundation/sdk-definitions-ntt";
import { StacksChains, StacksPlatform, StacksPlatformType, StacksZeroAddress } from "@wormhole-foundation/sdk-stacks";
import { StacksNetwork } from "@stacks/network";
import { ChainsConfig, Contracts, serialize, toNative, UniversalAddress } from "@wormhole-foundation/sdk-definitions";
import { BufferCV, Cl, cvToValue, fetchCallReadOnlyFunction, PostConditionMode } from "@stacks/transactions";

export class StacksNttWormholeTransceiver<N extends Network, C extends StacksChains> implements NttTransceiver<N, C, Ntt.Attestation> {

  // static readonly CONTRACT_NAME = 'wormhole-transceiver-v1'
  // static readonly STATE_CONTRACT_NAME = 'wormhole-transceiver-state'

  private readonly contractName: string;
  private readonly deployer: string;

  constructor(
    readonly manager: StacksNtt<N, C>,
    readonly address: string,
  ) {
    const addressSplit = address.split(".")
    this.contractName = addressSplit[1]!
    this.deployer = addressSplit[0]!
  }

  getTransceiverType(payer?: AccountAddress<C> | undefined): Promise<string> {
    throw new Error("Method not implemented.");
  }

  async getAddress(): Promise<ChainAddress<C>> {
    return {
      chain: this.manager.chain,
      address: toNative(this.manager.chain, this.address),
    }
  }

  async *setPeer(peer: ChainAddress<Chain>, payer?: AccountAddress<C> | undefined): AsyncGenerator<UnsignedTransaction<N, C>, any, any> {
    const tx = {
      contractName: this.contractName,
      contractAddress: this.deployer,
      functionName: 'add-peer',
      functionArgs: [
        StacksNtt.chainToClBuffer(peer.chain),
        Cl.buffer(new UniversalAddress(peer.address.toString()).toUint8Array()),
      ],
      postConditionMode: PostConditionMode.Allow
    }

    yield {
      transaction: tx,
      network: this.manager.network,
      chain: this.manager.chain,
      description: "Ntt.setTransceiverPeer",
      parallelizable: false
    }
  }

  getPeer<C extends Chain>(chain: C): Promise<ChainAddress<C> | null> {
    throw new Error("Method not implemented.");
  }

  setPauser(newPauser: AccountAddress<C>, payer?: AccountAddress<C> | undefined): AsyncGenerator<UnsignedTransaction<N, C>, any, any> {
    throw new Error("Method not implemented.");
  }

  getPauser(): Promise<AccountAddress<C> | null> {
    throw new Error("Method not implemented.");
  }

  async *receive(attestation: Ntt.Attestation, sender?: AccountAddress<C> | undefined): AsyncGenerator<UnsignedTransaction<N, C>, any, any> {
    console.log(`Stacks receive`)
    const tx = {
      contractName: this.contractName,
      contractAddress: this.deployer,
      functionName: 'receive-token-transfer',
      functionArgs: [
        Cl.address(await this.manager.getFullAddress()),
        Cl.buffer(serialize(attestation)),
      ],
      postConditionMode: PostConditionMode.Allow
    }
    console.log(`Stacks receive tx`, tx)
    yield {
      transaction: tx,
      network: this.manager.network,
      chain: this.manager.chain,
      description: "NttWormholeTransceiver.receive",
      parallelizable: false
    }
  }
}

export type StacksNttContracts = Ntt.Contracts & {
  state: string
  tokenOwner: string
  transceiverState: {
    [type: string]: string;
  }
}

// FG TODO FG extends StacksChains
export class StacksNtt<N extends Network, C extends StacksChains> 
  implements Ntt<N, C> {

    static readonly WORMHOLE_PROTOCOL_ID = 1

    private readonly nttManagerDeployer: string;
    private readonly nttManagerStateContractName: string;
    private readonly tokenOwnerContractName: string
    private readonly tokenAddress: string;

    constructor(
      readonly network: N,
      readonly chain: C,
      readonly connection: StacksNetwork,
      readonly contracts: Contracts & { ntt?: StacksNttContracts },
      readonly version: string = "1.0.0"
    ) {
      if(!contracts.ntt) {
        throw new Error("NTT Contracts not found")
      }

      const nttManagerStateFullAddress = contracts.ntt?.state
      if(!nttManagerStateFullAddress) {
        throw new Error("NTT Manager State address not found")
      }
      if(!nttManagerStateFullAddress.includes(".")) {
        throw new Error("NTT Manager State address invalid")
      }
      const managerAddressSplit = nttManagerStateFullAddress.split(".")
      this.nttManagerDeployer = managerAddressSplit[0]!
      this.nttManagerStateContractName = managerAddressSplit[1]!
      const tokenAddress = contracts.ntt?.token
      if(!tokenAddress) {
        throw new Error("NTT Token address not found")
      }
      this.tokenAddress = tokenAddress
      const tokenOwnerFullAddress = contracts.ntt?.tokenOwner
      if(!tokenOwnerFullAddress) {
        throw new Error("NTT Token Owner address not found")
      }
      if(!tokenOwnerFullAddress.includes(".")) {
        throw new Error("NTT Token Owner address invalid")
      }
      const tokenOwnerAddressSplit = tokenOwnerFullAddress.split(".")
      this.tokenOwnerContractName = tokenOwnerAddressSplit[1]!
    }
    
  getMode(): Promise<Ntt.Mode> {
    throw new Error("Method not implemented.");
  }

  async getFullAddress(): Promise<string> {
    return (await this.getActiveNttManager()).full
  }
  
  async isPaused(): Promise<boolean> {
    const res = await this.managerReadOnly('is-paused', [])
    return cvToValue(res)
  }

  async *pause(payer?: AccountAddress<C> | undefined): AsyncGenerator<UnsignedTransaction<N, C>, any, any> {
    const activeNttManager = await this.getActiveNttManager()
    const tx = {
      contractName: activeNttManager.contractName,
      contractAddress: activeNttManager.address,
      functionName: 'pause',
      functionArgs: [],
      postConditionMode: PostConditionMode.Allow
    }
    yield {
      transaction: tx,
      network: this.network,
      chain: this.chain,
      description: "Ntt.pause",
      parallelizable: false
    }
  }
  
  async *unpause(payer?: AccountAddress<C> | undefined): AsyncGenerator<UnsignedTransaction<N, C>, any, any> {
    const activeNttManager = await this.getActiveNttManager()
    const tx = {
      contractName: activeNttManager.contractName,
      contractAddress: activeNttManager.address,
      functionName: 'unpause',
      functionArgs: [],
      postConditionMode: PostConditionMode.Allow
    }
    yield {
      transaction: tx,
      network: this.network,
      chain: this.chain,
      description: "Ntt.unpause",
      parallelizable: false
    }
  }

  getOwner(): Promise<AccountAddress<C>> {
    throw new Error("Method not implemented. Use isOwner instead");
  }

  async isOwner(account: AccountAddress<C>): Promise<boolean> {
    const res = await this.managerReadOnly('is-admin', [Cl.address(account.toString())])
    return cvToValue(res)
  }

  async getPauser(): Promise<AccountAddress<C> | null> {
    const res = await this.managerReadOnly('get-pauser', [])
    return cvToValue(res)
  }
  
  async *setOwner(newOwner: AccountAddress<C>, payer?: AccountAddress<C> | undefined): AsyncGenerator<UnsignedTransaction<N, C>, any, any> {
    const activeNttManager = await this.getActiveNttManager()
    const tx = {
      contractName: activeNttManager.contractName,
      contractAddress: activeNttManager.address,
      functionName: 'add-admin',
      functionArgs: [
        Cl.address(newOwner.toString()),
      ],
      postConditionMode: PostConditionMode.Allow
    }
    yield {
      transaction: tx,
      network: this.network,
      chain: this.chain,
      description: "Ntt.setOwner",
      parallelizable: false
    }
  }

  async *removeOwner(owner: AccountAddress<C>, payer?: AccountAddress<C> | undefined): AsyncGenerator<UnsignedTransaction<N, C>, any, any> {
    const activeNttManager = await this.getActiveNttManager()
    const tx = {
      contractName: activeNttManager.contractName,
      contractAddress: activeNttManager.address,
      functionName: 'remove-admin',
      functionArgs: [
        Cl.address(owner.toString()),
      ],
      postConditionMode: PostConditionMode.Allow
    }
    yield {
      transaction: tx,
      network: this.network,
      chain: this.chain,
      description: "Ntt.removeOwner",
      parallelizable: false
    }
  }

  setPauser(newOwner: AccountAddress<C>, payer?: AccountAddress<C> | undefined): AsyncGenerator<UnsignedTransaction<N, C>, any, any> {
    throw new Error("Method not implemented.");
  }
  
  getThreshold(): Promise<number> {
    throw new Error("Method not implemented.");
  }

  async *setThreshold(threshold: number, payer?: AccountAddress<C>): AsyncGenerator<UnsignedTransaction<N, C>, any, any> {
    throw new Error("Method not implemented.");
  }

  async *setPeer(peer: ChainAddress, tokenDecimals: number, inboundLimit: bigint, payer?: AccountAddress<C> | undefined): AsyncGenerator<UnsignedTransaction<N, C>, any, any> {
    const activeNttManager = await this.getActiveNttManager()
    const tx = {
      contractName: activeNttManager.contractName,
      contractAddress: activeNttManager.address,
      functionName: 'add-peer',
      functionArgs: [
        StacksNtt.chainToClBuffer(peer.chain),
        Cl.buffer(new UniversalAddress(peer.address.toString()).toUint8Array()),
        Cl.uint(tokenDecimals),
      ],
      postConditionMode: PostConditionMode.Allow
    }

    yield {
      transaction: tx,
      network: this.network,
      chain: this.chain,
      description: "Ntt.setPeer",
      parallelizable: false
    }
  }

  async *setTransceiverPeer(ix: number, peer: ChainAddress, payer?: AccountAddress<C> | undefined): AsyncGenerator<UnsignedTransaction<N, C>, any, any> {
    const transceiver = await this.getTransceiver(StacksNtt.WORMHOLE_PROTOCOL_ID)
    if(!transceiver) {
      throw new Error("Transceiver for protocol 1 (Wormhole) not found")
    }
    yield *transceiver.setPeer(peer)
  }

  isRelayingAvailable(destination: Chain): Promise<boolean> {
    throw new Error("Method not implemented.");
  }

  quoteDeliveryPrice(destination: Chain, options: Ntt.TransferOptions): Promise<bigint> {
    throw new Error("Method not implemented.");
  }

  async *transfer(
    sender: AccountAddress<C>,
    amount: bigint,
    destination: ChainAddress,
    options: Ntt.TransferOptions
  ): AsyncGenerator<UnsignedTransaction<N, C>, any, any> {
    const transceiver = await this.getTransceiver(StacksNtt.WORMHOLE_PROTOCOL_ID)
    if(!transceiver) {
      throw new Error("Transceiver for protocol 1 (Wormhole) not found")
    }
    const transceiverAddress = (await transceiver.getAddress()).address.toString()
    const activeNttManager = await this.getActiveNttManager()
    const tx = {
      contractName: activeNttManager.contractName,
      contractAddress: activeNttManager.address,
      functionName: 'send-token-transfer',
      functionArgs: [
        // Cl.address(activeNttManager.full),
        Cl.address(transceiverAddress),
        Cl.uint(amount),
        StacksNtt.chainToClBuffer(destination.chain),
        Cl.buffer(new UniversalAddress(destination.address.toString()).toUint8Array()),
      ],
      postConditionMode: PostConditionMode.Allow
    }
    yield {
      transaction: tx,
      network: this.network,
      chain: this.chain,
      description: "Ntt.transfer",
      parallelizable: false
    }
  }

  async *redeem(attestations: Ntt.Attestation[], payer?: AccountAddress<C> | undefined): AsyncGenerator<UnsignedTransaction<N, C>, any, any> {
    const transceiver = await this.getTransceiver(StacksNtt.WORMHOLE_PROTOCOL_ID)
    if(!transceiver) {
      throw new Error("Transceiver for protocol Wormhole not found")
    }

    return yield* transceiver.receive(attestations[0]!)
  }

  async getCustodyAddress(): Promise<string> {
    return `${this.nttManagerDeployer}.${this.tokenOwnerContractName}`
  }

  async getTokenDecimals(): Promise<number> {
    const decimals = await StacksPlatform.getDecimals(
      this.network,
      this.chain,
      this.connection,
      toNative(this.chain, this.tokenAddress)
    )
    return decimals
  }

  async getPeer<C extends Chain>(chain: C): Promise<Ntt.Peer<C> | null> {
    const res = await this.managerReadOnly(
      'get-peer',
      [
        StacksNtt.chainToClBuffer(chain),
      ]
    )
    const resValue = cvToValue(res)
    const address = new UniversalAddress(resValue.value.address.value)
    const decimals = Number(resValue.value.decimals.value)
    return {
      address: {
        chain,
        address
      },
      tokenDecimals: decimals,
      inboundLimit: 0n
    }
  }

  async getTransceiver(protocol: number): Promise<NttTransceiver<N, C, Ntt.Attestation> | null> {
    const activeNttManager = await this.getActiveNttManager()
    console.log(`Getting transceiver for protocol ${protocol} , managerStateContractName: ${activeNttManager.contractName}, managerDeployer: ${activeNttManager.address}`)
    const res = await this.readonly(
      'protocols-get',
      [
        Cl.uint(protocol),
      ],
      this.nttManagerStateContractName,
      activeNttManager.address
    )
    const resValue = cvToValue(res)
    return new StacksNttWormholeTransceiver(this, resValue.value)
  }

  async getActiveNttManager(): Promise<{ full: string, address: string, contractName: string }> {
    const res = await this.readonly(
      'get-active-ntt-manager',
      [],
      this.nttManagerStateContractName,
      this.nttManagerDeployer
    )
    const resValue = cvToValue(res)
    const address = resValue.split(".")[0]!
    const contractName = resValue.split(".")[1]!
    return {
      full: resValue,
      address,
      contractName
    }
  }

  getCurrentOutboundCapacity(): Promise<bigint> {
    throw new Error("Method not implemented.");
  }
  getOutboundLimit(): Promise<bigint> {
    throw new Error("Method not implemented.");
  }
  setOutboundLimit(limit: bigint, payer?: AccountAddress<C> | undefined): AsyncGenerator<UnsignedTransaction<N, C>, any, any> {
    throw new Error("Method not implemented.");
  }
  getCurrentInboundCapacity(fromChain: Chain): Promise<bigint> {
    throw new Error("Method not implemented.");
  }
  getRateLimitDuration(): Promise<bigint> {
    throw new Error("Method not implemented.");
  }
  getInboundLimit(fromChain: Chain): Promise<bigint> {
    throw new Error("Method not implemented.");
  }
  setInboundLimit(fromChain: Chain, limit: bigint, payer?: AccountAddress<C> | undefined): AsyncGenerator<UnsignedTransaction<N, C>, any, any> {
    throw new Error("Method not implemented.");
  }
  getIsApproved(attestation: Ntt.Attestation): Promise<boolean> {
    throw new Error("Method not implemented.");
  }
  getIsExecuted(attestation: Ntt.Attestation): Promise<boolean> {
    throw new Error("Method not implemented.");
  }
  getIsTransferInboundQueued(attestation: Ntt.Attestation): Promise<boolean> {
    throw new Error("Method not implemented.");
  }
  getInboundQueuedTransfer(fromChain: Chain, transceiverMessage: Ntt.Message): Promise<Ntt.InboundQueuedTransfer<C> | null> {
    throw new Error("Method not implemented.");
  }
  completeInboundQueuedTransfer(fromChain: Chain, transceiverMessage: Ntt.Message, payer?: AccountAddress<C> | undefined): AsyncGenerator<UnsignedTransaction<N, C>, any, any> {
    throw new Error("Method not implemented.");
  }
  verifyAddresses(): Promise<Partial<Ntt.Contracts> | null> {
    throw new Error("Method not implemented.");
  }

  static async getVersion(
  ): Promise<string> {
    return "1.0.0"
  }

  static async fromRpc<N extends Network>(
    connection: StacksNetwork,
    config: ChainsConfig<N, StacksPlatformType>
  ): Promise<StacksNtt<N, StacksChains>> {

    const [network, chain] = await StacksPlatform.chainFromRpc(connection)
    const version = await StacksNtt.getVersion()
    const chainConfig = config[chain]
    if (!chainConfig) {
      throw new Error(`Missing ChainsConfig for chain ${chain} on Stacks`)
    }
    return new StacksNtt(
      network as N,
      chain,
      connection,
      chainConfig.contracts,
      version
    )
  }

  static chainToClBuffer(chain: Chain): BufferCV {
    const chainIdBuffer = new ArrayBuffer(2)
    new DataView(chainIdBuffer).setUint16(0, chainToChainId(chain))
    const chainIdArr = new Uint8Array(chainIdBuffer)
    return Cl.buffer(chainIdArr)
  }

  private async managerReadOnly(functionName: string, functionArgs: any[]): Promise<any> {
    const activeNttManager = await this.getActiveNttManager()
    return this.readonly(functionName, functionArgs, activeNttManager.contractName, activeNttManager.address)
  }

  private readonly(functionName: string, functionArgs: any[], contractName: string, contractAddress: string): Promise<any> {
    return fetchCallReadOnlyFunction({
      contractName: contractName,
      contractAddress: contractAddress,
      functionName,
      functionArgs,
      client: {
        baseUrl: this.connection.client.baseUrl
      },
      senderAddress: StacksZeroAddress
    })
  }
}
