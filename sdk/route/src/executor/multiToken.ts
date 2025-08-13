import {
  AttestedTransferReceipt,
  Chain,
  ChainAddress,
  ChainContext,
  CompletedTransferReceipt,
  DestinationQueuedTransferReceipt,
  Network,
  Platform,
  RedeemedTransferReceipt,
  Signer,
  TokenId,
  TransactionId,
  TransferState,
  TransferReceipt as _TransferReceipt,
  UnattestedTokenId,
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
  // isUnattestedTokenId,
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
} from "@wormhole-foundation/sdk-connect";
import "@wormhole-foundation/sdk-definitions-ntt";
import { MultiTokenNttRoute, NttRoute } from "../types.js";
import {
  MultiTokenNtt,
  NttWithExecutor,
} from "@wormhole-foundation/sdk-definitions-ntt";
import {
  calculateReferrerFee,
  fetchCapabilities,
  fetchSignedQuote,
  fetchStatus,
  RelayStatus,
} from "./utils.js";
import { getDefaultReferrerAddress } from "./consts.js";

// TODO: this is very similar to NttExecutorRoute, consider refactoring
// the only difference should be the Config.ntt type
export namespace MultiTokenNttExecutorRoute {
  export type Config = {
    ntt: MultiTokenNttRoute.Config;
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
            // Some tokens may require more msgValue than the default.
            msgValue?: bigint;
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
    sourceContracts: MultiTokenNtt.Contracts;
    destinationContracts: MultiTokenNtt.Contracts;
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
  };
}

type Op = MultiTokenNttExecutorRoute.Options;
type Tp = routes.TransferParams<Op>;
type Vr = routes.ValidationResult<Op>;

type Vp = MultiTokenNttExecutorRoute.ValidatedParams;

// TODO: why are we importing from NttWithExecutor? maybe we need to move that Quote type to a common place?
type Q = routes.Quote<Op, Vp, NttWithExecutor.Quote>;
type QR = routes.QuoteResult<Op, Vp>;

type R = MultiTokenNttExecutorRoute.TransferReceipt;

export function multiTokenNttExecutorRoute(config: MultiTokenNttRoute.Config) {
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
  // executor supports gas drop-off
  static NATIVE_GAS_DROPOFF_SUPPORTED: boolean = true;

  //// Standard Relayer gas limits for transfers
  //// The gas limit can vary depending on the complexity of the token contract and the specific EVM chain.
  //// This limit should cover the majority of tokens, including those with additional logic
  //// such as hooks or complex state changes.
  //static SR_GAS_LIMIT: bigint = 375_000n;
  //// More gas is needed to create a token if it doesn't exist on the destination chain yet (unattested).
  //static SR_GAS_LIMIT_CREATE_TOKEN: bigint = 1_250_000n;

  // @ts-ignore
  // Since we set the config on the static class, access it with this param
  // the MultiTokenNttExecutorRoute.config will always be empty
  readonly staticConfig = this.constructor.config;
  static config: MultiTokenNttRoute.Config = { contracts: [] };

  static meta = { name: "MultiTokenNttExecutorRoute" };

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
    return {
      nativeGas: 0,
    };
  }

  // TODO: this validate method is identical (?) to the one in NttExecutorRoute
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

    // IMPORTANT: The EVM NttManager will revert if there is dust.
    // but we want to be consistent across chains.
    const trimmedAmount = NttRoute.trimAmount(
      parsedAmount,
      request.destination.decimals
    );

    const sourceContracts = MultiTokenNttRoute.resolveContracts(
      this.staticConfig,
      request.fromChain.chain
    );
    const destinationContracts = MultiTokenNttRoute.resolveContracts(
      this.staticConfig,
      request.toChain.chain
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
        sourceContracts,
        destinationContracts,
        referrerFeeDbps,
      },
      options,
    };

    return { valid: true, params: validatedParams };
  }

  // TODO: need to add this to the estimateMsgValueAndGasLimit method
  //async getStandardRelayerGasLimit(
  //  request: routes.RouteTransferRequest<N>
  //): Promise<bigint> {
  //  const fromNtt = await request.fromChain.getProtocol("MultiTokenNtt", {
  //    multiTokenNtt: MultiTokenNttRoute.resolveContracts(
  //      this.staticConfig,
  //      request.fromChain.chain
  //    ),
  //  });

  //  const sourceToken = isNative(request.source.id.address)
  //    ? await fromNtt.getWrappedNativeToken()
  //    : request.source.id;

  //  const originalToken = await fromNtt.getOriginalToken(sourceToken);

  //  const destinationToken = await getDestinationTokenId(
  //    sourceToken,
  //    request.fromChain,
  //    request.toChain,
  //    this.staticConfig,
  //    originalToken
  //  );

  //  // More gas is needed to create the token on the destination chain
  //  const gasLimit = isUnattestedTokenId(destinationToken)
  //    ? MultiTokenNttExecutorRoute.SR_GAS_LIMIT_CREATE_TOKEN
  //    : MultiTokenNttExecutorRoute.SR_GAS_LIMIT;

  //  return gasLimit;
  //}

  /*
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
      expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };

    const toNtt = await toChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: params.normalizedParams.destinationContracts,
    });

    const duration = await toNtt.getRateLimitDuration();

    if (duration > 0n) {
      const sourceToken = isNative(request.source.id.address)
        ? await fromNtt.getWrappedNativeToken()
        : request.source.id;

      const originalToken = await fromNtt.getOriginalToken(sourceToken);

      const inboundLimit = await toNtt.getInboundLimit(
        originalToken,
        fromChain.chain
      );

      if (inboundLimit !== null) {
        const capacity = await toNtt.getCurrentInboundCapacity(
          originalToken,
          fromChain.chain
        );

        const dstAmount = amount.parse(
          params.amount,
          request.destination.decimals
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
  */

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

      const dstNtt = await toChain.getProtocol("MultiTokenNtt", {
        multiTokenNtt: params.normalizedParams.destinationContracts,
      });

      const duration = await dstNtt.getRateLimitDuration();

      if (duration > 0n) {
        const fromNtt = await fromChain.getProtocol("MultiTokenNtt", {
          multiTokenNtt: params.normalizedParams.sourceContracts,
        });

        const sourceToken = isNative(request.source.id.address)
          ? await fromNtt.getWrappedNativeToken()
          : request.source.id;

        const originalToken = await fromNtt.getOriginalToken(sourceToken);

        const inboundLimit = await dstNtt.getInboundLimit(
          originalToken,
          fromChain.chain
        );

        if (inboundLimit !== null) {
          const capacity = await dstNtt.getCurrentInboundCapacity(
            originalToken,
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
      }

      return result;
    } catch (e: unknown) {
      return {
        success: false,
        error: e instanceof Error ? e : new Error(String(e)),
      };
    }
  }

  // TODO: this is nearly identical (besides the request prefix)
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
      if (override?.msgValue !== undefined) {
        msgValue = override.msgValue;
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
    //const { params } = quote;
    //const { fromChain } = request;
    //const sender = Wormhole.parseAddress(signer.chain(), signer.address());

    //const ntt = await fromChain.getProtocol("MultiTokenNtt", {
    //  multiTokenNtt: params.normalizedParams.sourceContracts,
    //});

    //const initXfer = ntt.transfer(
    //  sender,
    //  request.source.id.address,
    //  amount.units(params.normalizedParams.amount),
    //  to,
    //  params.normalizedParams.options
    //);
    //const txids = await signSendWait(fromChain, initXfer, signer);

    //return {
    //  from: fromChain.chain,
    //  to: to.chain,
    //  state: TransferState.SourceInitiated,
    //  originTxs: txids,
    //  params,
    //};
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

    const nttWithExec = await fromChain.getProtocol(
      "MultiTokenNttWithExecutor",
      {
        ntt: params.normalizedParams.sourceContracts,
      }
    );

    //const ntt = await fromChain.getProtocol("Ntt", {
    //  ntt: params.normalizedParams.sourceContracts,
    //});

    //const wrapNative = isNative(request.source.id.address);

    const initXfer = nttWithExec.transfer(
      sender,
      to,
      request.source.id,
      amount.units(params.normalizedParams.amount),
      details
      // ntt,
      // wrapNative
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

  async resume(tx: TransactionId): Promise<R> {
    /*
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

    const originalTokenId: MultiTokenNtt.OriginalTokenId = {
      chain: payload.data.token.token.chainId,
      address: payload.data.token.token.tokenAddress,
    };

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
    */
    throw new Error("not implemented");
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

  /*
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
  */

  public override async *track(receipt: R, timeout?: number) {
    // First we fetch the attestation (VAA) for the transfer
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

    const toChain = this.wh.getChain(receipt.to);
    const multiTokenNtt = await toChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: receipt.params.normalizedParams.destinationContracts,
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

      if (await multiTokenNtt.getIsApproved(vaa)) {
        receipt = {
          ...receipt,
          state: TransferState.DestinationInitiated,
          attestation: receipt.attestation,
          // TODO: check for destination event transactions to get dest Txids
        } satisfies RedeemedTransferReceipt<MultiTokenNttRoute.ManualAttestationReceipt>;
        yield receipt;
      }
    }

    if (isRedeemed(receipt) || isDestinationQueued(receipt)) {
      const {
        attestation: { attestation: vaa },
      } = receipt;

      const queuedTransfer = await multiTokenNtt.getInboundQueuedTransfer(
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
        } satisfies DestinationQueuedTransferReceipt<MultiTokenNttRoute.ManualAttestationReceipt>;
        yield receipt;
      } else if (await multiTokenNtt.getIsExecuted(vaa)) {
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

// Helper function to get the destination TokenId
async function getDestinationTokenId<N extends Network>(
  sourceToken: TokenId,
  fromChain: ChainContext<N>,
  toChain: ChainContext<N>,
  config: MultiTokenNttRoute.Config,
  originalToken?: MultiTokenNtt.OriginalTokenId
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
