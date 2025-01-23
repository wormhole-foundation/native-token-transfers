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
  isSourceFinalized,
  isSourceInitiated,
  routes,
  signSendWait,
  toUniversal,
} from "@wormhole-foundation/sdk-connect";
import "@wormhole-foundation/sdk-definitions-ntt";
import { MultiTokenNttRoute } from "./types.js";

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

  static RELAYER_GAS_LIMIT: bigint = 300_000n;
  // More gas is needed to create a token if it doesn't exist on the destination chain yet (unattested)
  static RELAYER_GAS_LIMIT_CREATE_TOKEN: bigint = 1_000_000n;

  // @ts-ignore
  // Since we set the config on the static class, access it with this param
  // the MultiTokenNttAutomaticRoute.config will always be empty
  readonly staticConfig = this.constructor.config;
  static config: MultiTokenNttRoute.Config = { contracts: [] };

  static meta = { name: "AutomaticMultiTokenNtt" };

  //static unattestedTokenCache = new Map<string, UnattestedTokenId>();

  static supportedNetworks(): Network[] {
    return MultiTokenNttRoute.resolveSupportedNetworks(this.config);
  }

  static supportedChains(network: Network): Chain[] {
    return MultiTokenNttRoute.resolveSupportedChains(this.config, network);
  }

  // TODO: remove this, just here to compile
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
    if (sourceToken.chain !== fromChain.chain) {
      return [];
    }

    const fromNtt = await fromChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: MultiTokenNttRoute.resolveContracts(
        this.config,
        fromChain.chain
      ),
    });

    const toNtt = await toChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: MultiTokenNttRoute.resolveContracts(
        this.config,
        toChain.chain
      ),
    });

    const { address: sourceTokenAddress } = isNative(sourceToken.address)
      ? await fromChain.getNativeWrappedTokenId()
      : sourceToken;

    const tokenInfo = await fromNtt.getTokenInfo(sourceTokenAddress);

    // If the token exists on the destination chain, return it
    const destTokenAddress = await toNtt.getToken(tokenInfo);
    if (destTokenAddress) {
      return [Wormhole.tokenId(toChain.chain, destTokenAddress.toString())];
    }

    // Otherwise the token will be created when the transfer is redeemed
    // The token address is deterministic, so calculate it here

    //// Calculating the destination token address is expensive, so cache the result
    //const cacheKey = `${this.meta.name}-${sourceToken.address.toString()}-${
    //  fromChain.chain
    //}-${toChain.chain}`;
    //if (this.unattestedTokenCache.has(cacheKey)) {
    //  return [this.unattestedTokenCache.get(cacheKey)!];
    //}

    const [tokenName, tokenSymbol, tokenDecimals] = await Promise.all([
      fromNtt.getTokenName(sourceTokenAddress),
      fromNtt.getTokenSymbol(sourceTokenAddress),
      fromNtt.getTokenDecimals(sourceTokenAddress),
    ]);

    const precomputedDestTokenAddress = await toNtt.calculateTokenAddress(
      tokenInfo,
      tokenName,
      tokenSymbol,
      tokenDecimals
    );

    const destToken: UnattestedTokenId = {
      chain: toChain.chain,
      address: precomputedDestTokenAddress,
      isUnattested: true,
      decimals: tokenDecimals, // TODO: if a non-EVM platform is supported, this may need to change
      originalTokenId: sourceToken,
    };

    //this.unattestedTokenCache.set(cacheKey, destToken);

    return [destToken];
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
    const ntt = await request.fromChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: MultiTokenNttRoute.resolveContracts(
        this.staticConfig,
        request.fromChain.chain
      ),
    });

    return await ntt.isRelayingAvailable(request.toChain.chain);
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
      (await this.getDefaultRelayerGasLimit(request));

    const amt = amount.parse(params.amount, request.source.decimals);

    const validatedParams: Vp = {
      amount: params.amount,
      normalizedParams: {
        amount: amt,
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
      },
      options,
    };
    return { valid: true, params: validatedParams };
  }

  async getDefaultRelayerGasLimit(
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

    const fromToken = isNative(request.source.id.address)
      ? await request.fromChain.getNativeWrappedTokenId()
      : request.source.id;

    const tokenInfo = await fromNtt.getTokenInfo(fromToken.address);

    const toToken = await toNtt.getToken(tokenInfo);

    // More gas is needed to create a token if it doesn't exist on the destination chain yet
    const gasLimit =
      toToken === null
        ? MultiTokenNttAutomaticRoute.RELAYER_GAS_LIMIT_CREATE_TOKEN
        : MultiTokenNttAutomaticRoute.RELAYER_GAS_LIMIT;

    console.log(
      `gasLimit: originalTokenId: ${tokenInfo.address.toString()}, toToken: ${
        toToken?.toString() || null
      }, gasLimit: ${gasLimit}`
    );

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
        token: Wormhole.tokenId(fromChain.chain, "native"),
        amount: amount.fromBaseUnits(
          deliveryPrice,
          fromChain.config.nativeTokenDecimals
        ),
      },
      eta: finality.estimateFinalityTime(request.fromChain.chain),
    };

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

    const msgId: WormholeMessageId = {
      chain: vaa.emitterChain,
      emitter: vaa.emitterAddress,
      sequence: vaa.sequence,
    };

    const { payload } = vaa.payload;
    const recipientChain = payload.nttManagerPayload.payload.toChain;
    // const sourceToken =
    // payload.nttManagerPayload.payload.data.token.token.tokenAddress;
    const { trimmedAmount } = payload.nttManagerPayload.payload.data;

    // const tokenChain =
    // payload.nttManagerPayload.payload.data.token.token.chainId;
    // const tokenId = Wormhole.tokenId(tokenChain, sourceToken.toString());
    //const manager = canonicalAddress({
    //  chain: vaa.emitterChain,
    //  address: payload.nttManagerPayload.payload.callee,
    //});

    // const srcInfo = MultiTokenNttRoute.resolveNttContracts(
    //  this.staticConfig,
    //  tokenId
    //);

    //const dstInfo = MultiTokenNttRoute.resolveDestinationNttContracts(
    //  this.staticConfig,
    //  {
    //    chain: vaa.emitterChain,
    //    address: Wormhole.chainAddress(vaa.emitterChain, manager).address,
    //  },
    //  recipientChain
    //);

    const sourceContracts = MultiTokenNttRoute.resolveContracts(
      this.staticConfig,
      fromChain.chain
    );
    if (
      // TODO: is this the right comparison to make?
      toUniversal(fromChain.chain, sourceContracts.manager) !==
      payload.sourceNttManager
    ) {
      throw new Error("Invalid source NTT manager");
    }

    const destinationContracts = MultiTokenNttRoute.resolveContracts(
      this.staticConfig,
      recipientChain
    );

    const amt = amount.fromBaseUnits(
      trimmedAmount.amount,
      trimmedAmount.decimals
    );

    return {
      from: vaa.emitterChain,
      to: recipientChain,
      state: TransferState.Attested,
      originTxs: [tx],
      attestation: {
        id: msgId,
        attestation: vaa,
      },
      params: {
        amount: amount.display(amt),
        options: { relayerGasLimit: undefined }, // TODO: how to get?
        normalizedParams: {
          amount: amt,
          options: {
            relayerGasLimit: 0n, // TODO: how to get?
          },
          sourceContracts,
          destinationContracts,
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

      // TODO: this is a hack since whscan doesn't support looking up VAA by txid for monad devnet yet
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
