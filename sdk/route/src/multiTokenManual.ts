import {
  Chain,
  ChainAddress,
  ChainContext,
  Network,
  Signer,
  TokenId,
  TransactionId,
  TransferState,
  Wormhole,
  amount,
  routes,
  signSendWait,
  finality,
  guardians,
  isNative,
} from "@wormhole-foundation/sdk-connect";
import "@wormhole-foundation/sdk-definitions-ntt";
import { MultiTokenNttRoute, NttRoute } from "./types.js";
import { MultiTokenNtt } from "@wormhole-foundation/sdk-definitions-ntt";

type Op = routes.Options;
type Tp = routes.TransferParams<Op>;
type Vr = routes.ValidationResult<Op>;

type Vp = MultiTokenNttRoute.ValidatedParams;
type QR = routes.QuoteResult<Op, Vp>;
type Q = routes.Quote<Op, Vp>;

type R = MultiTokenNttRoute.TransferReceipt;

export function multiTokenNttManualRoute(config: MultiTokenNttRoute.Config) {
  class MultiTokenNttRouteImpl<
    N extends Network,
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
    return {};
  }

  async isWrappedToken(token: TokenId): Promise<boolean> {
    return await MultiTokenNttRoute.isWrappedToken(
      this.wh.getChain(token.chain),
      token,
      this.staticConfig.contracts
    );
  }

  async getOriginalToken(token: TokenId): Promise<TokenId> {
    return await MultiTokenNttRoute.getOriginalToken(
      this.wh.getChain(token.chain),
      token,
      this.staticConfig.contracts
    );
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

    const gasLimit = await this.estimateGasLimit(request, originalTokenId);

    const validatedParams: Vp = {
      amount: params.amount,
      normalizedParams: {
        amount: trimmedAmount,
        sourceContracts,
        destinationContracts,
        sourceTokenId: request.source.id,
        destinationTokenId: request.destination.id,
        originalTokenId,
        sendTransceivers,
        gasLimit,
      },
      options,
    };

    return { valid: true, params: validatedParams };
  }

  async estimateGasLimit(
    request: routes.RouteTransferRequest<N>,
    originalTokenId: MultiTokenNtt.OriginalTokenId
  ): Promise<bigint> {
    return MultiTokenNttRoute.estimateGasLimit(
      request,
      originalTokenId,
      this.staticConfig.contracts,
      this.staticConfig.perTokenOverrides
    );
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
    const warnings = await MultiTokenNttRoute.checkRateLimit(
      destinationNtt,
      fromChain.chain,
      params.normalizedParams.originalTokenId,
      dstAmount,
      duration
    );
    if (warnings) {
      result.warnings = warnings;
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
      to,
      params.normalizedParams.gasLimit,
      this.staticConfig.axelarGasMultiplier
    );
    const txids = await signSendWait(fromChain, initXfer, signer);

    return {
      from: fromChain.chain,
      to: to.chain,
      state: TransferState.SourceInitiated,
      originTxs: txids,
      params,
      trackingInfo: { transceiverAttested: {} },
    };
  }

  async complete(signer: Signer, receipt: R): Promise<R> {
    return await MultiTokenNttRoute.complete<N, R>(
      signer,
      this.wh.getChain(receipt.to),
      receipt
    );
  }

  async resume(tx: TransactionId): Promise<R> {
    return await MultiTokenNttRoute.resume<N, R>(
      tx,
      this.wh,
      this.staticConfig.contracts
    );
  }

  async finalize(signer: Signer, receipt: R): Promise<R> {
    return await MultiTokenNttRoute.finalize<N, R>(
      signer,
      this.wh.getChain(receipt.to),
      receipt
    );
  }

  async *track(receipt: R, timeout?: number) {
    return yield* MultiTokenNttRoute.track<N, R>(
      this.wh,
      receipt,
      true,
      timeout
    );
  }
}
