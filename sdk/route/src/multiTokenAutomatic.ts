import {
  AttestedTransferReceipt,
  Chain,
  ChainAddress,
  ChainContext,
  CompletedTransferReceipt,
  DestinationQueuedTransferReceipt,
  Network,
  RedeemedTransferReceipt,
  Signer,
  TokenId,
  TransactionId,
  TransferState,
  UnattestedTokenId,
  Wormhole,
  WormholeMessageId,
  amount,
  finality,
  isAttested,
  isDestinationQueued,
  isNative,
  isRedeemed,
  isSameToken,
  isSourceFinalized,
  isSourceInitiated,
  nativeTokenId,
  routes,
  signSendWait,
  toUniversal,
} from "@wormhole-foundation/sdk-connect";
import "@wormhole-foundation/sdk-definitions-ntt";
import { MultiTokenNttRoute, NttRoute } from "./types.js";

type Op = MultiTokenNttRoute.Options;
type Tp = routes.TransferParams<Op>;
type Vr = routes.ValidationResult<Op>;

type Vp = MultiTokenNttRoute.ValidatedParams;
type QR = routes.QuoteResult<Op, Vp>;
type Q = routes.Quote<Op, Vp>;

type R = MultiTokenNttRoute.AutomaticTransferReceipt;

export function multiTokenNttAutomaticRoute(config: MultiTokenNttRoute.Config) {
  class MultiTokenMultiTokenNttRouteImpl<
    N extends Network
  > extends MultiTokenNttAutomaticRoute<N> {
    static override config = config;
  }
  return MultiTokenMultiTokenNttRouteImpl;
}

export class MultiTokenNttAutomaticRoute<N extends Network>
  extends routes.AutomaticRoute<N, Op, Vp, R>
  implements routes.StaticRouteMethods<typeof MultiTokenNttAutomaticRoute>
{
  static NATIVE_GAS_DROPOFF_SUPPORTED: boolean = false;

  // Standard Relayer gas limits for transfers
  // The gas limit can vary depending on the complexity of the token contract and the specific EVM chain.
  // A good upper bound for gas limits to accommodate most ERC-20 token transfers across multiple EVM chains
  // should be used. This limit should cover the majority of tokens, including those with additional logic
  // such as hooks or complex state changes.
  static SR_GAS_LIMIT: bigint = 375_000n;
  // More gas is needed to create a token if it doesn't exist on the destination chain yet (unattested).
  static SR_GAS_LIMIT_CREATE_TOKEN: bigint = 1_250_000n;

  // @ts-ignore
  // Since we set the config on the static class, access it with this param
  // the MultiTokenNttAutomaticRoute.config will always be empty
  readonly staticConfig = this.constructor.config;
  static config: MultiTokenNttRoute.Config = { contracts: [] };

  static meta = { name: "AutomaticMultiTokenNtt" };

  static supportedNetworks(): Network[] {
    return MultiTokenNttRoute.resolveSupportedNetworks(this.config);
  }

  static supportedChains(network: Network): Chain[] {
    return MultiTokenNttRoute.resolveSupportedChains(this.config, network);
  }

  // TODO: remove this
  static supportedSourceTokens(
    fromChain: ChainContext<Network>
  ): Promise<TokenId[]> {
    throw new Error("not implemented");
  }

  static async supportedDestinationTokens<N extends Network>(
    sourceToken: TokenId,
    fromChain: ChainContext<N>,
    toChain: ChainContext<N>
  ): Promise<TokenId[]> {
    const destinationTokenId = await getDestinationTokenId(
      sourceToken,
      fromChain,
      toChain,
      this.config
    );
    return [destinationTokenId];
  }

  static isProtocolSupported<N extends Network>(
    chain: ChainContext<N>
  ): boolean {
    return chain.supportsProtocol("MultiTokenNtt");
  }

  getDefaultOptions(): Op {
    return MultiTokenNttRoute.AutomaticOptions;
  }

  async isAvailable(request: routes.RouteTransferRequest<N>): Promise<boolean> {
    const fromNtt = await request.fromChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: MultiTokenNttRoute.resolveContracts(
        this.staticConfig,
        request.fromChain.chain
      ),
    });

    return await fromNtt.isRelayingAvailable(request.toChain.chain);
  }

  async validate(
    request: routes.RouteTransferRequest<N>,
    params: Tp
  ): Promise<Vr> {
    if (request.source.id.chain !== request.fromChain.chain) {
      return {
        valid: false,
        params: params,
        error: new Error("Source token must be native to the source chain"),
      };
    }

    if (request.destination.id.chain !== request.toChain.chain) {
      return {
        valid: false,
        params: params,
        error: new Error(
          "Destination token must be native to the destination chain"
        ),
      };
    }

    const options = params.options ?? this.getDefaultOptions();

    const relayerGasLimit =
      options.relayerGasLimit ??
      (await this.getStandardRelayerGasLimit(request));

    const parsedAmount = amount.parse(params.amount, request.source.decimals);
    // The trimmedAmount may differ from the parsedAmount if the parsedAmount includes dust
    const trimmedAmount = NttRoute.trimAmount(
      parsedAmount,
      request.destination.decimals
    );

    const validatedParams: Vp = {
      amount: params.amount,
      normalizedParams: {
        amount: trimmedAmount,
        sourceContracts: MultiTokenNttRoute.resolveContracts(
          this.staticConfig,
          request.fromChain.chain
        ),
        destinationContracts: MultiTokenNttRoute.resolveContracts(
          this.staticConfig,
          request.toChain.chain
        ),
        options: {
          relayerGasLimit,
        },
        sourceTokenId: request.source.id,
        destinationTokenId: request.destination.id,
      },
      options,
    };
    return { valid: true, params: validatedParams };
  }

  async getStandardRelayerGasLimit(
    request: routes.RouteTransferRequest<N>
  ): Promise<bigint> {
    const fromNtt = await request.fromChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: MultiTokenNttRoute.resolveContracts(
        this.staticConfig,
        request.fromChain.chain
      ),
    });

    const toNtt = await request.toChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: MultiTokenNttRoute.resolveContracts(
        this.staticConfig,
        request.toChain.chain
      ),
    });

    const sourceToken = isNative(request.source.id.address)
      ? await fromNtt.getWrappedNativeToken()
      : request.source.id;

    const originalToken = await fromNtt.getOriginalToken(sourceToken);

    const destinationToken = await toNtt.getLocalToken(originalToken);

    // More gas is needed to create the token on the destination chain
    const gasLimit =
      destinationToken === null
        ? MultiTokenNttAutomaticRoute.SR_GAS_LIMIT_CREATE_TOKEN
        : MultiTokenNttAutomaticRoute.SR_GAS_LIMIT;

    return gasLimit;
  }

  async quote(
    request: routes.RouteTransferRequest<N>,
    params: Vp
  ): Promise<QR> {
    const { fromChain, toChain } = request;
    const fromNtt = await fromChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: params.normalizedParams.sourceContracts,
    });

    if (!(await fromNtt.isRelayingAvailable(toChain.chain))) {
      throw new routes.UnavailableError(new Error("Relaying is unavailable"));
    }

    const deliveryPrice = await fromNtt.quoteDeliveryPrice(
      toChain.chain,
      params.normalizedParams.options
    );

    const result: QR = {
      success: true,
      params,
      sourceToken: {
        token: request.source.id,
        amount: params.normalizedParams.amount,
      },
      destinationToken: {
        token: request.destination.id,
        amount: amount.parse(params.amount, request.destination.decimals),
      },
      relayFee: {
        token: nativeTokenId(fromChain.chain),
        amount: amount.fromBaseUnits(
          deliveryPrice,
          fromChain.config.nativeTokenDecimals
        ),
      },
      eta: finality.estimateFinalityTime(request.fromChain.chain),
    };

    // TODO: rate limits
    //const dstNtt = await toChain.getProtocol("MultiTokenNtt", {
    //  multiTokenNtt: params.normalizedParams.destinationContracts,
    //});
    //const duration = await dstNtt.getRateLimitDuration();
    //if (duration > 0n) {
    //  // TODO: support native
    //  if (isNative(request.source.id.address))
    //    throw new Error("Native token not supported");
    //  const tokenId = await ntt.getTokenId(
    //    request.source.id.address.toNative(fromChain.chain)
    //  );
    //  const capacity = await dstNtt.getCurrentInboundCapacity(
    //    tokenId,
    //    fromChain.chain
    //  );
    //  const dstAmount = amount.parse(
    //    params.amount,
    //    request.destination.decimals
    //  );
    //  if (
    //    MultiTokenNttRoute.isCapacityThresholdExceeded(
    //      amount.units(dstAmount),
    //      capacity
    //    )
    //  ) {
    //    result.warnings = [
    //      {
    //        type: "DestinationCapacityWarning",
    //        delayDurationSec: Number(duration),
    //      },
    //    ];
    //  }
    //}

    return result;
  }

  async initiate(
    request: routes.RouteTransferRequest<N>,
    signer: Signer,
    quote: Q,
    to: ChainAddress
  ): Promise<R> {
    const { params } = quote;
    const { fromChain } = request;
    const sender = Wormhole.parseAddress(signer.chain(), signer.address());

    const ntt = await fromChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: params.normalizedParams.sourceContracts,
    });

    const initXfer = ntt.transfer(
      sender,
      request.source.id.address,
      amount.units(params.normalizedParams.amount),
      to,
      params.normalizedParams.options
    );
    const txids = await signSendWait(fromChain, initXfer, signer);

    return {
      from: fromChain.chain,
      to: to.chain,
      state: TransferState.SourceInitiated,
      originTxs: txids,
      params,
    };
  }

  async resume(tx: TransactionId): Promise<R> {
    const fromChain = this.wh.getChain(tx.chain);
    const [msg] = await fromChain.parseTransaction(tx.txid);
    if (!msg) throw new Error("No Wormhole messages found");

    const vaa = await this.wh.getVaa(
      msg,
      "MultiTokenNtt:WormholeTransferStandardRelayer"
    );
    if (!vaa) throw new Error("No VAA found for transaction: " + tx.txid);

    const { payload } = vaa.payload["payload"].nttManagerPayload;

    const sourceContracts = MultiTokenNttRoute.resolveContracts(
      this.staticConfig,
      fromChain.chain
    );
    if (
      !payload.sender.equals(
        toUniversal(fromChain.chain, sourceContracts.manager)
      )
    ) {
      throw new Error("Invalid source manager");
    }

    const destinationContracts = MultiTokenNttRoute.resolveContracts(
      this.staticConfig,
      payload.toChain
    );

    const { trimmedAmount } = payload.data;
    const amt = amount.fromBaseUnits(
      trimmedAmount.amount,
      trimmedAmount.decimals
    );

    const originalTokenId = Wormhole.tokenId(
      payload.data.token.token.chainId,
      payload.data.token.token.tokenAddress.toString()
    );

    const fromNtt = await fromChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: sourceContracts,
    });
    let sourceTokenId = await fromNtt.getLocalToken(originalTokenId);
    if (sourceTokenId === null) throw new Error("Source token not found");

    const sourceWrappedNativeToken = await fromNtt.getWrappedNativeToken();
    if (isSameToken(sourceWrappedNativeToken, sourceTokenId)) {
      sourceTokenId = nativeTokenId(fromChain.chain);
    }

    // Get destination token ID
    const destinationTokenId = await getDestinationTokenId(
      sourceTokenId,
      fromChain,
      this.wh.getChain(payload.toChain),
      this.staticConfig,
      originalTokenId
    );

    // Build and return the response
    const msgId: WormholeMessageId = {
      chain: vaa.emitterChain,
      emitter: vaa.emitterAddress,
      sequence: vaa.sequence,
    };

    return {
      from: vaa.emitterChain,
      to: payload.toChain,
      state: TransferState.Attested,
      originTxs: [tx],
      attestation: {
        id: msgId,
        attestation: vaa,
      },
      params: {
        amount: amount.display(amt),
        options: { relayerGasLimit: undefined },
        normalizedParams: {
          amount: amt,
          options: {
            relayerGasLimit: 0n,
          },
          sourceContracts,
          destinationContracts,
          sourceTokenId,
          destinationTokenId,
        },
      },
    };
  }

  // Even though this is an automatic route, the transfer may need to be
  // manually finalized if it was queued
  async finalize(signer: Signer, receipt: R): Promise<R> {
    if (!isDestinationQueued(receipt)) {
      throw new Error(
        "The transfer must be destination queued in order to finalize"
      );
    }

    const {
      attestation: { attestation: vaa },
    } = receipt;

    const toChain = this.wh.getChain(receipt.to);
    const ntt = await toChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: receipt.params.normalizedParams.destinationContracts,
    });
    const sender = Wormhole.chainAddress(signer.chain(), signer.address());
    const completeTransfer = ntt.completeInboundQueuedTransfer(
      receipt.from,
      vaa.payload["payload"]["nttManagerPayload"],
      sender.address
    );
    const finalizeTxids = await signSendWait(toChain, completeTransfer, signer);
    return {
      ...receipt,
      state: TransferState.DestinationFinalized,
      destinationTxs: [...(receipt.destinationTxs ?? []), ...finalizeTxids],
    };
  }

  public override async *track(receipt: R, timeout?: number) {
    if (isSourceInitiated(receipt) || isSourceFinalized(receipt)) {
      const { txid } = receipt.originTxs[receipt.originTxs.length - 1]!;

      const fromChain = this.wh.getChain(receipt.from);
      const [msg] = await fromChain.parseTransaction(txid);
      if (!msg) throw new Error("No Wormhole messages found");

      const vaa = await this.wh.getVaa(
        msg,
        "MultiTokenNtt:WormholeTransferStandardRelayer",
        timeout
      );
      if (!vaa) {
        throw new Error(`No VAA found for transaction: ${txid}`);
      }

      const msgId: WormholeMessageId = {
        chain: vaa.emitterChain,
        emitter: vaa.emitterAddress,
        sequence: vaa.sequence,
      };

      receipt = {
        ...receipt,
        state: TransferState.Attested,
        attestation: {
          id: msgId,
          attestation: vaa,
        },
      } satisfies AttestedTransferReceipt<MultiTokenNttRoute.AutomaticAttestationReceipt> as R;

      yield receipt;
    }

    const toChain = this.wh.getChain(receipt.to);
    const ntt = await toChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: receipt.params.normalizedParams.destinationContracts,
    });

    if (isAttested(receipt)) {
      const {
        attestation: { attestation: vaa },
      } = receipt;

      if (await ntt.getIsApproved(vaa)) {
        receipt = {
          ...receipt,
          state: TransferState.DestinationInitiated,
          // TODO: check for destination event transactions to get dest Txids
        } satisfies RedeemedTransferReceipt<MultiTokenNttRoute.AutomaticAttestationReceipt>;
        yield receipt;
      }
    }

    if (isRedeemed(receipt) || isDestinationQueued(receipt)) {
      const {
        attestation: { attestation: vaa },
      } = receipt;

      const queuedTransfer = await ntt.getInboundQueuedTransfer(
        vaa.emitterChain,
        vaa.payload["payload"]["nttManagerPayload"]
      );
      if (queuedTransfer !== null) {
        receipt = {
          ...receipt,
          state: TransferState.DestinationQueued,
          queueReleaseTime: new Date(
            queuedTransfer.rateLimitExpiryTimestamp * 1000
          ),
        } satisfies DestinationQueuedTransferReceipt<MultiTokenNttRoute.AutomaticAttestationReceipt>;
        yield receipt;
      } else if (await ntt.getIsExecuted(vaa)) {
        receipt = {
          ...receipt,
          state: TransferState.DestinationFinalized,
        } satisfies CompletedTransferReceipt<MultiTokenNttRoute.AutomaticAttestationReceipt>;
        yield receipt;
      }
    }

    yield receipt;
  }
}

// Helper function to get the destination TokenId
async function getDestinationTokenId<N extends Network>(
  sourceToken: TokenId,
  fromChain: ChainContext<N>,
  toChain: ChainContext<N>,
  config: MultiTokenNttRoute.Config,
  originalToken?: TokenId
): Promise<TokenId> {
  if (sourceToken.chain !== fromChain.chain) {
    throw new Error("Source token must be native to the source chain");
  }

  const fromNtt = await fromChain.getProtocol("MultiTokenNtt", {
    multiTokenNtt: MultiTokenNttRoute.resolveContracts(config, fromChain.chain),
  });

  const toNtt = await toChain.getProtocol("MultiTokenNtt", {
    multiTokenNtt: MultiTokenNttRoute.resolveContracts(config, toChain.chain),
  });

  if (isNative(sourceToken.address)) {
    sourceToken = await fromNtt.getWrappedNativeToken();
  }

  originalToken =
    originalToken ?? (await fromNtt.getOriginalToken(sourceToken));

  // If the token exists on the destination chain, return it
  const destinationToken = await toNtt.getLocalToken(originalToken);
  if (destinationToken) {
    // If the destination token is the wrapped native token,
    // return the native token since it gets unwrapped by the contract
    const wrappedNativeToken = await toNtt.getWrappedNativeToken();
    if (isSameToken(wrappedNativeToken, destinationToken)) {
      return nativeTokenId(toChain.chain);
    }
    return destinationToken;
  }

  // Otherwise the token will be created by the contract when the transfer is completed

  const [tokenName, tokenSymbol, tokenDecimals] = await Promise.all([
    fromNtt.getTokenName(sourceToken),
    fromNtt.getTokenSymbol(sourceToken),
    fromNtt.getTokenDecimals(sourceToken),
  ]);

  // The destination token address is deterministic, so calculate it here
  // NOTE: there is a very slim race condition where the token is overridden before a transfer is completed
  const destinationTokenAddress = await toNtt.calculateLocalTokenAddress(
    originalToken,
    tokenName,
    tokenSymbol,
    tokenDecimals
  );

  return {
    chain: toChain.chain,
    address: destinationTokenAddress,
    isUnattested: true,
    // TODO: decimals may need to be adjusted for non-EVM platforms when we support them
    decimals: tokenDecimals,
    originalTokenId: Wormhole.tokenId(
      sourceToken.chain,
      sourceToken.address.toString()
    ),
  } as UnattestedTokenId;
}
