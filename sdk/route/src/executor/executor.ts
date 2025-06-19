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
  TransferReceipt as _TransferReceipt,
  TransferState,
  UniversalAddress,
  Wormhole,
  WormholeMessageId,
  amount,
  canonicalAddress,
  deserializeLayout,
  encoding,
  finality,
  guardians,
  isAttested,
  isDestinationQueued,
  isFailed,
  isRedeemed,
  isSourceFinalized,
  isSourceInitiated,
  nativeTokenId,
  routes,
  serializeLayout,
  signSendWait,
  toChainId,
  Platform,
  chainToPlatform,
} from "@wormhole-foundation/sdk-connect";
import "@wormhole-foundation/sdk-definitions-ntt";
import { NttRoute } from "../types.js";
import {
  calculateReferrerFee,
  fetchCapabilities,
  fetchSignedQuote,
  fetchStatus,
  RelayStatus,
} from "./utils.js";
import { Ntt, NttWithExecutor } from "@wormhole-foundation/sdk-definitions-ntt";
import {
  isNative,
  relayInstructionsLayout,
  signedQuoteLayout,
} from "@wormhole-foundation/sdk-definitions";
import { getDefaultReferrerAddress } from "./consts.js";

export namespace NttExecutorRoute {
  export type Config = {
    ntt: NttRoute.Config;
    referrerFee?: ReferrerFeeConfig;
  };

  export type ReferrerFeeConfig = {
    // Referrer Fee in *tenths* of basis points - e.g. 10 = 1 basis point (0.01%)
    feeDbps: bigint;
    // The address to which the referrer fee will be sent
    referrerAddresses?: Partial<Record<Platform, string>>;
    perTokenOverrides?: Partial<
      Record<
        Chain,
        Record<
          string,
          {
            referrerFeeDbps?: bigint;
            // Some tokens may require more gas to redeem than the default.
            gasLimit?: bigint;
          }
        >
      >
    >;
  };

  export type Options = {
    // 0.0 - 1.0 percentage of the maximum gas drop-off amount
    nativeGas?: number;
  };

  export type NormalizedParams = {
    amount: amount.Amount;
    sourceContracts: Ntt.Contracts;
    destinationContracts: Ntt.Contracts;
    referrerFeeDbps: bigint;
  };

  export interface ValidatedParams
    extends routes.ValidatedTransferParams<Options> {
    normalizedParams: NormalizedParams;
  }

  export type TransferReceipt<
    SC extends Chain = Chain,
    DC extends Chain = Chain
  > = _TransferReceipt<NttRoute.ManualAttestationReceipt, SC, DC> & {
    params: ValidatedParams;
  };
}

type Op = NttExecutorRoute.Options;
type Tp = routes.TransferParams<Op>;
type Vr = routes.ValidationResult<Op>;

type Vp = NttExecutorRoute.ValidatedParams;

type Q = routes.Quote<Op, Vp, NttWithExecutor.Quote>;
type QR = routes.QuoteResult<Op, Vp>;

type R = NttExecutorRoute.TransferReceipt;

export function nttExecutorRoute(config: NttExecutorRoute.Config) {
  class NttExecutorRouteImpl<N extends Network> extends NttExecutorRoute<N> {
    static override config = config;
  }
  return NttExecutorRouteImpl;
}

export class NttExecutorRoute<N extends Network>
  extends routes.AutomaticRoute<N, Op, Vp, R>
  implements routes.StaticRouteMethods<typeof NttExecutorRoute>
{
  // executor supports gas drop-off
  static NATIVE_GAS_DROPOFF_SUPPORTED: boolean = true;

  // @ts-ignore
  // Since we set the config on the static class, access it with this param
  // the NttExecutorRoute.config will always be empty
  readonly staticConfig: NttExecutorRoute.Config = this.constructor.config;
  static config: NttExecutorRoute.Config = { ntt: { tokens: {} } };

  static meta = { name: "NttExecutorRoute" };

  static supportedNetworks(): Network[] {
    return NttRoute.resolveSupportedNetworks(this.config.ntt);
  }

  static supportedChains(network: Network): Chain[] {
    return NttRoute.resolveSupportedChains(this.config.ntt, network);
  }

  static async supportedSourceTokens(
    fromChain: ChainContext<Network>
  ): Promise<TokenId[]> {
    return NttRoute.resolveSourceTokens(this.config.ntt, fromChain);
  }

  static async supportedDestinationTokens<N extends Network>(
    sourceToken: TokenId,
    fromChain: ChainContext<N>,
    toChain: ChainContext<N>
  ): Promise<TokenId[]> {
    return NttRoute.resolveDestinationTokens(
      this.config.ntt,
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
    return {
      nativeGas: 0,
    };
  }

  async validate(
    request: routes.RouteTransferRequest<N>,
    params: Tp
  ): Promise<Vr> {
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

    // IMPORTANT: The EVM NttManager will revert if there is dust. This is not the case for Solana,
    // but we want to be consistent across chains.
    const trimmedAmount = NttRoute.trimAmount(
      parsedAmount,
      request.destination.decimals
    );

    const { srcContracts, dstContracts } = NttRoute.resolveNttContracts(
      this.staticConfig.ntt,
      request.source.id,
      request.destination.id
    );

    let referrerFeeDbps = 0n;
    if (this.staticConfig.referrerFee) {
      referrerFeeDbps = this.staticConfig.referrerFee.feeDbps;
      if (this.staticConfig.referrerFee.perTokenOverrides) {
        const srcTokenAddress = canonicalAddress(request.source.id);
        const override =
          this.staticConfig.referrerFee.perTokenOverrides[
            request.source.id.chain
          ]?.[srcTokenAddress];
        if (override?.referrerFeeDbps !== undefined) {
          referrerFeeDbps = override.referrerFeeDbps;
        }
      }
    }

    const validatedParams: Vp = {
      amount: params.amount,
      normalizedParams: {
        amount: trimmedAmount,
        sourceContracts: srcContracts,
        destinationContracts: dstContracts,
        referrerFeeDbps,
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
            estimatedCost,
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
        details: executorQuote,
      };

      const dstNtt = await toChain.getProtocol("Ntt", {
        ntt: params.normalizedParams.destinationContracts,
      });

      const duration = await dstNtt.getRateLimitDuration();
      if (duration > 0n) {
        const capacity = await dstNtt.getCurrentInboundCapacity(
          fromChain.chain
        );
        if (
          NttRoute.isCapacityThresholdExceeded(
            amount.units(receivedAmount),
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

      return result;
    } catch (e: unknown) {
      return {
        success: false,
        error: e instanceof Error ? e : new Error(String(e)),
      };
    }
  }

  async fetchExecutorQuote(
    request: routes.RouteTransferRequest<N>,
    params: Vp
  ): Promise<NttWithExecutor.Quote> {
    const { fromChain, toChain } = request;

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

    const { referrerFee, remainingAmount, referrerFeeDbps } =
      calculateReferrerFee(
        params.normalizedParams.amount,
        params.normalizedParams.referrerFeeDbps,
        request.destination.decimals
      );
    if (remainingAmount <= 0n) {
      throw new Error("Amount after fee <= 0");
    }

    const capabilities = await fetchCapabilities(fromChain.network);
    const srcCapabilities = capabilities[toChainId(fromChain.chain)];
    if (!srcCapabilities) {
      throw new Error("Unsupported source chain");
    }

    const dstCapabilities = capabilities[toChainId(toChain.chain)];
    if (!dstCapabilities || !dstCapabilities.requestPrefixes.includes("ERN1")) {
      throw new Error("Unsupported destination chain");
    }

    const { recipient } = request;

    const dstNttWithExec = await toChain.getProtocol("NttWithExecutor", {
      ntt: params.normalizedParams.destinationContracts,
    });

    // Calculate the gas dropOff value
    const gasDropOffLimit = BigInt(dstCapabilities.gasDropOffLimit);
    const dropOff =
      params.options.nativeGas && gasDropOffLimit > 0n
        ? (BigInt(Math.round(params.options.nativeGas * 100)) *
            gasDropOffLimit) /
          100n
        : 0n;

    let { msgValue, gasLimit } =
      await dstNttWithExec.estimateMsgValueAndGasLimit(recipient);

    // Check for overrides in the config.
    if (this.staticConfig.referrerFee?.perTokenOverrides) {
      const dstTokenAddress = canonicalAddress(request.destination.id);
      const override =
        this.staticConfig.referrerFee.perTokenOverrides[
          request.destination.id.chain
        ]?.[dstTokenAddress];
      if (override?.gasLimit !== undefined) {
        gasLimit = override.gasLimit;
      }
    }

    const relayRequests = [];

    // Add the gas instruction
    relayRequests.push({
      request: {
        type: "GasInstruction" as const,
        gasLimit,
        msgValue,
      },
    });

    // Add the gas drop-off instruction if applicable
    if (dropOff > 0n) {
      relayRequests.push({
        request: {
          type: "GasDropOffInstruction" as const,
          dropOff,
          // If the recipient is undefined (e.g. the user hasn’t connected their wallet yet),
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
      gasDropOff: dropOff,
    };
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

    const { params, details } = quote;

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

    const { fromChain } = request;
    const sender = Wormhole.parseAddress(signer.chain(), signer.address());

    const nttWithExec = await fromChain.getProtocol("NttWithExecutor", {
      ntt: params.normalizedParams.sourceContracts,
    });

    const ntt = await fromChain.getProtocol("Ntt", {
      ntt: params.normalizedParams.sourceContracts,
    });

    const wrapNative = isNative(request.source.id.address);

    const initXfer = nttWithExec.transfer(
      sender,
      to,
      amount.units(params.normalizedParams.amount),
      details,
      ntt,
      wrapNative
    );
    const txids = await signSendWait(fromChain, initXfer, signer);

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
      throw new Error("No attestation found for the transfer");
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
      attestation: receipt.attestation,
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
      this.staticConfig.ntt,
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
        options: {},
        normalizedParams: {
          amount: amt,
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
          referrerFeeDbps: 0n,
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
    // First we fetch the attestation (VAA) for the transfer
    if (isSourceInitiated(receipt) || isSourceFinalized(receipt)) {
      const { txid } = receipt.originTxs.at(-1)!;
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

    // Check if the relay was successful or failed
    if (isAttested(receipt) && !isFailed(receipt)) {
      const [txStatus] = await fetchStatus(
        this.wh.network,
        receipt.originTxs.at(-1)!.txid,
        receipt.from
      );
      if (!txStatus) throw new Error("No transaction status found");

      const relayStatus = txStatus.status;
      if (
        relayStatus === RelayStatus.Failed || // this could happen if simulation fails
        relayStatus === RelayStatus.Underpaid || // only happens if you don't pay at least the costEstimate
        relayStatus === RelayStatus.Unsupported || // capabilities check didn't pass
        relayStatus === RelayStatus.Aborted // An unrecoverable error indicating the attempt should stop (bad data, pre-flight checks failed, or chain-specific conditions)
      ) {
        receipt = {
          ...receipt,
          state: TransferState.Failed,
          error: new routes.RelayFailedError(
            `Relay failed with status: ${relayStatus}`
          ),
        };
        yield receipt;
      }
    }

    // Check if the transfer was redeemed
    if (isAttested(receipt) || isFailed(receipt)) {
      if (!receipt.attestation) {
        throw new Error("No attestation found");
      }

      const {
        attestation: { attestation: vaa },
      } = receipt;

      if (await ntt.getIsApproved(vaa)) {
        receipt = {
          ...receipt,
          state: TransferState.DestinationInitiated,
          attestation: receipt.attestation,
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
