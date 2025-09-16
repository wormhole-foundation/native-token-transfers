import {
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
  TransferReceipt as _TransferReceipt,
  Wormhole,
  WormholeMessageId,
  amount,
  canonicalAddress,
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
  relayInstructionsLayout,
  deserializeLayout,
  isFailed,
  guardians,
  UniversalAddress,
  chainToPlatform,
  encoding,
  serializeLayout,
  signedQuoteLayout,
  toChainId,
  toUniversal,
  AttestedTransferReceipt,
} from "@wormhole-foundation/sdk-connect";
import "@wormhole-foundation/sdk-definitions-ntt";
import { MultiTokenNttRoute, NttRoute } from "../types.js";
import {
  MultiTokenNtt,
  MultiTokenNttWithExecutor,
  Ntt,
  NttWithExecutor,
} from "@wormhole-foundation/sdk-definitions-ntt";
import {
  calculateReferrerFee,
  Capabilities,
  fetchCapabilities,
  fetchSignedQuote,
  fetchStatus,
} from "./utils.js";
import { getDefaultReferrerAddress } from "./consts.js";
import { NttExecutorRoute } from "./executor.js";
import { trackAxelar, trackExecutor } from "../tracking.js";

export namespace MultiTokenNttExecutorRoute {
  export type Config = {
    contracts: MultiTokenNtt.Contracts[];
    referrerFee?: ReferrerFeeConfig;
  };

  export type ReferrerFeeConfig = NttExecutorRoute.ReferrerFeeConfig;

  export type Options = {
    // 0.0 - 1.0 percentage of the maximum gas drop-off amount
    nativeGas?: number;
  };

  export type NormalizedParams = MultiTokenNttRoute.NormalizedParams & {
    referrerFeeDbps: bigint;
  };

  export interface ValidatedParams
    extends routes.ValidatedTransferParams<Options> {
    normalizedParams: NormalizedParams;
  }

  export type TransferReceipt<
    SC extends Chain = Chain,
    DC extends Chain = Chain
  > = _TransferReceipt<MultiTokenNttRoute.ManualAttestationReceipt, SC, DC> & {
    params: ValidatedParams;
    trackingInfo: {
      transceiverAttested: { [type: string]: boolean };
    };
  };
}

type Op = MultiTokenNttExecutorRoute.Options;
type Tp = routes.TransferParams<Op>;
type Vr = routes.ValidationResult<Op>;

type Vp = MultiTokenNttExecutorRoute.ValidatedParams;

type Q = routes.Quote<Op, Vp, MultiTokenNttWithExecutor.Quote>;
type QR = routes.QuoteResult<Op, Vp>;

type R = MultiTokenNttExecutorRoute.TransferReceipt;

export function multiTokenNttExecutorRoute(
  config: MultiTokenNttExecutorRoute.Config
) {
  class MultiTokenNttExecutorRouteImpl<
    N extends Network
  > extends MultiTokenNttExecutorRoute<N> {
    static override config = config;
  }
  return MultiTokenNttExecutorRouteImpl;
}

export class MultiTokenNttExecutorRoute<N extends Network>
  extends routes.AutomaticRoute<N, Op, Vp, R>
  implements routes.StaticRouteMethods<typeof MultiTokenNttExecutorRoute>
{
  static NATIVE_GAS_DROPOFF_SUPPORTED: boolean = true;

  // Since we set the config on the static class, access it with this param
  // the MultiTokenNttExecutorRoute.config will always be empty
  readonly staticConfig: MultiTokenNttExecutorRoute.Config =
    // @ts-ignore
    this.constructor.config;
  static config: MultiTokenNttExecutorRoute.Config = { contracts: [] };

  static meta = { name: "MultiTokenNttExecutorRoute" };

  static supportedNetworks(): Network[] {
    return MultiTokenNttRoute.resolveSupportedNetworks(this.config.contracts);
  }

  static supportedChains(network: Network): Chain[] {
    return MultiTokenNttRoute.resolveSupportedChains(
      this.config.contracts,
      network
    );
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
      this.config.contracts
    );
    return [destinationTokenId];
  }

  static isProtocolSupported<N extends Network>(
    chain: ChainContext<N>
  ): boolean {
    return chain.supportsProtocol("MultiTokenNtt");
  }

  getDefaultOptions(): Op {
    return {
      nativeGas: 0,
    };
  }

  async validate(
    request: routes.RouteTransferRequest<N>,
    params: Tp
  ): Promise<Vr> {
    if (request.fromChain.chain === request.toChain.chain) {
      return {
        valid: false,
        error: new Error("Source and destination chains must differ"),
        params,
      };
    }

    const options = params.options ?? this.getDefaultOptions();

    if (
      options.nativeGas !== undefined &&
      (options.nativeGas < 0 || options.nativeGas > 1)
    ) {
      return {
        valid: false,
        error: new Error("Invalid native gas percentage"),
        params,
      };
    }

    const parsedAmount = amount.parse(params.amount, request.source.decimals);

    const trimmedAmount = NttRoute.trimAmount(
      parsedAmount,
      request.destination.decimals
    );

    const sourceContracts = MultiTokenNttRoute.resolveContracts(
      this.staticConfig.contracts,
      request.fromChain.chain
    );

    const destinationContracts = MultiTokenNttRoute.resolveContracts(
      this.staticConfig.contracts,
      request.toChain.chain
    );

    const sourceNtt = await request.fromChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: sourceContracts,
    });

    const sourceToken = isNative(request.source.id.address)
      ? await sourceNtt.getWrappedNativeToken()
      : request.source.id;

    const originalTokenId = await sourceNtt.getOriginalToken(sourceToken);

    const sendTransceivers = await sourceNtt.getSendTransceivers(
      request.toChain.chain
    );

    const referrerFeeDbps = this.getReferrerFeeDbps(request);

    const gasLimit = await this.estimateGasLimit(request, originalTokenId);

    const validatedParams: Vp = {
      amount: params.amount,
      normalizedParams: {
        amount: trimmedAmount,
        sourceContracts,
        destinationContracts,
        referrerFeeDbps,
        sourceTokenId: request.source.id,
        destinationTokenId: request.destination.id,
        originalTokenId,
        gasLimit,
        sendTransceivers,
      },
      options,
    };

    return { valid: true, params: validatedParams };
  }

  async quote(
    request: routes.RouteTransferRequest<N>,
    params: Vp
  ): Promise<QR> {
    const { fromChain, toChain } = request;

    try {
      const executorQuote = await this.fetchExecutorQuote(request, params);

      const { deliveryPrice, transceiverInstructions } =
        await this.fetchDeliveryPriceAndInstructions(
          fromChain,
          toChain,
          params
        );

      const { remainingAmount, estimatedCost, gasDropOff, expires } =
        executorQuote;

      const receivedAmount = amount.scale(
        amount.fromBaseUnits(remainingAmount, request.source.decimals),
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
          amount: receivedAmount,
        },
        relayFee: {
          token: nativeTokenId(fromChain.chain),
          amount: amount.fromBaseUnits(
            estimatedCost + deliveryPrice,
            fromChain.config.nativeTokenDecimals
          ),
        },
        destinationNativeGas: amount.fromBaseUnits(
          gasDropOff,
          toChain.config.nativeTokenDecimals
        ),
        eta:
          finality.estimateFinalityTime(request.fromChain.chain) +
          guardians.guardianAttestationEta * 1000,
        expires,
        details: {
          ...executorQuote,
          deliveryPrice,
          transceiverInstructions,
        },
      };

      const destinationNtt = await toChain.getProtocol("MultiTokenNtt", {
        multiTokenNtt: params.normalizedParams.destinationContracts,
      });

      const duration = await destinationNtt.getRateLimitDuration();
      const warnings = await MultiTokenNttRoute.checkRateLimit(
        destinationNtt,
        fromChain.chain,
        params.normalizedParams.originalTokenId,
        receivedAmount,
        duration
      );
      if (warnings) {
        result.warnings = warnings;
      }

      return result;
    } catch (e: unknown) {
      return {
        success: false,
        error: e instanceof Error ? e : new Error(String(e)),
      };
    }
  }

  getReferrerFeeDbps(request: routes.RouteTransferRequest<N>): bigint {
    let referrerFeeDbps = 0n;
    if (this.staticConfig.referrerFee) {
      referrerFeeDbps = this.staticConfig.referrerFee.feeDbps;
      if (this.staticConfig.referrerFee.perTokenOverrides) {
        const sourceTokenAddress = canonicalAddress(request.source.id);
        const override =
          this.staticConfig.referrerFee.perTokenOverrides[
            request.source.id.chain
          ]?.[sourceTokenAddress];
        if (override?.referrerFeeDbps !== undefined) {
          referrerFeeDbps = override.referrerFeeDbps;
        }
      }
    }
    return referrerFeeDbps;
  }

  getReferrerAddress(fromChain: ChainContext<N>): ChainAddress {
    let referrer = getDefaultReferrerAddress(fromChain.chain);
    const referrerFeeConfig = this.staticConfig.referrerFee;
    if (referrerFeeConfig) {
      const platform = chainToPlatform(fromChain.chain);
      const referrerAddress =
        referrerFeeConfig.referrerAddresses?.[platform] ?? "";
      if (referrerAddress) {
        referrer = Wormhole.chainAddress(fromChain.chain, referrerAddress);
      }
    }
    return referrer;
  }

  async validateCapabilities(
    fromChain: ChainContext<N>,
    toChain: ChainContext<N>
  ): Promise<{
    sourceCapabilities: Capabilities;
    destinationCapabilities: Capabilities;
  }> {
    const capabilities = await fetchCapabilities(fromChain.network);
    const sourceCapabilities = capabilities[toChainId(fromChain.chain)];
    if (!sourceCapabilities) {
      throw new Error("Unsupported source chain");
    }

    const destinationCapabilities = capabilities[toChainId(toChain.chain)];
    if (
      !destinationCapabilities ||
      !destinationCapabilities.requestPrefixes.includes("ERN1")
    ) {
      throw new Error("Unsupported destination chain");
    }

    return { sourceCapabilities, destinationCapabilities };
  }

  calculateGasDropOff(gasDropOffLimit: bigint, params: Vp): bigint {
    return params.options.nativeGas && gasDropOffLimit > 0n
      ? (BigInt(Math.round(params.options.nativeGas * 100)) * gasDropOffLimit) /
          100n
      : 0n;
  }

  async estimateGasLimit(
    request: routes.RouteTransferRequest<N>,
    originalTokenId: MultiTokenNtt.OriginalTokenId
  ): Promise<bigint> {
    return MultiTokenNttRoute.estimateGasLimit(
      request,
      originalTokenId,
      this.staticConfig.contracts,
      this.staticConfig.referrerFee?.perTokenOverrides
    );
  }

  async fetchExecutorQuote(
    request: routes.RouteTransferRequest<N>,
    params: Vp
  ): Promise<NttWithExecutor.Quote> {
    const { fromChain, toChain } = request;

    const referrer = this.getReferrerAddress(fromChain);

    const { referrerFee, remainingAmount, referrerFeeDbps } =
      calculateReferrerFee(
        params.normalizedParams.amount,
        params.normalizedParams.referrerFeeDbps,
        request.destination.decimals
      );
    if (remainingAmount <= 0n) {
      throw new Error("Amount after fee <= 0");
    }

    const { destinationCapabilities } = await this.validateCapabilities(
      fromChain,
      toChain
    );

    const { recipient } = request;

    const gasDropOffLimit = BigInt(destinationCapabilities.gasDropOffLimit);
    const gasDropOff = this.calculateGasDropOff(gasDropOffLimit, params);

    const relayRequests = [];

    // Add the gas instruction
    relayRequests.push({
      request: {
        type: "GasInstruction" as const,
        gasLimit: params.normalizedParams.gasLimit,
        msgValue: 0n,
      },
    });

    // Add the gas drop-off instruction if applicable
    if (gasDropOff > 0n) {
      relayRequests.push({
        request: {
          type: "GasDropOffInstruction" as const,
          dropOff: gasDropOff,
          // If the recipient is undefined (e.g. the user hasn't connected their wallet yet),
          // we temporarily use a dummy address to fetch a quote.
          // The recipient address is validated later in the `initiate` method, which will throw if it's still missing.
          recipient: recipient
            ? recipient.address.toUniversalAddress()
            : new UniversalAddress(new Uint8Array(32)),
        },
      });
    }

    const relayInstructions = serializeLayout(relayInstructionsLayout, {
      requests: relayRequests,
    });

    const quote = await fetchSignedQuote(
      fromChain.network,
      fromChain.chain,
      toChain.chain,
      encoding.hex.encode(relayInstructions, true)
    );

    if (!quote.estimatedCost) {
      throw new Error("No estimated cost");
    }

    const estimatedCost = BigInt(quote.estimatedCost);
    const signedQuoteBytes = encoding.hex.decode(quote.signedQuote);
    const signedQuote = deserializeLayout(signedQuoteLayout, signedQuoteBytes);

    return {
      signedQuote: signedQuoteBytes,
      relayInstructions: relayInstructions,
      estimatedCost,
      payeeAddress: signedQuote.quote.payeeAddress,
      referrer,
      referrerFee,
      remainingAmount,
      referrerFeeDbps,
      expires: signedQuote.quote.expiryTime,
      gasDropOff,
    };
  }

  async fetchDeliveryPriceAndInstructions(
    fromChain: ChainContext<N>,
    toChain: ChainContext<N>,
    params: Vp
  ): Promise<{
    deliveryPrice: bigint;
    transceiverInstructions: Ntt.TransceiverInstruction[];
  }> {
    const sourceNtt = await fromChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: params.normalizedParams.sourceContracts,
    });

    const transceiverInstructions =
      await sourceNtt.createTransceiverInstructions(
        toChain.chain,
        params.normalizedParams.gasLimit
      );

    const deliveryPrice = await sourceNtt.quoteDeliveryPrice(
      toChain.chain,
      transceiverInstructions
    );

    return { deliveryPrice, transceiverInstructions };
  }

  async initiate(
    request: routes.RouteTransferRequest<N>,
    signer: Signer,
    quote: Q,
    to: ChainAddress
  ): Promise<R> {
    if (!quote.details) {
      throw new Error("Missing quote details");
    }

    const { details, params } = quote;

    const { fromChain } = request;

    const relayInstructions = deserializeLayout(
      relayInstructionsLayout,
      details.relayInstructions
    );

    // Make sure that the gas drop-off recipient matches the actual recipient
    relayInstructions.requests.forEach(({ request }) => {
      if (
        request.type === "GasDropOffInstruction" &&
        !request.recipient.equals(to.address.toUniversalAddress())
      ) {
        throw new Error("Gas drop-off recipient does not match");
      }
    });

    const sender = Wormhole.parseAddress(signer.chain(), signer.address());

    const multiTokenNttWithExecutor = await fromChain.getProtocol(
      "MultiTokenNttWithExecutor",
      {
        multiTokenNtt: params.normalizedParams.sourceContracts,
      }
    );

    const initTransfer = multiTokenNttWithExecutor.transfer(
      sender,
      to,
      request.source.id,
      amount.units(params.normalizedParams.amount),
      details
    );
    const txids = await signSendWait(fromChain, initTransfer, signer);

    // Status the transfer immediately before returning
    let statusAttempts = 0;

    const statusTransferImmediately = async () => {
      while (statusAttempts < 20) {
        try {
          const [txStatus] = await fetchStatus(
            fromChain.network,
            txids.at(-1)!.txid,
            fromChain.chain
          );

          if (txStatus) {
            break;
          }
        } catch (_) {
          // is ok we just try again!
        }
        statusAttempts++;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    };

    // Spawn a loop in the background that will status this transfer until
    // the API gives a successful response. We don't await the result
    // here because we don't need it for the return value.
    statusTransferImmediately();

    return {
      from: fromChain.chain,
      to: to.chain,
      state: TransferState.SourceInitiated,
      originTxs: txids,
      params,
      trackingInfo: { transceiverAttested: {} },
    };
  }

  // TODO: this is identical to the MultiTokenManualRoute version
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

    const { sendTransceivers } = receipt.params.normalizedParams;
    const wormhole = sendTransceivers.find(
      (t) => t.type.toLowerCase() === "wormhole"
    );
    if (!wormhole) {
      throw new Error(
        "No Wormhole transceiver found, cannot complete manual transfer"
      );
    }

    const wormholeAttested = await ntt.transceiverAttestedToMessage(
      receipt.from,
      receipt.attestation.attestation.payload.nttManagerPayload,
      wormhole.index
    );
    if (wormholeAttested) {
      // already attested by the wormhole transceiver
      return receipt;
    }

    const completeXfer = ntt.redeem(receipt.attestation.attestation);

    await signSendWait(toChain, completeXfer, signer);

    return receipt;
  }

  async resume(tx: TransactionId): Promise<R> {
    const fromChain = this.wh.getChain(tx.chain);
    const [msg] = await fromChain.parseTransaction(tx.txid);
    if (!msg) throw new Error("No Wormhole messages found");

    const vaa = await this.wh.getVaa(msg, "MultiTokenNtt:WormholeTransfer");
    if (!vaa) throw new Error("No VAA found for transaction: " + tx.txid);

    const { payload } = vaa.payload.nttManagerPayload;

    const sourceContracts = MultiTokenNttRoute.resolveContracts(
      this.staticConfig.contracts,
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
      this.staticConfig.contracts,
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
      this.staticConfig.contracts,
      originalTokenId
    );

    const sendTransceivers = await sourceNtt.getSendTransceivers(
      payload.toChain
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
      trackingInfo: { transceiverAttested: {} },
      params: {
        amount: amount.display(amt),
        normalizedParams: {
          amount: amt,
          sourceContracts,
          destinationContracts,
          sourceTokenId,
          destinationTokenId,
          originalTokenId,
          sendTransceivers,
          referrerFeeDbps: 0n,
          gasLimit: 0n,
        },
        options: {
          nativeGas: undefined,
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
    const destinationNtt = await toChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: receipt.params.normalizedParams.destinationContracts,
    });
    const completeTransfer = destinationNtt.completeInboundQueuedTransfer(
      vaa.payload.nttManagerPayload
    );
    const finalizeTxs = await signSendWait(toChain, completeTransfer, signer);
    return {
      ...receipt,
      state: TransferState.DestinationFinalized,
      destinationTxs: [...(receipt.destinationTxs ?? []), ...finalizeTxs],
    };
  }

  public override async *track(receipt: R, timeout?: number) {
    if (isSourceInitiated(receipt) || isSourceFinalized(receipt)) {
      const txid = receipt.originTxs.at(-1)!;

      // TODO: can pass txid when this is published: https://github.com/wormhole-foundation/wormhole-sdk-ts/pull/909
      const fromChain = this.wh.getChain(receipt.from);
      const [msg] = await fromChain.parseTransaction(txid.txid);
      if (!msg) throw new Error("No Wormhole messages found");

      const vaa = await this.wh.getVaa(
        msg,
        "MultiTokenNtt:WormholeTransfer",
        timeout
      );
      if (!vaa) throw new Error("No VAA found for transaction: " + txid.txid);

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
      };
      yield receipt;
    }

    const toChain = this.wh.getChain(receipt.to);
    const destinationNtt = await toChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: receipt.params.normalizedParams.destinationContracts,
    });

    // Check if the transfer was redeemed
    if (isAttested(receipt) || isFailed(receipt)) {
      if (!receipt.attestation) {
        throw new Error("No attestation found");
      }

      const vaa = receipt.attestation.attestation;

      if (await destinationNtt.getIsApproved(vaa)) {
        // All transceivers have approved the transfer
        receipt = {
          ...receipt,
          state: TransferState.DestinationInitiated,
          attestation: receipt.attestation,
        } satisfies RedeemedTransferReceipt<MultiTokenNttRoute.ManualAttestationReceipt>;
        yield receipt;
      } else {
        const { sendTransceivers } = receipt.params.normalizedParams;
        for (const transceiver of sendTransceivers) {
          const transceiverType = transceiver.type.toLowerCase();
          if (receipt.trackingInfo.transceiverAttested[transceiverType]) {
            continue;
          }

          const attested = await destinationNtt.transceiverAttestedToMessage(
            receipt.from,
            receipt.attestation!.attestation.payload.nttManagerPayload,
            transceiver.index
          );
          if (attested) {
            receipt.trackingInfo.transceiverAttested[transceiverType] = true;
            if (isFailed(receipt)) {
              // Reset the receipt status if the transceiver attested
              receipt = {
                ...receipt,
                attestation: receipt.attestation!,
                state: TransferState.Attested,
              } satisfies AttestedTransferReceipt<MultiTokenNttRoute.ManualAttestationReceipt>;
              yield receipt;
            }
            continue;
          }

          if (transceiverType === "wormhole") {
            receipt = await trackExecutor(this.wh.network, receipt);
          } else if (transceiverType === "axelar") {
            receipt = await trackAxelar(this.wh.network, receipt);
          } else {
            throw new Error(
              `Unsupported transceiver type: ${transceiver.type}`
            );
          }
          yield receipt;
          break;
        }
      }
    }

    if (isRedeemed(receipt) || isDestinationQueued(receipt)) {
      const vaa = receipt.attestation.attestation;

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
