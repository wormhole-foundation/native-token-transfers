import {
  Chain,
  Network,
  encoding,
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
  serialize,
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
  decodeTrimmedAmount,
  EncodedTrimmedAmount,
  MultiTokenNtt,
  Ntt,
  TrimmedAmount,
  untrim,
} from "@wormhole-foundation/sdk-definitions-ntt";
import { Contract, ethers, Interface, type Provider } from "ethers";
import {
  GmpManagerBindings,
  loadAbiVersion,
  MultiTokenNttBindings,
} from "./multiTokenNttBindings.js";
import { getAxelarGasFee } from "./axelar.js";
import { NativeTokenTransferCodec } from "./ethers-contracts/1_1_0/MultiTokenNtt.js";

export class EvmMultiTokenNtt<N extends Network, C extends EvmChains>
  implements MultiTokenNtt<N, C>
{
  readonly chainId: bigint;
  readonly managerAddress: string;
  readonly multiTokenNtt: MultiTokenNttBindings.MultiTokenNtt;
  readonly gmpManager: GmpManagerBindings.GmpManager;
  readonly abiBindings: ReturnType<typeof loadAbiVersion>;

  constructor(
    readonly network: N,
    readonly chain: C,
    readonly provider: Provider,
    readonly contracts: Contracts & { multiTokenNtt?: MultiTokenNtt.Contracts },
    readonly version: string = "1.1.0"
  ) {
    if (!contracts.multiTokenNtt) throw new Error("No Ntt Contracts provided");

    this.chainId = nativeChainIds.networkChainToNativeChainId.get(
      network,
      chain
    ) as bigint;

    this.abiBindings = loadAbiVersion(this.version);

    this.managerAddress = contracts.multiTokenNtt.manager;

    this.multiTokenNtt = this.abiBindings.MultiTokenNtt.connect(
      contracts.multiTokenNtt.manager,
      this.provider
    );

    this.gmpManager = this.abiBindings.GmpManager.connect(
      contracts.multiTokenNtt.gmpManager,
      this.provider
    );
  }

  async isPaused(): Promise<boolean> {
    return await this.multiTokenNtt.isPaused();
  }

  async getIsExecuted(
    attestation: MultiTokenNtt.Attestation
  ): Promise<boolean> {
    const isExecuted = await this.gmpManager.isMessageExecuted(
      MultiTokenNtt.messageDigest(
        attestation.emitterChain,
        attestation.payload.nttManagerPayload
      )
    );
    if (!isExecuted) return false;

    // Also check that the transfer is not queued for it to be considered complete
    const isInboundQueued = await this.getIsTransferInboundQueued(attestation);
    return !isInboundQueued;
  }

  async getIsTransferInboundQueued(
    attestation: MultiTokenNtt.Attestation
  ): Promise<boolean> {
    return (
      (await this.getInboundQueuedTransfer(
        attestation.emitterChain,
        attestation.payload.nttManagerPayload
      )) !== null
    );
  }

  async getIsApproved(
    attestation: MultiTokenNtt.Attestation
  ): Promise<boolean> {
    return await this.gmpManager.isMessageApprovedForChain(
      toChainId(attestation.emitterChain),
      MultiTokenNtt.messageDigest(
        attestation.emitterChain,
        attestation.payload.nttManagerPayload
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

  private static versionCache = new Map<string, string>();

  static async getVersion(
    provider: ethers.Provider,
    contracts: Contracts & { multiTokenNtt?: MultiTokenNtt.Contracts }
  ) {
    const multiTokenNtt = contracts.multiTokenNtt;
    if (!multiTokenNtt) {
      throw new Error("No multiTokenNtt contracts configured");
    }

    // Use cached version to save on RPC calls
    const cacheKey = `${multiTokenNtt.chain}-${multiTokenNtt.manager}`;
    const cached = EvmMultiTokenNtt.versionCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const contract = new ethers.Contract(
      multiTokenNtt.manager,
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
      EvmMultiTokenNtt.versionCache.set(cacheKey, abiVersion);
      return abiVersion;
    } catch (e) {
      console.error(
        `Failed to get NTT_MANAGER_VERSION from contract ${contracts.multiTokenNtt?.manager}`
      );
      throw e;
    }
  }

  async getSendTransceivers(
    destinationChain: Chain
  ): Promise<Ntt.TransceiverMeta[]> {
    const sendTransceivers =
      await this.gmpManager.getSendTransceiversWithIndicesForChain(
        toChainId(destinationChain)
      );

    return await Promise.all(
      sendTransceivers.map(async (transceiver) => {
        const type = await this.getTransceiverType(transceiver.transceiver);
        return {
          address: transceiver.transceiver,
          index: Number(transceiver.index),
          type,
        };
      })
    );
  }

  async getReceiveTransceivers(
    sourceChain: Chain
  ): Promise<Ntt.TransceiverMeta[]> {
    const receiveTransceivers =
      await this.gmpManager.getReceiveTransceiversWithIndicesForChain(
        toChainId(sourceChain)
      );

    return await Promise.all(
      receiveTransceivers.map(async (transceiver) => {
        const type = await this.getTransceiverType(transceiver.transceiver);
        return {
          address: transceiver.transceiver,
          index: Number(transceiver.index),
          type,
        };
      })
    );
  }

  async transceiverAttestedToMessage(
    fromChain: Chain,
    transceiverMessage: MultiTokenNtt.Message,
    index: number
  ): Promise<boolean> {
    return await this.gmpManager.transceiverAttestedToMessage(
      MultiTokenNtt.messageDigest(fromChain, transceiverMessage),
      index
    );
  }

  private async getTransceiverType(
    transceiverAddress: string
  ): Promise<string> {
    const transceiverInterface = new Interface([
      "function getTransceiverType() external view returns (string memory)",
    ]);

    const transceiverContract = new Contract(
      transceiverAddress,
      transceiverInterface,
      this.provider
    );

    return await transceiverContract
      .getFunction("getTransceiverType")
      .staticCall();
  }

  async createTransceiverInstructions(
    dstChain: Chain,
    gasLimit: bigint
  ): Promise<Ntt.TransceiverInstruction[]> {
    const sendTransceivers = await this.getSendTransceivers(dstChain);

    const instructions: Ntt.TransceiverInstruction[] = await Promise.all(
      sendTransceivers.map(async (transceiver) => {
        switch (transceiver.type.toLowerCase()) {
          case "wormhole":
            return {
              index: transceiver.index,
              payload: new Uint8Array([1]), // disable standard relayer, use executor route for automatic relay
            };
          case "axelar": {
            // If we fail to fetch the gas fee, then use 1 wei as a fallback.
            // The Axelar GMP status API should return an invalid gas fee error
            // which the track() method will surface, allowing a user to top up
            // the gas fee.
            const gasFee = await getAxelarGasFee(
              this.network,
              this.chain,
              dstChain,
              gasLimit
            ).catch(() => 1n);
            return {
              index: transceiver.index,
              payload: encoding.bignum.toBytes(gasFee, 32),
            };
          }
          default:
            throw new Error(
              `Unsupported transceiver type: ${transceiver.type} at index ${transceiver.index}`
            );
        }
      })
    );

    // The contract requires the instructions to be sorted by transceiver index in ascending order.
    instructions.sort((a, b) => a.index - b.index);

    return instructions;
  }

  async quoteDeliveryPrice(
    dstChain: Chain,
    instructions: Ntt.TransceiverInstruction[]
  ): Promise<bigint> {
    const [, totalPrice] = await this.gmpManager.quoteDeliveryPrice(
      toChainId(dstChain),
      Ntt.encodeTransceiverInstructions(instructions)
    );
    return totalPrice;
  }

  async *transfer(
    sender: AccountAddress<C>,
    token: TokenAddress<C>,
    amount: bigint,
    destination: ChainAddress,
    destinationGasLimit: bigint
  ): AsyncGenerator<EvmUnsignedTransaction<N, C>> {
    const senderAddress = new EvmAddress(sender).toString();

    const transceiverInstructions = await this.createTransceiverInstructions(
      destination.chain,
      destinationGasLimit
    );

    const totalPrice = await this.quoteDeliveryPrice(
      destination.chain,
      transceiverInstructions
    );

    const receiver = universalAddress(destination);

    let transferTx;
    if (isNative(token)) {
      const gasTokenTransferArgs = {
        amount,
        recipientChain: toChainId(destination.chain),
        recipient: receiver,
        refundAddress: receiver,
        shouldQueue: false,
        transceiverInstructions: Ntt.encodeTransceiverInstructions(
          transceiverInstructions
        ),
        additionalPayload: "0x",
      };

      transferTx =
        await this.multiTokenNtt.wrapAndTransferGasToken.populateTransaction(
          gasTokenTransferArgs,
          { value: amount + totalPrice }
        );
    } else {
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

      const transferArgs = {
        token: token.toString(),
        amount,
        recipientChain: toChainId(destination.chain),
        recipient: receiver,
        refundAddress: receiver,
        shouldQueue: false,
        transceiverInstructions: Ntt.encodeTransceiverInstructions(
          transceiverInstructions
        ),
        additionalPayload: "0x",
      };

      transferTx = await this.multiTokenNtt.transfer.populateTransaction(
        transferArgs,
        { value: totalPrice }
      );
    }

    yield this.createUnsignedTx(
      addFrom(transferTx, senderAddress),
      "Ntt.transfer"
    );
  }

  async *redeem(attestation: MultiTokenNtt.Attestation) {
    const transceivers = await this.getReceiveTransceivers(
      attestation.emitterChain
    );

    const wormholeTransceiver = transceivers.find((t) => t.type === "wormhole");
    if (!wormholeTransceiver) {
      throw new Error("No Wormhole transceiver registered for this chain");
    }

    const transceiver = this.abiBindings.NttTransceiver.connect(
      wormholeTransceiver.address,
      this.provider
    );

    const tx = await transceiver.receiveMessage.populateTransaction(
      serialize(attestation)
    );

    yield this.createUnsignedTx(tx, "NttTransceiver.receiveMessage");
  }

  async getTokenMeta(token: TokenId): Promise<MultiTokenNtt.TokenMeta> {
    const tokenAddress = token.address.toString();

    const tokenImpl = EvmPlatform.getTokenImplementation(
      this.provider,
      tokenAddress
    );

    const getDecimals = EvmPlatform.getDecimals(
      this.network,
      this.chain,
      this.provider,
      tokenAddress
    );

    const [name, symbol, decimals] = await Promise.all([
      tokenImpl.name(),
      tokenImpl.symbol(),
      getDecimals,
    ]);

    return { name, symbol, decimals };
  }

  async getCurrentOutboundCapacity(localToken: TokenId): Promise<bigint> {
    const { chain, address } = await this.getOriginalToken(localToken);

    return await this.multiTokenNtt.getCurrentOutboundCapacity({
      chainId: toChainId(chain),
      tokenAddress: address.toUint8Array(),
    });
  }

  async getOutboundLimit(localToken: TokenId): Promise<bigint> {
    const { chain, address } = await this.getOriginalToken(localToken);

    const encoded: EncodedTrimmedAmount = (
      await this.multiTokenNtt.getOutboundLimitParams({
        chainId: toChainId(chain),
        tokenAddress: address.toUint8Array(),
      })
    ).limit;

    const trimmedAmount: TrimmedAmount = decodeTrimmedAmount(encoded);
    const tokenMeta = await this.getTokenMeta(localToken);

    return untrim(trimmedAmount, tokenMeta.decimals);
  }

  async getCurrentInboundCapacity(
    originalToken: MultiTokenNtt.OriginalTokenId,
    fromChain: Chain
  ): Promise<bigint> {
    return await this.multiTokenNtt.getCurrentInboundCapacity(
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
      await this.multiTokenNtt.getInboundLimitParams(
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

    const tokenMeta = await this.getTokenMeta(localToken);

    return untrim(trimmedAmount, tokenMeta.decimals);
  }

  async getRateLimitDuration(): Promise<bigint> {
    return await this.multiTokenNtt.rateLimitDuration();
  }

  async getInboundQueuedTransfer(
    fromChain: Chain,
    transceiverMessage: MultiTokenNtt.Message
  ): Promise<MultiTokenNtt.InboundQueuedTransfer | null> {
    const digest = MultiTokenNtt.messageDigest(fromChain, transceiverMessage);
    const queuedTransfer = await this.multiTokenNtt.getInboundQueuedTransfer(
      digest
    );
    if (queuedTransfer.txTimestamp > 0n) {
      const { sourceChainId, txTimestamp } = queuedTransfer;
      const duration = await this.getRateLimitDuration();
      return {
        sourceChain: toChain(sourceChainId),
        rateLimitExpiryTimestamp: Number(txTimestamp + duration),
      };
    }
    return null;
  }

  async *completeInboundQueuedTransfer(
    fromChain: Chain,
    transceiverMessage: MultiTokenNtt.Message
  ) {
    const { trimmedAmount, token, sender, to } =
      transceiverMessage.payload.data;

    const digest = MultiTokenNtt.messageDigest(fromChain, transceiverMessage);

    const transfer: NativeTokenTransferCodec.NativeTokenTransferStruct = {
      amount: trimmedAmount.amount,
      token: {
        meta: token.meta,
        token: {
          chainId: toChainId(token.token.chainId),
          tokenAddress: token.token.tokenAddress.toString(),
        },
      },
      sender: sender.toString(),
      to: to.toString(),
      additionalPayload: transceiverMessage.payload.data.additionalPayload,
    };

    const tx =
      await this.multiTokenNtt.completeInboundQueuedTransfer.populateTransaction(
        digest,
        transfer
      );

    yield this.createUnsignedTx(tx, "Ntt.completeInboundQueuedTransfer");
  }

  async getOriginalToken(
    localToken: TokenId
  ): Promise<MultiTokenNtt.OriginalTokenId> {
    const [tokenId] = await this.multiTokenNtt.getTokenId(
      localToken.address.toString()
    );

    const chain = toChain(tokenId.chainId);
    const address = toUniversal(chain, tokenId.tokenAddress);

    return {
      chain,
      address,
    };
  }

  async isWrappedToken(localToken: TokenId): Promise<boolean> {
    const originalToken = await this.getOriginalToken(localToken);
    return originalToken.chain !== this.chain;
  }

  // This will return null if the token doesn't exist
  async getLocalToken(
    originalToken: MultiTokenNtt.OriginalTokenId
  ): Promise<TokenId | null> {
    const localToken = await this.multiTokenNtt.getToken({
      chainId: toChainId(originalToken.chain),
      tokenAddress: originalToken.address.toUint8Array(),
    });

    if (localToken === ethers.ZeroAddress) return null;

    return { chain: this.chain, address: toNative(this.chain, localToken) };
  }

  async getWrappedNativeToken(): Promise<TokenId> {
    const wethAddress = await this.multiTokenNtt.WETH();
    return { chain: this.chain, address: toNative(this.chain, wethAddress) };
  }

  // If the local token doesn't exist yet, this will return the address where it will be deployed
  async calculateLocalTokenAddress(
    originalToken: MultiTokenNtt.OriginalTokenId,
    tokenMeta: MultiTokenNtt.TokenMeta
  ): Promise<TokenAddress<C>> {
    const tokenImplementation = await this.multiTokenNtt.tokenImplementation();

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
            [
              tokenMeta.name.slice(0, 32),
              tokenMeta.symbol.slice(0, 32),
              tokenMeta.decimals,
            ]
          ),
        ]),
      ]
    );

    const creationCode = await this.multiTokenNtt.tokenProxyCreationCode();

    const initCode = ethers.concat([creationCode, constructorArgs]);
    const initCodeHash = ethers.keccak256(initCode);

    const salt = ethers.solidityPackedKeccak256(
      ["uint16", "bytes32"],
      [toChainId(originalToken.chain), originalToken.address.toUint8Array()]
    );

    // The address where the token will be deployed on the destination chain
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

  // Upper bound estimate of gas limit needed to redeem on this chain
  async estimateGasLimit(
    originalToken: MultiTokenNtt.OriginalTokenId
  ): Promise<bigint> {
    const existingToken = await this.getLocalToken(originalToken);

    if (!existingToken) {
      // Redeeming will create the token on this chain
      // so we need to account for the extra gas.
      return 1_000_000n;
    }

    return 300_000n;
  }
}
