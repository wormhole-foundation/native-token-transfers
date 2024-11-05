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
  Wormhole,
  WormholeMessageId,
  amount,
  canonicalAddress,
  finality,
  isAttested,
  isDestinationQueued,
  isRedeemed,
  isSourceFinalized,
  isSourceInitiated,
  routes,
  signSendWait,
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
  // ntt does not support gas drop-off currently
  static NATIVE_GAS_DROPOFF_SUPPORTED: boolean = false;

  // @ts-ignore
  // Since we set the config on the static class, access it with this param
  // the MultiTokenNttAutomaticRoute.config will always be empty
  readonly staticConfig = this.constructor.config;
  static config: MultiTokenNttRoute.Config = { tokens: {} };

  static meta = { name: "AutomaticMultiTokenNtt" };

  static supportedNetworks(): Network[] {
    return MultiTokenNttRoute.resolveSupportedNetworks(this.config);
  }

  static supportedChains(network: Network): Chain[] {
    return MultiTokenNttRoute.resolveSupportedChains(this.config, network);
  }

  static async supportedSourceTokens(
    fromChain: ChainContext<Network>
  ): Promise<TokenId[]> {
    return MultiTokenNttRoute.resolveSourceTokens(this.config, fromChain);
  }

  static async supportedDestinationTokens<N extends Network>(
    sourceToken: TokenId,
    fromChain: ChainContext<N>,
    toChain: ChainContext<N>
  ): Promise<TokenId[]> {
    // TODO: we will need to fetch the token from the dest chain
    // it may not have been created yet (how to handle this? dummy token?)
    return MultiTokenNttRoute.resolveDestinationTokens(
      this.config,
      sourceToken,
      fromChain,
      toChain
    );
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
    const nttContracts = MultiTokenNttRoute.resolveNttContracts(
      this.staticConfig,
      request.source.id
    );

    const ntt = await request.fromChain.getProtocol("MultiTokenNtt", {
      ntt: nttContracts,
    });

    return ntt.isRelayingAvailable(request.toChain.chain);
  }

  async validate(
    request: routes.RouteTransferRequest<N>,
    params: Tp
  ): Promise<Vr> {
    const options = params.options ?? this.getDefaultOptions();

    const gasDropoff = amount.parse(
      options.gasDropoff ?? "0.0",
      request.toChain.config.nativeTokenDecimals
    );

    const amt = amount.parse(params.amount, request.source.decimals);

    const validatedParams: Vp = {
      amount: params.amount,
      normalizedParams: {
        amount: amt,
        sourceContracts: MultiTokenNttRoute.resolveNttContracts(
          this.staticConfig,
          request.source.id
        ),
        destinationContracts: MultiTokenNttRoute.resolveNttContracts(
          this.staticConfig,
          request.destination.id
        ),
        options: {
          queue: false,
          automatic: true,
          gasDropoff: amount.units(gasDropoff),
        },
      },
      options,
    };
    return { valid: true, params: validatedParams };
  }

  async quote(
    request: routes.RouteTransferRequest<N>,
    params: Vp
  ): Promise<QR> {
    if (!(await this.isAvailable(request))) {
      throw new routes.UnavailableError(new Error("Route is not available"));
    }

    const { fromChain, toChain } = request;
    const ntt = await fromChain.getProtocol("MultiTokenNtt", {
      ntt: params.normalizedParams.sourceContracts,
    });

    console.log("FETCHING DELIVERY PRICE");
    const deliveryPrice = await ntt.quoteDeliveryPrice(
      toChain.chain,
      params.normalizedParams.options
    );
    console.log("DELIVERY PRICE", deliveryPrice);

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
      destinationNativeGas: amount.fromBaseUnits(
        params.normalizedParams.options.gasDropoff ?? 0n,
        toChain.config.nativeTokenDecimals
      ),
      eta: finality.estimateFinalityTime(request.fromChain.chain),
    };

    //const dstNtt = await toChain.getProtocol("MultiTokenNtt", {
    //  ntt: params.normalizedParams.destinationContracts,
    //});
    //console.log("FETCHING RATE LIMIT DURATION");
    //const duration = await dstNtt.getRateLimitDuration();
    //console.log("RATE LIMIT DURATION", duration);
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
      ntt: params.normalizedParams.sourceContracts,
    });

    // TODO: support "native"

    const initXfer = ntt.transfer(
      sender,
      request.source.id.address,
      amount.units(params.normalizedParams.amount),
      to,
      params.normalizedParams.options,
      fromChain
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
    const vaa = await this.wh.getVaa(
      tx.txid,
      "Ntt:MultiTokenWormholeTransferStandardRelayer"
    );
    if (!vaa) throw new Error("No VAA found for transaction: " + tx.txid);

    const msgId: WormholeMessageId = {
      chain: vaa.emitterChain,
      emitter: vaa.emitterAddress,
      sequence: vaa.sequence,
    };

    const { payload } = vaa.payload;
    const recipientChain = payload.nttManagerPayload.payload.toChain;
    const sourceToken =
      payload.nttManagerPayload.payload.data.token.token.tokenAddress;
    const { trimmedAmount } = payload.nttManagerPayload.payload.data;

    const tokenId = Wormhole.tokenId(vaa.emitterChain, sourceToken.toString());
    const manager = canonicalAddress({
      chain: vaa.emitterChain,
      address: payload["sourceNttManager"],
    });
    // const fromMultiTokenNttManager = payload.nttManagerPayload.payload.callee;

    const srcInfo = MultiTokenNttRoute.resolveNttContracts(
      this.staticConfig,
      tokenId
    );

    const dstInfo = MultiTokenNttRoute.resolveDestinationNttContracts(
      this.staticConfig,
      {
        chain: vaa.emitterChain,
        // TODO: is sourceNttManager the same as fromMultiTokenNttManager (defined above)?
        address: Wormhole.chainAddress(vaa.emitterChain, srcInfo.manager)
          .address,
      },
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
        options: { automatic: true },
        normalizedParams: {
          amount: amt,
          options: { queue: false, automatic: true },
          sourceContracts: {
            token: tokenId.address.toString(),
            manager,
            gmpManager: srcInfo.gmpManager,
            transceiver: {
              wormhole: srcInfo.transceiver.wormhole,
            },
          },
          destinationContracts: {
            token: dstInfo.token,
            manager: dstInfo.manager,
            gmpManager: dstInfo.gmpManager,
            transceiver: {
              wormhole: dstInfo.transceiver.wormhole,
            },
          },
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
      ntt: receipt.params.normalizedParams.destinationContracts,
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

      const vaa = await this.wh.getVaa(
        txid,
        "Ntt:MultiTokenWormholeTransferStandardRelayer",
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
      ntt: receipt.params.normalizedParams.destinationContracts,
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
