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
  toUniversal,
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
  TrimmedAmount,
} from "@wormhole-foundation/sdk-definitions-ntt";
import { ethers, type Provider } from "ethers";
import { EvmNttWormholeTranceiver } from "./ntt.js";
import { Wormhole } from "@wormhole-foundation/sdk-connect";
import {
  GmpManagerBindings,
  loadAbiVersion,
  MultiTokenNttManagerBindings,
} from "./multiTokenNttBindings.js";
import {
  decodeTrimmedAmount,
  EncodedTrimmedAmount,
  untrim,
} from "./trimmedAmount.js";

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

  async getCurrentOutboundCapacity(localToken: TokenId): Promise<bigint> {
    const { chain, address } = await this.getOriginalToken(localToken);

    return await this.manager.getCurrentOutboundCapacity({
      chainId: toChainId(chain),
      tokenAddress: address.toUint8Array(),
    });
  }

  async getOutboundLimit(localToken: TokenId): Promise<bigint> {
    const { chain, address } = await this.getOriginalToken(localToken);

    const encoded: EncodedTrimmedAmount = (
      await this.manager.getOutboundLimitParams({
        chainId: toChainId(chain),
        tokenAddress: address.toUint8Array(),
      })
    ).limit;

    const trimmedAmount: TrimmedAmount = decodeTrimmedAmount(encoded);
    const tokenDecimals = await this.getTokenDecimals(localToken);

    return untrim(trimmedAmount, tokenDecimals);
  }

  async getCurrentInboundCapacity(
    originalToken: MultiTokenNtt.OriginalTokenId,
    fromChain: Chain
  ): Promise<bigint> {
    return await this.manager.getCurrentInboundCapacity(
      {
        chainId: toChainId(originalToken.chain),
        tokenAddress: originalToken.address.toUint8Array(),
      },
      toChainId(fromChain)
    );
  }

  async getInboundLimit(
    originalToken: MultiTokenNtt.OriginalTokenId,
    fromChain: Chain
  ): Promise<bigint | null> {
    const localToken = await this.getLocalToken(originalToken);
    if (localToken === null) return null; // Token not yet created

    const encoded: EncodedTrimmedAmount = (
      await this.manager.getInboundLimitParams(
        {
          chainId: toChainId(originalToken.chain),
          tokenAddress: originalToken.address.toUint8Array(),
        },
        toChainId(fromChain)
      )
    ).limit;

    const trimmedAmount: TrimmedAmount = decodeTrimmedAmount(encoded);
    if (trimmedAmount.amount === 0n && trimmedAmount.decimals === 0)
      return null;

    const tokenDecimals = await this.getTokenDecimals(localToken);

    return untrim(trimmedAmount, tokenDecimals);
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

  async getOriginalToken(
    localToken: TokenId
  ): Promise<MultiTokenNtt.OriginalTokenId> {
    const [tokenId] = await this.manager.getTokenId(
      localToken.address.toString()
    );

    const chain = toChain(tokenId.chainId);
    const address = toUniversal(chain, tokenId.tokenAddress);

    return {
      chain,
      address,
    };
  }

  // This will return null if the token is not yet created
  async getLocalToken(
    originalToken: MultiTokenNtt.OriginalTokenId
  ): Promise<TokenId | null> {
    const localToken = await this.manager.getToken({
      chainId: toChainId(originalToken.chain),
      tokenAddress: originalToken.address.toUint8Array(),
    });

    if (localToken === ethers.ZeroAddress) return null;

    return Wormhole.tokenId(this.chain, localToken);
  }

  async getWrappedNativeToken(): Promise<TokenId> {
    const wethAddress = await this.manager.WETH();
    return Wormhole.tokenId(this.chain, wethAddress);
  }

  async calculateLocalTokenAddress(
    originalToken: MultiTokenNtt.OriginalTokenId,
    tokenName: string,
    tokenSymbol: string,
    tokenDecimals: number
  ): Promise<TokenAddress<C>> {
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
            [tokenName.slice(0, 32), tokenSymbol.slice(0, 32), tokenDecimals]
          ),
        ]),
      ]
    );

    const creationCode = await this.manager.tokenProxyCreationCode();

    const initCode = ethers.concat([creationCode, constructorArgs]);
    const initCodeHash = ethers.keccak256(initCode);

    const salt = ethers.solidityPackedKeccak256(
      ["uint16", "bytes32"],
      [toChainId(originalToken.chain), originalToken.address.toUint8Array()]
    );

    // The address where the token will be deployed
    const localTokenAddress = ethers.getCreate2Address(
      this.managerAddress,
      salt,
      initCodeHash
    );

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
