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
  isAttested,
  isDestinationQueued,
  isRedeemed,
  isSourceFinalized,
  isSourceInitiated,
  routes,
  signSendWait,
  finality,
  guardians,
  isSameToken,
  nativeTokenId,
  toUniversal,
  isNative,
  isCompleted,
  isFailed,
} from "@wormhole-foundation/sdk-connect";
import "@wormhole-foundation/sdk-definitions-ntt";
import { MultiTokenNttRoute, NttRoute } from "./types.js";
import { MultiTokenNtt } from "@wormhole-foundation/sdk-definitions-ntt";
import {
  AxelarGMPRecoveryAPI,
  Environment,
} from "@axelar-network/axelarjs-sdk";

type Op = routes.Options;
type Tp = routes.TransferParams<Op>;
type Vr = routes.ValidationResult<Op>;

type Vp = MultiTokenNttRoute.ValidatedParams;
type QR = routes.QuoteResult<Op, Vp>;
type Q = routes.Quote<Op, Vp>;

type R = MultiTokenNttRoute.ManualTransferReceipt;

// TODO: should be a way to override the gasLimit for the axelar transceiver
// on a per-token basis
export function multiTokenNttManualRoute(config: MultiTokenNttRoute.Config) {
  class MultiTokenNttRouteImpl<
    N extends Network
  > extends MultiTokenNttManualRoute<N> {
    static override config = config;
  }
  return MultiTokenNttRouteImpl;
}

export class MultiTokenNttManualRoute<N extends Network>
  extends routes.FinalizableRoute<N, Op, Vp, R>
  implements routes.StaticRouteMethods<typeof MultiTokenNttManualRoute>
{
  static NATIVE_GAS_DROPOFF_SUPPORTED: boolean = false;
  static IS_AUTOMATIC: boolean = false;

  // @ts-ignore
  // Since we set the config on the static class, access it with this param
  // the MultiTokenNttManualRoute.config will always be empty
  readonly staticConfig: MultiTokenNttRoute.Config = this.constructor.config;
  static config: MultiTokenNttRoute.Config = { contracts: [] };

  static meta = { name: "MultiTokenNttManualRoute" };

  static supportedNetworks(): Network[] {
    return MultiTokenNttRoute.resolveSupportedNetworks(this.config);
  }

  static supportedChains(network: Network): Chain[] {
    return MultiTokenNttRoute.resolveSupportedChains(this.config, network);
  }

  static async supportedDestinationTokens<N extends Network>(
    sourceToken: TokenId,
    fromChain: ChainContext<N>,
    toChain: ChainContext<N>
  ): Promise<TokenId[]> {
    const destinationTokenId = await MultiTokenNttRoute.getDestinationTokenId(
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
    return {};
  }

  async validate(
    request: routes.RouteTransferRequest<N>,
    params: Tp
  ): Promise<Vr> {
    const options = params.options ?? this.getDefaultOptions();

    const parsedAmount = amount.parse(params.amount, request.source.decimals);

    const sourceContracts = MultiTokenNttRoute.resolveContracts(
      this.staticConfig,
      request.fromChain.chain
    );

    const destinationContracts = MultiTokenNttRoute.resolveContracts(
      this.staticConfig,
      request.toChain.chain
    );

    const sourceNtt = await request.fromChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: sourceContracts,
    });

    const sourceToken = isNative(request.source.id.address)
      ? await sourceNtt.getWrappedNativeToken()
      : request.source.id;

    const originalToken = await sourceNtt.getOriginalToken(sourceToken);

    const validatedParams: Vp = {
      amount: params.amount,
      normalizedParams: {
        amount: parsedAmount,
        sourceContracts,
        destinationContracts,
        sourceTokenId: request.source.id,
        destinationTokenId: request.destination.id,
        originalTokenId: originalToken,
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
      eta:
        finality.estimateFinalityTime(request.fromChain.chain) +
        guardians.guardianAttestationEta * 1000,
    };

    const { fromChain, toChain } = request;

    const destinationNtt = await toChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: params.normalizedParams.destinationContracts,
    });

    const duration = await destinationNtt.getRateLimitDuration();

    if (duration > 0n) {
      const inboundLimit = await destinationNtt.getInboundLimit(
        params.normalizedParams.originalTokenId,
        fromChain.chain
      );

      if (inboundLimit !== null) {
        const capacity = await destinationNtt.getCurrentInboundCapacity(
          params.normalizedParams.originalTokenId,
          fromChain.chain
        );

        if (
          NttRoute.isCapacityThresholdExceeded(
            amount.units(dstAmount),
            capacity
          )
        ) {
          result.warnings = [
            {
              type: "DestinationCapacityWarning",
              delayDurationSec: Number(duration),
            },
          ];
        }
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

    const ntt = await fromChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: params.normalizedParams.sourceContracts,
    });

    const initXfer = ntt.transfer(
      sender,
      params.normalizedParams.sourceTokenId.address,
      amount.units(params.normalizedParams.amount),
      to
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
    if (!isAttested(receipt) && !isFailed(receipt)) {
      if (isRedeemed(receipt)) return receipt;
      throw new Error(
        "The source must be finalized in order to complete the transfer"
      );
    }

    if (!receipt.attestation) {
      throw new Error("No attestation found on the transfer receipt");
    }

    const toChain = this.wh.getChain(receipt.to);
    const ntt = await toChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: receipt.params.normalizedParams.destinationContracts,
    });
    const completeXfer = ntt.redeem(receipt.attestation.attestation);

    const txids = await signSendWait(toChain, completeXfer, signer);
    return {
      ...receipt,
      state: TransferState.DestinationInitiated,
      attestation: receipt.attestation,
      destinationTxs: txids,
    };
  }

  // TODO: this is nearly identical to the executor version
  async resume(tx: TransactionId): Promise<R> {
    const fromChain = this.wh.getChain(tx.chain);
    const [msg] = await fromChain.parseTransaction(tx.txid);
    if (!msg) throw new Error("No Wormhole messages found");

    const vaa = await this.wh.getVaa(msg, "MultiTokenNtt:WormholeTransfer");
    if (!vaa) throw new Error("No VAA found for transaction: " + tx.txid);

    const { payload } = vaa.payload.nttManagerPayload;

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

    const originalTokenId: MultiTokenNtt.OriginalTokenId = {
      chain: payload.data.token.token.chainId,
      address: payload.data.token.token.tokenAddress,
    };

    const sourceNtt = await fromChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: sourceContracts,
    });
    let sourceTokenId = await sourceNtt.getLocalToken(originalTokenId);
    if (sourceTokenId === null) throw new Error("Source token not found");

    const sourceWrappedNativeToken = await sourceNtt.getWrappedNativeToken();
    if (isSameToken(sourceWrappedNativeToken, sourceTokenId)) {
      sourceTokenId = nativeTokenId(fromChain.chain);
    }

    const destinationTokenId = await MultiTokenNttRoute.getDestinationTokenId(
      sourceTokenId,
      fromChain,
      this.wh.getChain(payload.toChain),
      this.staticConfig,
      originalTokenId
    );

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
        normalizedParams: {
          amount: amt,
          sourceContracts,
          destinationContracts,
          sourceTokenId,
          destinationTokenId,
          originalTokenId,
        },
        options: {},
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
    const ntt = await toChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: receipt.params.normalizedParams.destinationContracts,
    });
    const completeTransfer = ntt.completeInboundQueuedTransfer(
      receipt.from,
      vaa.payload.nttManagerPayload
    );
    const finalizeTxids = await signSendWait(toChain, completeTransfer, signer);
    return {
      ...receipt,
      state: TransferState.DestinationFinalized,
      destinationTxs: [...(receipt.destinationTxs ?? []), ...finalizeTxids],
    };
  }

  public override async *track(receipt: R, timeout?: number) {
    if (isCompleted(receipt)) return receipt;

    // TODO: we can put the send transceivers on the receipt
    // first track the status of the wormhole transfer.
    // when the wormhole message is approved and the transfer is not yet executed,
    // check the status of the axelar transfer. if the status is failed, mark the transfer as failed.
    // but we want to continue tracking until the destination is finalized.

    // I think the right thing to do here is to put the track method on the transceivers.
    // create an axelar transceiver.
    // we track the status of the wormhole transceiver first.
    // then track the status of the axelar transceiver.
    // in here, we will always check if the

    if (isSourceInitiated(receipt) || isSourceFinalized(receipt)) {
      const { txid } = receipt.originTxs.at(-1)!;
      const vaa = await this.wh.getVaa(
        txid,
        "MultiTokenNtt:WormholeTransfer",
        timeout
      );
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
      } satisfies AttestedTransferReceipt<MultiTokenNttRoute.ManualAttestationReceipt> as R;

      yield receipt;
    }

    const fromChain = this.wh.getChain(receipt.from);
    const sourceNtt = await fromChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: receipt.params.normalizedParams.sourceContracts,
    });

    const toChain = this.wh.getChain(receipt.to);
    const destinationNtt = await toChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: receipt.params.normalizedParams.destinationContracts,
    });

    if (isAttested(receipt) || isFailed(receipt)) {
      if (!receipt.attestation) {
        throw new Error("No attestation found on the transfer receipt");
      }

      const {
        attestation: { attestation: vaa },
      } = receipt;

      if (await destinationNtt.getIsApproved(vaa)) {
        receipt = {
          ...receipt,
          state: TransferState.DestinationInitiated,
          attestation: receipt.attestation,
          // TODO: check for destination event transactions to get dest Txids
        } satisfies RedeemedTransferReceipt<MultiTokenNttRoute.ManualAttestationReceipt>;
        yield receipt;
      } else {
        // We tracked the Wormhole message, it was approved, but the transfer was not executed.
        // Let's track the other transceivers (if any) to see if they failed.
        const sendTransceivers = await sourceNtt.getSendTransceivers(
          toChain.chain
        );

        const hasAxelar = sendTransceivers.some(
          (t: { type: string }) => t.type.toLowerCase() === "axelar"
        );

        if (hasAxelar) {
          try {
            const api = new AxelarGMPRecoveryAPI({
              environment:
                fromChain.network === "Mainnet"
                  ? Environment.MAINNET
                  : Environment.TESTNET,
            });

            const txid = receipt.originTxs.at(-1)!.txid;

            const axelarStatus = await api.queryTransactionStatus(txid);

            if (axelarStatus.error) {
              receipt = {
                ...receipt,
                state: TransferState.Failed,
                error: new routes.RelayFailedError(
                  `Axelar transceiver error: ${axelarStatus.error.message}`,
                  {
                    url:
                      this.wh.network === "Mainnet"
                        ? `https://axelarscan.io/gmp/${txid}`
                        : `https://testnet.axelarscan.io/gmp/${txid}`,
                    explorerName: "Axelarscan",
                  }
                ),
              };
              yield receipt;
            } else if (isFailed(receipt)) {
              // if we previously marked it as failed, but now it's not an error, clear the error
              receipt = {
                ...receipt,
                state: TransferState.Attested,
                attestation: receipt.attestation,
                // @ts-ignore
                error: undefined,
              } satisfies AttestedTransferReceipt<MultiTokenNttRoute.ManualAttestationReceipt> as R;
              yield receipt;
            }

            console.log("Axelar transceiver status:", axelarStatus);
          } catch (error) {
            // Log but don't fail - continue with standard tracking
            console.warn("Failed to query Axelar transceiver status:", error);
          }
        }
      }
    }

    if (isRedeemed(receipt) || isDestinationQueued(receipt)) {
      const {
        attestation: { attestation: vaa },
      } = receipt;

      const queuedTransfer = await destinationNtt.getInboundQueuedTransfer(
        vaa.emitterChain,
        vaa.payload.nttManagerPayload
      );
      if (queuedTransfer !== null) {
        receipt = {
          ...receipt,
          state: TransferState.DestinationQueued,
          queueReleaseTime: new Date(
            queuedTransfer.rateLimitExpiryTimestamp * 1000
          ),
        } satisfies DestinationQueuedTransferReceipt<MultiTokenNttRoute.ManualAttestationReceipt>;
        yield receipt;
      } else if (await destinationNtt.getIsExecuted(vaa)) {
        receipt = {
          ...receipt,
          state: TransferState.DestinationFinalized,
        } satisfies CompletedTransferReceipt<MultiTokenNttRoute.ManualAttestationReceipt>;
        yield receipt;
      }
    }

    yield receipt;
  }
}
