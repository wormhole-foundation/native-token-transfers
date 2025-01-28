import {
  Chain,
  Network,
  nativeChainIds,
  toChain,
  toChainId,
} from "@wormhole-foundation/sdk-base";
import {
  AccountAddress,
  ChainAddress,
  ChainsConfig,
  Contracts,
  isNative,
  TokenAddress,
  TokenId,
  toNative,
  universalAddress,
} from "@wormhole-foundation/sdk-definitions";
import type { EvmChains, EvmPlatformType } from "@wormhole-foundation/sdk-evm";
import {
  EvmAddress,
  EvmPlatform,
  EvmUnsignedTransaction,
  addChainId,
  addFrom,
} from "@wormhole-foundation/sdk-evm";
import "@wormhole-foundation/sdk-evm-core";

import {
  MultiTokenNtt,
  Ntt,
  NttTransceiver,
} from "@wormhole-foundation/sdk-definitions-ntt";
import { ethers, type Provider } from "ethers";
import { EvmNttWormholeTranceiver } from "./ntt.js";
import { Wormhole } from "@wormhole-foundation/sdk-connect";
import {
  GmpManagerBindings,
  loadAbiVersion,
  MultiTokenNttManagerBindings,
} from "./multiTokenNttBindings.js";

export class EvmMultiTokenNtt<N extends Network, C extends EvmChains>
  implements MultiTokenNtt<N, C>
{
  readonly chainId: bigint;

  manager: MultiTokenNttManagerBindings.NttManager;
  gmpManager: GmpManagerBindings.GmpManager;

  xcvrs: EvmNttWormholeTranceiver<N, C>[];
  managerAddress: string;

  constructor(
    readonly network: N,
    readonly chain: C,
    readonly provider: Provider,
    readonly contracts: Contracts & { multiTokenNtt?: MultiTokenNtt.Contracts },
    readonly version: string = "1.0.0"
  ) {
    console.log(`version ${version}`);
    if (!contracts.multiTokenNtt) throw new Error("No Ntt Contracts provided");

    this.chainId = nativeChainIds.networkChainToNativeChainId.get(
      network,
      chain
    ) as bigint;

    this.managerAddress = contracts.multiTokenNtt.manager;

    const abiBindings = loadAbiVersion(this.version);

    this.manager = abiBindings.NttManager.connect(
      contracts.multiTokenNtt.manager,
      this.provider
    );

    this.gmpManager = abiBindings.GmpManager.connect(
      contracts.multiTokenNtt.gmpManager,
      this.provider
    );

    if (contracts.multiTokenNtt.transceiver.wormhole) {
      this.xcvrs = [
        // Enable more Transceivers here
        new EvmNttWormholeTranceiver(
          // TODO: make this compatible
          // @ts-ignore
          this,
          contracts.multiTokenNtt.transceiver.wormhole,
          abiBindings!
        ),
      ];
    } else {
      this.xcvrs = [];
    }
  }

  async getTransceiver(ix: number): Promise<NttTransceiver<N, C, any> | null> {
    // TODO: should we make an RPC call here, or just trust that the xcvrs are set up correctly?
    return this.xcvrs[ix] || null;
  }

  async isPaused(): Promise<boolean> {
    return await this.manager.isPaused();
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

  async getIsExecuted(
    attestation: MultiTokenNtt.Attestation
  ): Promise<boolean> {
    const isExecuted = await this.gmpManager.isMessageExecuted(
      MultiTokenNtt.messageDigest(
        attestation.emitterChain,
        attestation.payload["payload"].nttManagerPayload
      )
    );
    if (!isExecuted) return false;
    // Also check that the transfer is not queued for it to be considered complete
    return !(await this.getIsTransferInboundQueued(attestation));
  }

  async getIsTransferInboundQueued(
    attestation: MultiTokenNtt.Attestation
  ): Promise<boolean> {
    return (
      (await this.getInboundQueuedTransfer(
        attestation.emitterChain,
        attestation.payload["payload"].nttManagerPayload
      )) !== null
    );
  }

  getIsApproved(attestation: MultiTokenNtt.Attestation): Promise<boolean> {
    return this.gmpManager.isMessageApproved(
      MultiTokenNtt.messageDigest(
        attestation.emitterChain,
        attestation.payload["payload"].nttManagerPayload
      )
    );
  }

  static async fromRpc<N extends Network>(
    provider: Provider,
    config: ChainsConfig<N, EvmPlatformType>
  ): Promise<EvmMultiTokenNtt<N, EvmChains>> {
    const [network, chain] = await EvmPlatform.chainFromRpc(provider);
    const conf = config[chain]!;
    if (conf.network !== network)
      throw new Error(`Network mismatch: ${conf.network} != ${network}`);

    const version = await EvmMultiTokenNtt.getVersion(provider, conf.contracts);
    return new EvmMultiTokenNtt(
      network as N,
      chain,
      provider,
      conf.contracts,
      version
    );
  }

  encodeOptions(
    options: MultiTokenNtt.TransferOptions
  ): Ntt.TransceiverInstruction[] {
    const ixs: Ntt.TransceiverInstruction[] = [];

    ixs.push({
      index: 0,
      payload: this.xcvrs[0]!.encodeFlags({ skipRelay: false }),
    });

    return ixs;
  }

  static async getVersion(
    provider: ethers.Provider,
    contracts: Contracts & { multiTokenNtt?: MultiTokenNtt.Contracts }
  ) {
    const contract = new ethers.Contract(
      contracts.multiTokenNtt!.manager,
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
        `Failed to get NTT_MANAGER_VERSION from contract ${contracts.multiTokenNtt?.manager}`
      );
      throw e;
    }
  }

  async quoteDeliveryPrice(
    dstChain: Chain,
    options: MultiTokenNtt.TransferOptions
  ): Promise<bigint> {
    const [, totalPrice] = await this.gmpManager.quoteDeliveryPrice(
      toChainId(dstChain),
      options.relayerGasLimit,
      Ntt.encodeTransceiverInstructions(this.encodeOptions(options))
    );
    return totalPrice;
  }

  async *transfer(
    sender: AccountAddress<C>,
    token: TokenAddress<C>,
    amount: bigint,
    destination: ChainAddress,
    options: MultiTokenNtt.TransferOptions
  ): AsyncGenerator<EvmUnsignedTransaction<N, C>> {
    const senderAddress = new EvmAddress(sender).toString();

    // Note: these flags are indexed by transceiver index
    const totalPrice = await this.quoteDeliveryPrice(
      destination.chain,
      options
    );

    const receiver = universalAddress(destination);

    let transferTx;
    if (isNative(token)) {
      transferTx = await this.manager[
        "transferETH(uint256,uint16,uint256,bytes32)"
      ].populateTransaction(
        amount,
        toChainId(destination.chain),
        options.relayerGasLimit,
        receiver,
        { value: amount + totalPrice }
      );
    } else {
      //TODO check for ERC-2612 (permit) support on token?
      const tokenContract = EvmPlatform.getTokenImplementation(
        this.provider,
        token.toString()
      );

      const allowance = await tokenContract.allowance(
        senderAddress,
        this.managerAddress
      );
      if (allowance < amount) {
        const approveTx = await tokenContract.approve.populateTransaction(
          this.managerAddress,
          amount
        );

        yield this.createUnsignedTx(
          addFrom(approveTx, senderAddress),
          "Ntt.Approve"
        );
      }

      transferTx = await this.manager[
        "transfer(address,uint256,uint16,uint256,bytes32)"
      ].populateTransaction(
        token.toString(),
        amount,
        toChainId(destination.chain),
        options.relayerGasLimit,
        receiver,
        { value: totalPrice }
      );
    }

    yield this.createUnsignedTx(
      addFrom(transferTx, senderAddress),
      "Ntt.transfer"
    );
  }

  async *redeem(attestations: MultiTokenNtt.Attestation[]) {
    throw new Error("Not implemented");
  }

  async getTokenName(token: TokenId): Promise<string> {
    const impl = EvmPlatform.getTokenImplementation(
      this.provider,
      token.address.toString()
    );
    return await impl.name();
  }

  async getTokenSymbol(token: TokenId): Promise<string> {
    const impl = EvmPlatform.getTokenImplementation(
      this.provider,
      token.address.toString()
    );
    return await impl.symbol();
  }

  async getTokenDecimals(token: TokenId): Promise<number> {
    return await EvmPlatform.getDecimals(
      this.chain,
      this.provider,
      token.address.toString()
    );
  }

  async getCurrentOutboundCapacity(): Promise<bigint> {
    // return await this.manager.getCurrentOutboundCapacity();
    throw new Error("Not implemented");
  }

  async getOutboundLimit(): Promise<bigint> {
    //const encoded: EncodedTrimmedAmount = (
    //  await this.manager.getOutboundLimitParams()
    //).limit;
    //const trimmedAmount: TrimmedAmount = decodeTrimmedAmount(encoded);
    //const tokenDecimals = await this.getTokenDecimals();

    //return untrim(trimmedAmount, tokenDecimals);
    throw new Error("Not implemented");
  }

  async getCurrentInboundCapacity(
    originalToken: TokenId,
    fromChain: Chain
  ): Promise<bigint> {
    if (isNative(originalToken.address))
      throw new Error("Native token not supported");
    return await this.manager.getCurrentInboundCapacity(
      {
        chainId: toChainId(fromChain),
        tokenAddress: originalToken.address.toUniversalAddress().toUint8Array(),
      },
      toChainId(fromChain)
    );
  }

  async getInboundLimit(fromChain: Chain): Promise<bigint> {
    //const encoded: EncodedTrimmedAmount = (
    //  await this.manager.getInboundLimitParams(toChainId(fromChain))
    //).limit;
    //const trimmedAmount: TrimmedAmount = decodeTrimmedAmount(encoded);
    //const tokenDecimals = await this.getTokenDecimals();

    //return untrim(trimmedAmount, tokenDecimals);
    throw new Error("Not implemented");
  }

  async getRateLimitDuration(): Promise<bigint> {
    return await this.manager.rateLimitDuration();
  }

  async getInboundQueuedTransfer(
    fromChain: Chain,
    transceiverMessage: MultiTokenNtt.Message
  ): Promise<Ntt.InboundQueuedTransfer<C> | null> {
    const queuedTransfer = await this.manager.getInboundQueuedTransfer(
      MultiTokenNtt.messageDigest(fromChain, transceiverMessage)
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
    transceiverMessage: MultiTokenNtt.Message,
    payer?: AccountAddress<C>
  ) {
    const tx =
      await this.manager.completeInboundQueuedTransfer.populateTransaction(
        MultiTokenNtt.messageDigest(fromChain, transceiverMessage)
      );
    yield this.createUnsignedTx(tx, "Ntt.completeInboundQueuedTransfer");
  }

  async getOriginalToken(localToken: TokenId): Promise<TokenId> {
    const [tokenId] = await this.manager.getTokenId(
      localToken.address.toString()
    );
    return Wormhole.tokenId(toChain(tokenId.chainId), tokenId.tokenAddress);
  }

  // This will return null if the token is not yet created
  async getLocalToken(originalToken: TokenId): Promise<TokenId | null> {
    if (isNative(originalToken.address))
      throw new Error("Native token not supported");

    const localToken = await this.manager.getToken({
      chainId: toChainId(originalToken.chain),
      tokenAddress: originalToken.address.toUniversalAddress().toUint8Array(),
    });
    console.log(`getLocalToken result: ${localToken}`);

    if (localToken === ethers.ZeroAddress) return null;

    return Wormhole.tokenId(this.chain, localToken);
  }

  async getWrappedNativeToken(): Promise<TokenId> {
    const wethAddress = await this.manager.WETH();
    return Wormhole.tokenId(this.chain, wethAddress);
  }

  async calculateLocalTokenAddress(
    originalToken: TokenId,
    tokenName: string,
    tokenSymbol: string,
    tokenDecimals: number
  ): Promise<TokenAddress<C>> {
    if (isNative(originalToken.address))
      throw new Error("Native token not supported");

    const tokenImplementation = await this.manager.tokenImplementation();

    const initializeSelector = ethers.id("initialize(string,string,uint8)");

    const coder = ethers.AbiCoder.defaultAbiCoder();

    const constructorArgs = coder.encode(
      ["address", "bytes"],
      [
        tokenImplementation,
        ethers.concat([
          initializeSelector.slice(0, 10),
          coder.encode(
            ["string", "string", "uint8"],
            // name and symbol cannot be longer than 32 bytes
            // TODO: this assumes ascii
            [tokenName.slice(0, 32), tokenSymbol.slice(0, 32), tokenDecimals]
          ),
        ]),
      ]
    );

    // TODO: we should fetch this from on-chain somehow?
    // type(ERC1967Proxy).creationCode;
    const proxyBytecode =
      "0x60806040526040516104e13803806104e1833981016040819052610022916102de565b61002e82826000610035565b50506103fb565b61003e83610061565b60008251118061004b5750805b1561005c5761005a83836100a1565b505b505050565b61006a816100cd565b6040516001600160a01b038216907fbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b90600090a250565b60606100c683836040518060600160405280602781526020016104ba60279139610180565b9392505050565b6001600160a01b0381163b61013f5760405162461bcd60e51b815260206004820152602d60248201527f455243313936373a206e657720696d706c656d656e746174696f6e206973206e60448201526c1bdd08184818dbdb9d1c9858dd609a1b60648201526084015b60405180910390fd5b7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc80546001600160a01b0319166001600160a01b0392909216919091179055565b6060600080856001600160a01b03168560405161019d91906103ac565b600060405180830381855af49150503d80600081146101d8576040519150601f19603f3d011682016040523d82523d6000602084013e6101dd565b606091505b5090925090506101ef868383876101f9565b9695505050505050565b60608315610268578251600003610261576001600160a01b0385163b6102615760405162461bcd60e51b815260206004820152601d60248201527f416464726573733a2063616c6c20746f206e6f6e2d636f6e74726163740000006044820152606401610136565b5081610272565b610272838361027a565b949350505050565b81511561028a5781518083602001fd5b8060405162461bcd60e51b815260040161013691906103c8565b634e487b7160e01b600052604160045260246000fd5b60005b838110156102d55781810151838201526020016102bd565b50506000910152565b600080604083850312156102f157600080fd5b82516001600160a01b038116811461030857600080fd5b60208401519092506001600160401b038082111561032557600080fd5b818501915085601f83011261033957600080fd5b81518181111561034b5761034b6102a4565b604051601f8201601f19908116603f01168101908382118183101715610373576103736102a4565b8160405282815288602084870101111561038c57600080fd5b61039d8360208301602088016102ba565b80955050505050509250929050565b600082516103be8184602087016102ba565b9190910192915050565b60208152600082518060208401526103e78160408501602087016102ba565b601f01601f19169190910160400192915050565b60b1806104096000396000f3fe608060405236601057600e6013565b005b600e5b601f601b6021565b6058565b565b600060537f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc546001600160a01b031690565b905090565b3660008037600080366000845af43d6000803e8080156076573d6000f35b3d6000fdfea2646970667358221220a2c581c6f59f8c322a89fe1c7cb21b56cf367c966e2b04f8b38bf4488beca08d64736f6c63430008130033416464726573733a206c6f772d6c6576656c2064656c65676174652063616c6c206661696c6564";

    const initCode = ethers.concat([proxyBytecode, constructorArgs]);
    const initCodeHash = ethers.keccak256(initCode);

    const salt = ethers.solidityPackedKeccak256(
      ["uint16", "bytes32"],
      [
        toChainId(originalToken.chain),
        originalToken.address.toUniversalAddress().toUint8Array(),
      ]
    );

    // The address where the token will be deployed
    const localTokenAddress = ethers.getCreate2Address(
      this.managerAddress,
      salt,
      initCodeHash
    );

    console.log(`calculateTokenAddress: ${localTokenAddress}`);

    return toNative(this.chain, localTokenAddress);
  }

  createUnsignedTx(
    txReq: ethers.TransactionRequest,
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
