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
  isNative,
  isRedeemed,
  isSourceFinalized,
  isSourceInitiated,
  nativeTokenId,
  routes,
  serializeLayout,
  signSendWait,
  toChainId,
} from "@wormhole-foundation/sdk-connect";
import "@wormhole-foundation/sdk-definitions-ntt";
import { NttRoute } from "../types.js";
import { gasLimits, referrers } from "./consts.js";
import {
  calculateReferrerFee,
  fetchCapabilities,
  fetchSignedQuote,
} from "./utils.js";
import { relayInstructionsLayout } from "./layouts/relayInstruction.js";
import { signedQuoteLayout } from "./layouts/signedQuote.js";

export namespace NttExecutorRoute {
  // TODO: might not need all this
  export type ExecutorQuote = {
    signedQuote: Uint8Array; // The signed quote from the /v0/quote endpoint
    relayInstructions: Uint8Array; // The relay instructions for the transfer
    estimatedCost: bigint; // The estimated cost of the transfer
    referrer: ChainAddress; // The referrer address (to whom the referrer fee should be paid)
    referrerFee: bigint; // The referrer fee in USDC
    remainingAmount: bigint; // The remaining amount after the referrer fee in USDC
    referrerFeeDbps: bigint; // The referrer fee in *tenths* of basis points
    expires: Date; // The expiry time of the quote
    gasDropOff: bigint; // The gas drop-off amount in native token units
  };
}

type Op = NttRoute.Options;
type Tp = routes.TransferParams<Op>;
type Vr = routes.ValidationResult<Op>;

type Vp = NttRoute.ValidatedParams;

type Q = routes.Quote<Op, Vp, NttExecutorRoute.ExecutorQuote>;
type QR = routes.QuoteResult<Op, Vp>;

type R = NttRoute.ManualTransferReceipt;

export function nttExecutorRoute(config: NttRoute.Config) {
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
  readonly staticConfig = this.constructor.config;
  static config: NttRoute.Config = { tokens: {} };

  static meta = { name: "NttExecutorRoute" };

  static supportedNetworks(): Network[] {
    return NttRoute.resolveSupportedNetworks(this.config);
  }

  static supportedChains(network: Network): Chain[] {
    return NttRoute.resolveSupportedChains(this.config, network);
  }

  // TODO: support all tokens by default, but fetching a quote might fail (e.g. chain not supported)?

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
    // TODO: relayType
    return { automatic: true, nativeGas: 0 };
  }

  //async isAvailable(request: routes.RouteTransferRequest<N>): Promise<boolean> {
  //  const { srcContracts } = NttRoute.resolveNttContracts(
  //    this.staticConfig,
  //    request.source.id,
  //    request.destination.id
  //  );

  //  const ntt = await request.fromChain.getProtocol("Ntt", {
  //    ntt: srcContracts,
  //  });

  //  return ntt.isRelayingAvailable(request.toChain.chain);
  //}

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

    const wrapNative = isNative(request.source.id.address);

    const parsedAmount = amount.parse(params.amount, request.source.decimals);
    // The trimmedAmount may differ from the parsedAmount if the parsedAmount includes dust
    const trimmedAmount = NttRoute.trimAmount(
      parsedAmount,
      request.destination.decimals
    );

    const { srcContracts, dstContracts } = NttRoute.resolveNttContracts(
      this.staticConfig,
      request.source.id,
      request.destination.id
    );

    const validatedParams: Vp = {
      amount: params.amount,
      normalizedParams: {
        amount: trimmedAmount,
        sourceContracts: srcContracts,
        destinationContracts: dstContracts,
        options: {
          queue: false,
          automatic: true,
          //gasDropoff: amount.units(gasDropoff),
          wrapNative,
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
    const { fromChain, toChain } = request;

    try {
      const executorQuote = await this.fetchExecutorQuote(request, params);

      const { remainingAmount, estimatedCost, gasDropOff, expires } =
        executorQuote;

      const receivedAmount = amount.scale(
        // params.normalizedParams.amount,
        // TODO: is this scaling correct?
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
  ): Promise<NttExecutorRoute.ExecutorQuote> {
    const { fromChain, toChain } = request;

    const referrerAddress = referrers[fromChain.network]?.[fromChain.chain];
    if (!referrerAddress) {
      throw new Error("No referrer address found");
    }
    const referrer = Wormhole.chainAddress(fromChain.chain, referrerAddress);

    const { referrerFee, remainingAmount, referrerFeeDbps } =
      calculateReferrerFee(
        amount.units(params.normalizedParams.amount),
        this.staticConfig.referrerFeeDbps,
        this.staticConfig.referrerFeeThreshold
      );
    if (remainingAmount <= 0n) {
      throw new Error("Amount after fee <= 0");
    }

    const gasLimit = gasLimits[toChain.network]?.[toChain.chain];
    if (!gasLimit) {
      throw new Error("Gas limit not found");
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
    let tokenAccountExists = true;

    //// Check if the associated token account (ATA) exists on Solana.
    //// If it doesn't, include a gas drop-off instruction so the relayer can create it.
    //// Note: There's a potential race condition — the account might exist during this check,
    //// but could be closed before the transfer completes.
    //if (recipient && toChain.chain === "Solana") {
    //  const usdcAddress = Wormhole.parseAddress("Solana", dstUsdcAddress);
    //  const ata = await toChain.getTokenAccount(recipient.address, usdcAddress);
    //  const connection: Connection = await toChain.getRpc();
    //  const ataAccount = await connection.getAccountInfo(
    //    new SolanaAddress(ata.address).unwrap()
    //  );
    //  tokenAccountExists = ataAccount !== null;
    //  if (!tokenAccountExists && !ataMinRentAmount) {
    //    ataMinRentAmount = BigInt(
    //      await connection.getMinimumBalanceForRentExemption(165)
    //    );
    //  }
    //}

    let msgValue = 0n;
    //if (toChain.chain === "Solana") {
    //  msgValue += SOLANA_MSG_VALUE_BASE_FEE;
    //  if (!tokenAccountExists && ataMinRentAmount) {
    //    msgValue += ataMinRentAmount;
    //  }
    //}

    const relayRequests = [];

    // Add the gas instruction
    relayRequests.push({
      request: {
        type: "GasInstruction" as const,
        gasLimit,
        msgValue,
      },
    });

    // Calculate the gas dropOff value
    // const gasDropOffLimit = BigInt(dstCapabilities.gasDropOffLimit);
    const dropOff = 0n;
    //const dropOff =
    //  params.options.nativeGas && gasDropOffLimit > 0n
    //    ? (BigInt(Math.round(params.options.nativeGas * 100)) *
    //        gasDropOffLimit) /
    //      100n
    //    : 0n;

    // Add the gas drop-off instruction if applicable
    if (dropOff > 0n || !tokenAccountExists) {
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

    const signedQuoteBytes = encoding.hex.decode(quote.signedQuote);
    const signedQuote = deserializeLayout(signedQuoteLayout, signedQuoteBytes);

    const estimatedCost = BigInt(quote.estimatedCost);

    return {
      signedQuote: signedQuoteBytes,
      relayInstructions: relayInstructions,
      estimatedCost,
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
