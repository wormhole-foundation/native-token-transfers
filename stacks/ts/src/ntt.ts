import { Chain, chainToChainId, Network } from "@wormhole-foundation/sdk-base";
import { AccountAddress, UnsignedTransaction, ChainAddress, ChainsConfig, Contracts, serialize, toNative, UniversalAddress } from "@wormhole-foundation/sdk-definitions";
import { Ntt, NttTransceiver } from "@wormhole-foundation/sdk-definitions-ntt";
import { StacksChains, StacksPlatform, StacksPlatformType, StacksZeroAddress } from "@wormhole-foundation/sdk-stacks";
import { StacksNetwork } from "@stacks/network";
import { BufferCV, Cl, cvToValue, fetchCallReadOnlyFunction, PostConditionMode } from "@stacks/transactions";

export class StacksNttWormholeTransceiver<N extends Network, C extends StacksChains> implements NttTransceiver<N, C, Ntt.Attestation> {

  // static readonly CONTRACT_NAME = 'wormhole-transceiver-v1'
  static readonly STATE_CONTRACT_NAME = 'wormhole-transceiver-state'

  private readonly contractName: string;
  private readonly deployer: string;

  constructor(
    readonly manager: StacksNtt<N, C>,
    readonly tokenAddress: string,
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

  async getPeer<C extends Chain>(chain: C): Promise<ChainAddress<C> | null> {
    const res = await this.readonly(
      'peers-get',
      [
        StacksNtt.chainToClBuffer(chain),
      ],
      StacksNttWormholeTransceiver.STATE_CONTRACT_NAME,
      this.deployer
    )
    const resValue = cvToValue(res)
    if(!resValue) {
      return null
    }
    const address = new UniversalAddress(resValue.value)
    return {
      address,
      chain,
    }
  }

  async *setPauser(newPauser: AccountAddress<C>, payer?: AccountAddress<C> | undefined): AsyncGenerator<UnsignedTransaction<N, C>, any, any> {
    const tx = {
      contractName: this.contractName,
      contractAddress: this.deployer,
      functionName: 'transfer-pause-capability',
      functionArgs: [
        Cl.address(newPauser.toString()),
      ],
      postConditionMode: PostConditionMode.Allow
    }
    yield {
      transaction: tx,
      network: this.manager.network,
      chain: this.manager.chain,
      description: "Ntt.setTransceiverPauser",
      parallelizable: false
    }
  }

  async getPauser(): Promise<AccountAddress<C> | null> {
    const res = await this.transceiverReadOnly('get-pauser', [])
    return cvToValue(res)
  }

  async *receive(attestation: Ntt.Attestation, sender?: AccountAddress<C> | undefined): AsyncGenerator<UnsignedTransaction<N, C>, any, any> {
    console.log(`Stacks receive`)
    const tx = {
      contractName: this.contractName,
      contractAddress: this.deployer,
      functionName: 'receive-token-transfer',
      functionArgs: [
        Cl.address(await this.manager.getFullAddress()),
        Cl.address(this.tokenAddress),
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


  private async transceiverReadOnly(functionName: string, functionArgs: any[]): Promise<any> {
    return this.readonly(functionName, functionArgs, this.contractName, this.deployer)
  }

  private readonly(functionName: string, functionArgs: any[], contractName: string, contractAddress: string): Promise<any> {
    return fetchCallReadOnlyFunction({
      contractName: contractName,
      contractAddress: contractAddress,
      functionName,
      functionArgs,
      client: {
        baseUrl: this.manager.connection.client.baseUrl
      },
      senderAddress: StacksZeroAddress
    })
  }
}

export type StacksNttContracts = Ntt.Contracts & {
  state: string
  tokenOwner: string
  transceiverState: {
    [type: string]: string;
  }
}

export class StacksNtt<N extends Network, C extends StacksChains> 
  implements Ntt<N, C> {

  static readonly NTT_MANAGER_STATE_CONTRACT_NAME = `ntt-manager-state`
  static readonly NTT_MANAGER_CONTRACT_NAME = `ntt-manager-v1`
  static readonly NTT_TOKEN_OWNER_CONTRACT_NAME = `token-manager`
  static readonly WORMHOLE_PROTOCOL_ID = 1

  private readonly nttManagerDeployer: string;
  private readonly nttStateContractName: string;
  private readonly tokenOwnerContractName: string;
  private readonly tokenAddress: string;

  constructor(
    readonly network: N,
    readonly chain: C,
    readonly connection: StacksNetwork,
    readonly contracts: Contracts & { ntt?: StacksNttContracts },
    readonly version: string = "1.0.0"
  ) {
    console.log(`NTT CONSTRUCTOR`)
    console.log(contracts)
    if(!contracts.ntt) {
      throw new Error("NTT Contracts not found")
    }

    const manager = contracts.ntt.manager
    this.nttStateContractName = contracts?.ntt?.state
    this.tokenOwnerContractName = contracts?.ntt?.tokenOwner
    if(!!manager && manager.startsWith("0x")) {
      const utf8Manager = Buffer.from(manager.slice(2), "hex").toString("utf-8")
      console.log(`Manager is hex`, utf8Manager)
      const deployer = utf8Manager.split(".")[0]
      const managerName = utf8Manager.split(".")[1]
      if(!deployer || !managerName) {
        throw new Error("Invalid manager address")
      }
      this.nttManagerDeployer = deployer
      this.tokenAddress = contracts.ntt.token
    } else {
      if(!!contracts.ntt.manager) {
        const managerFullAddress = contracts.ntt.manager
        const managerAddressSplit = managerFullAddress.split(".")
        this.nttManagerDeployer = managerAddressSplit[0] || ""
      } else {
        const nttManagerStateFullAddress = contracts.ntt.state
        const managerAddressSplit = !nttManagerStateFullAddress? [] : nttManagerStateFullAddress.split(".")
        this.nttManagerDeployer = managerAddressSplit[0] || ""
        
        // this.nttManagerStateContractName = managerAddressSplit[1] || ""
      }
      this.tokenAddress = contracts.ntt.token
      
      // if (tokenOwnerFullAddress) {
      //   const tokenOwnerAddressSplit = tokenOwnerFullAddress.split(".")
      //   this.tokenOwnerContractName = tokenOwnerAddressSplit[1] || tokenOwnerFullAddress
      // } else {
      //   this.tokenOwnerContractName = ""
      // }
    }

  }

  async getMode(): Promise<Ntt.Mode> {
    const res = await this.managerReadOnly('get-mode', [])
    const modeValue = cvToValue(res)
    return modeValue.value === "0x00" ? "locking" : "burning"
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

  /**
   * We do noy have a `get-admin` or `get-owner` function.
   * We'll optimistically assume that the deployer is the owner
   * or throw an error if it's not.
   */
  async getOwner(): Promise<AccountAddress<C>> {
    const deployerNative = toNative(this.chain, this.nttManagerDeployer)
    const isDeployerOwner = await this.isOwner(deployerNative)
    if (isDeployerOwner) {
      return deployerNative
    }
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
    return Promise.resolve(1)
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
        // Cl.uint(tokenDecimals),
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
    const transceiver = await this.getTransceiver(0)
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
    const transceiver = await this.getTransceiver(0)
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
        Cl.address(this.tokenAddress),
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
    const transceiver = await this.getTransceiver(0)
    if(!transceiver) {
      throw new Error("Transceiver for protocol Wormhole not found")
    }

    return yield* transceiver.receive(attestations[0]!)
  }

  async getCustodyAddress(): Promise<string> {
    return this.getTokenOwnerContractAddress()
  }

  async getTokenDecimals(): Promise<number> {
    let tokenToQuery: string
    if(!this.tokenAddress) {
      const token = await this.managerReadOnly(
        'get-token-contract',
        []
      )
      const tokenValue = cvToValue(token)
      tokenToQuery = tokenValue.value
    } else {
      tokenToQuery = this.tokenAddress
    }
    console.log(`get token decimals: ${tokenToQuery}`)
    console.log(toNative(this.chain, tokenToQuery))
    const decimals = await StacksPlatform.getDecimals(
      this.network,
      this.chain,
      this.connection,
      toNative(this.chain, tokenToQuery)
    )
    return decimals
  }

  async getPeer<C extends Chain>(chain: C): Promise<Ntt.Peer<C> | null> {
    // const res = await this.managerReadOnly(
    //   'get-peer',
    //   [
    //     StacksNtt.chainToClBuffer(chain),
    //   ]
    // )

    console.log(`Stacks NTT getPeer for chain: ${chain} buffer`, StacksNtt.chainToClBuffer(chain))

    const res = await this.readonly(
      'peers-get',
      [
        StacksNtt.chainToClBuffer(chain),
      ],
      this.getStateContractName(),
      this.nttManagerDeployer
    )
  
    const resValue = cvToValue(res)
    if(!resValue) {
      return null
    }
    const address = new UniversalAddress(resValue.value)
    return {
      address: {
        chain,
        address
      },
      tokenDecimals: 0, // TODO check do we want decimals back?
      inboundLimit: 0n
    }
  }

  /**
   * The current Stacks implementation has a single transceiver.
   * Queried by protocol ID. Wormhole protocol ID is u1. Index is ignored.
   */
  async getTransceiver(index: number): Promise<NttTransceiver<N, C, Ntt.Attestation> | null> {
    const activeNttManager = await this.getActiveNttManager()
    const whProtocol = StacksNtt.WORMHOLE_PROTOCOL_ID
    console.log(`Getting transceiver for protocol ${whProtocol} , managerStateContractName: ${activeNttManager.contractName}, managerDeployer: ${activeNttManager.address}`)
    const res = await this.readonly(
      'protocols-get',
      [
        Cl.uint(whProtocol),
      ],
      this.getStateContractName(),
      activeNttManager.address
    )
    const resValue = cvToValue(res)
    return new StacksNttWormholeTransceiver(this, this.tokenAddress, resValue.value)
  }

  async getActiveNttManager(): Promise<{ full: string, address: string, contractName: string }> {
    const res = await this.readonly(
      'get-active-ntt-manager',
      [],
      this.getStateContractName(),
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

  getStateContractName(): string {
    return this.nttStateContractName?.split(".")[1] ?? StacksNtt.NTT_MANAGER_STATE_CONTRACT_NAME;
  }

  getTokenOwnerContractAddress(): string {
    return this.tokenOwnerContractName ?? `${this.nttManagerDeployer}.${StacksNtt.NTT_TOKEN_OWNER_CONTRACT_NAME}`;
  }

  getCurrentOutboundCapacity(): Promise<bigint> {
    throw new Error("Method not implemented.");
  }
  getOutboundLimit(): Promise<bigint> {
    return Promise.resolve(0n)
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
    return Promise.resolve(0n)
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
  async verifyAddresses(): Promise<Partial<Ntt.Contracts> | null> {
    try {
      const local: Partial<Ntt.Contracts> = {
        manager: this.contracts.ntt!.manager,
        token: this.contracts.ntt!.token,
        transceiver: this.contracts.ntt!.transceiver || {},
      };

      console.log(`## VERIFY ADDRESS ##`)
      console.log(`LOCAL:`)
      console.log(local)

      const deployerAddress = this.nttManagerDeployer

      // In stacks we don't really need to query on-chain state
      // because the deployment must be done by a single address
      // and names are fixed
      const remoteStateAddress = `${deployerAddress}.${StacksNtt.NTT_MANAGER_STATE_CONTRACT_NAME}`
      console.log(`calling remote`, `${deployerAddress}.${StacksNtt.NTT_MANAGER_CONTRACT_NAME}`)
      const remote: Partial<StacksNttContracts> = {
        manager: this.contracts.ntt!.manager,
        token: cvToValue(await this.managerReadOnly('get-token-contract', [], `${deployerAddress}.${StacksNtt.NTT_MANAGER_CONTRACT_NAME}`)).value,
        transceiver: {
          wormhole: cvToValue(await this.readonly(
            "protocols-get",
            [
              Cl.uint(StacksNtt.WORMHOLE_PROTOCOL_ID),
            ],
            StacksNtt.NTT_MANAGER_STATE_CONTRACT_NAME,
            deployerAddress
          )).value
        },
        state: remoteStateAddress
      };

      console.log(`REMOTE:`)
      console.log(remote)

      const deleteMatching = (a: any, b: any) => {
        for (const k in a) {
          if (typeof a[k] === "object" && a[k] !== null && typeof b[k] === "object" && b[k] !== null) {
            deleteMatching(a[k], b[k]);
            if (Object.keys(a[k]).length === 0) delete a[k];
          } else if (a[k] === b[k]) {
            delete a[k];
          }
        }
      };

      deleteMatching(remote, local);

      return Object.keys(remote).length > 0 ? remote : null;
    } catch (e) {
      console.warn(`Failed to verify addresses: ${e}`);
      return null;
    }
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

  private async managerReadOnly(functionName: string, functionArgs: any[], manager? :string): Promise<any> {
    const activeNttManager = !!manager? {contractName: manager.split(".")[1]!, address: manager.split(".")[0]!} : await this.getActiveNttManager()
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
