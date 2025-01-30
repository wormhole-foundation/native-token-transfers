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
  isAttested,
  isDestinationQueued,
  isRedeemed,
  isSourceFinalized,
  isSourceInitiated,
  routes,
  signSendWait,
  finality,
} from "@wormhole-foundation/sdk-connect";
import "@wormhole-foundation/sdk-definitions-ntt";
import { NttRoute } from "./types.js";

type Op = NttRoute.Options;
type Tp = routes.TransferParams<Op>;
type Vr = routes.ValidationResult<Op>;

type Vp = NttRoute.ValidatedParams;
type QR = routes.QuoteResult<Op, Vp>;
type Q = routes.Quote<Op, Vp>;

type R = NttRoute.ManualTransferReceipt;

export function nttManualRoute(config: NttRoute.Config) {
  class NttRouteImpl<N extends Network> extends NttManualRoute<N> {
    static override config = config;
  }
  return NttRouteImpl;
}

export class NttManualRoute<N extends Network>
  extends routes.FinalizableRoute<N, Op, Vp, R>
  implements routes.StaticRouteMethods<typeof NttManualRoute>
{
  static NATIVE_GAS_DROPOFF_SUPPORTED: boolean = false;
  static IS_AUTOMATIC: boolean = false;

  // @ts-ignore
  // Since we set the config on the static class, access it with this param
  // the NttManualRoute.config will always be empty
  readonly staticConfig = this.constructor.config;
  static config: NttRoute.Config = { tokens: {} };

  static meta = { name: "ManualNtt" };

  static supportedNetworks(): Network[] {
    return NttRoute.resolveSupportedNetworks(this.config);
  }

  static supportedChains(network: Network): Chain[] {
    return NttRoute.resolveSupportedChains(this.config, network);
  }

  static async supportedSourceTokens(
    fromChain: ChainContext<Network>
  ): Promise<TokenId[]> {
    return NttRoute.resolveSourceTokens(this.config, fromChain);
  }

  static async supportedDestinationTokens<N extends Network>(
    sourceToken: TokenId,
    fromChain: ChainContext<N>,
    toChain: ChainContext<N>
  ): Promise<TokenId[]> {
    return NttRoute.resolveDestinationTokens(
      this.config,
      sourceToken,
      fromChain,
      toChain
    );
  }

  static isProtocolSupported<N extends Network>(
    chain: ChainContext<N>
  ): boolean {
    return chain.supportsProtocol("Ntt");
  }

  getDefaultOptions(): Op {
    return NttRoute.ManualOptions;
  }

  async validate(
    request: routes.RouteTransferRequest<N>,
    params: Tp
  ): Promise<Vr> {
    const options = params.options ?? this.getDefaultOptions();

    const parsedAmount = amount.parse(params.amount, request.source.decimals);
    // The trimmedAmount may differ from the parsedAmount if the parsedAmount includes dust
    const trimmedAmount = NttRoute.trimAmount(
      parsedAmount,
      request.destination.decimals
    );

    const gasDropoff = amount.units(
      amount.parse(
        options.gasDropoff ?? "0.0",
        request.toChain.config.nativeTokenDecimals
      )
    );

    const validatedParams: Vp = {
      amount: params.amount,
      normalizedParams: {
        amount: trimmedAmount,
        sourceContracts: NttRoute.resolveNttContracts(
          this.staticConfig,
          request.source.id
        ),
        destinationContracts: NttRoute.resolveNttContracts(
          this.staticConfig,
          request.destination.id
        ),
        options: {
          queue: false,
          automatic: false,
          gasDropoff,
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
    const dstAmount = amount.scale(
      params.normalizedParams.amount,
      request.destination.decimals
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
        amount: dstAmount,
      },
      eta: finality.estimateFinalityTime(request.fromChain.chain),
    };
    const { fromChain, toChain } = request;
    const dstNtt = await toChain.getProtocol("Ntt", {
      ntt: params.normalizedParams.destinationContracts,
    });
    const duration = await dstNtt.getRateLimitDuration();
    if (duration > 0n) {
      const capacity = await dstNtt.getCurrentInboundCapacity(fromChain.chain);
      if (
        NttRoute.isCapacityThresholdExceeded(amount.units(dstAmount), capacity)
      ) {
        result.warnings = [
          {
            type: "DestinationCapacityWarning",
            delayDurationSec: Number(duration),
          },
        ];
      }
    }
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

    const ntt = await fromChain.getProtocol("Ntt", {
      ntt: params.normalizedParams.sourceContracts,
    });
    const initXfer = ntt.transfer(
      sender,
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

  async complete(signer: Signer, receipt: R): Promise<R> {
    if (!isAttested(receipt)) {
      if (isRedeemed(receipt)) return receipt;
      throw new Error(
        "The source must be finalized in order to complete the transfer"
      );
    }

    const toChain = this.wh.getChain(receipt.to);
    const ntt = await toChain.getProtocol("Ntt", {
      ntt: receipt.params.normalizedParams.destinationContracts,
    });
    const sender = Wormhole.parseAddress(signer.chain(), signer.address());
    const completeXfer = ntt.redeem([receipt.attestation.attestation], sender);

    const txids = await signSendWait(toChain, completeXfer, signer);
    return {
      ...receipt,
      state: TransferState.DestinationInitiated,
      destinationTxs: txids,
    };
  }

  async resume(tx: TransactionId): Promise<R> {
    const vaa = await this.wh.getVaa(tx.txid, "Ntt:WormholeTransfer");
    if (!vaa) throw new Error("No VAA found for transaction: " + tx.txid);

    const msgId: WormholeMessageId = {
      chain: vaa.emitterChain,
      emitter: vaa.emitterAddress,
      sequence: vaa.sequence,
    };

    const { recipientChain, trimmedAmount } =
      vaa.payload["nttManagerPayload"].payload;

    const token = canonicalAddress({
      chain: vaa.emitterChain,
      address: vaa.payload["nttManagerPayload"].payload.sourceToken,
    });
    const manager = canonicalAddress({
      chain: vaa.emitterChain,
      address: vaa.payload["sourceNttManager"],
    });
    const whTransceiver =
      vaa.emitterChain === "Solana"
        ? manager
        : canonicalAddress({
            chain: vaa.emitterChain,
            address: vaa.emitterAddress,
          });

    const dstInfo = NttRoute.resolveDestinationNttContracts(
      this.staticConfig,
      {
        chain: vaa.emitterChain,
        address: vaa.payload["sourceNttManager"],
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
        options: { automatic: false },
        normalizedParams: {
          amount: amt,
          options: { queue: false },
          sourceContracts: {
            token,
            manager,
            transceiver: {
              wormhole: whTransceiver,
            },
          },
          destinationContracts: {
            token: dstInfo.token,
            manager: dstInfo.manager,
            transceiver: {
              wormhole: dstInfo.transceiver["wormhole"]!,
            },
          },
        },
      },
    };
  }

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
    const ntt = await toChain.getProtocol("Ntt", {
      ntt: receipt.params.normalizedParams.destinationContracts,
    });
    const sender = Wormhole.chainAddress(signer.chain(), signer.address());
    const completeTransfer = ntt.completeInboundQueuedTransfer(
      receipt.from,
      vaa.payload["nttManagerPayload"],
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
      const vaa = await this.wh.getVaa(txid, "Ntt:WormholeTransfer", timeout);
      if (!vaa) throw new Error("No VAA found for transaction: " + txid);

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
      } satisfies AttestedTransferReceipt<NttRoute.ManualAttestationReceipt> as R;

      yield receipt;
    }

    const toChain = this.wh.getChain(receipt.to);
    const ntt = await toChain.getProtocol("Ntt", {
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
        } satisfies RedeemedTransferReceipt<NttRoute.ManualAttestationReceipt>;
        yield receipt;
      }
    }

    if (isRedeemed(receipt) || isDestinationQueued(receipt)) {
      const {
        attestation: { attestation: vaa },
      } = receipt;

      const queuedTransfer = await ntt.getInboundQueuedTransfer(
        vaa.emitterChain,
        vaa.payload["nttManagerPayload"]
      );
      if (queuedTransfer !== null) {
        receipt = {
          ...receipt,
          state: TransferState.DestinationQueued,
          queueReleaseTime: new Date(
            queuedTransfer.rateLimitExpiryTimestamp * 1000
          ),
        } satisfies DestinationQueuedTransferReceipt<NttRoute.ManualAttestationReceipt>;
        yield receipt;
      } else if (await ntt.getIsExecuted(vaa)) {
        receipt = {
          ...receipt,
          state: TransferState.DestinationFinalized,
        } satisfies CompletedTransferReceipt<NttRoute.ManualAttestationReceipt>;
        yield receipt;
      }
    }

    yield receipt;
  }
}
