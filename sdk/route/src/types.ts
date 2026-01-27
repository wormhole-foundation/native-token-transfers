import {
  Chain,
  ChainAddress,
  ChainContext,
  Network,
  QuoteWarning,
  Signer,
  TokenId,
  TransactionId,
  TransferState,
  UnattestedTokenId,
  VAA,
  Wormhole,
  WormholeMessageId,
  TransferReceipt as _TransferReceipt,
  amount,
  canonicalAddress,
  isAttested,
  isCompleted,
  isDestinationQueued,
  isFailed,
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
import { MultiTokenNtt, Ntt } from "@wormhole-foundation/sdk-definitions-ntt";
import { trackAxelar, trackExecutor } from "./tracking.js";

export namespace NttRoute {
  // Currently only wormhole attestations supported
  export type TransceiverType = "wormhole";

  export const TRIMMED_DECIMALS = 8;

  export type TransceiverConfig = {
    type: TransceiverType;
    address: string;
  };

  export type TokenConfig = {
    chain: Chain;
    token: string;
    manager: string;
    transceiver: TransceiverConfig[];
    quoter?: string;
    isWrappedGasToken?: boolean;
    unwrapsOnRedeem?: boolean;
    svmShims?: {
      postMessageShimOverride?: string;
      verifyVaaShimOverride?: string;
    };
    /** Estimated time of arrival in milliseconds. When specified, this value is used in quotes instead of the dynamic calculation. */
    eta?: number;
  };

  export type Config = {
    // Token Name => Config
    tokens: Record<string, TokenConfig[]>;
  };

  /** Options for Per-TransferRequest settings */
  export interface Options {
    automatic: boolean;
  }

  export const ManualOptions: Options = {
    automatic: false,
  };

  export const AutomaticOptions: Options = {
    automatic: true,
  };

  export type NormalizedParams = {
    amount: amount.Amount;
    options: Ntt.TransferOptions;
    sourceContracts: Ntt.Contracts;
    destinationContracts: Ntt.Contracts;
  };

  export interface ValidatedParams
    extends routes.ValidatedTransferParams<Options> {
    normalizedParams: NormalizedParams;
  }

  export type ManualAttestationReceipt = {
    id: WormholeMessageId;
    attestation: VAA<"Ntt:WormholeTransfer">;
  };

  export type AutomaticAttestationReceipt = {
    id: WormholeMessageId;
    attestation:
      | VAA<"Ntt:WormholeTransfer">
      | VAA<"Ntt:WormholeTransferStandardRelayer">;
  };

  export type ManualTransferReceipt<
    SC extends Chain = Chain,
    DC extends Chain = Chain,
  > = _TransferReceipt<ManualAttestationReceipt, SC, DC> & {
    params: ValidatedParams;
  };

  export type AutomaticTransferReceipt<
    SC extends Chain = Chain,
    DC extends Chain = Chain,
  > = _TransferReceipt<AutomaticAttestationReceipt, SC, DC> & {
    params: ValidatedParams;
  };

  export function resolveSupportedNetworks(config: Config): Network[] {
    return ["Mainnet", "Testnet"];
  }

  export function resolveSupportedChains(
    config: Config,
    network: Network
  ): Chain[] {
    const configs = Object.values(config.tokens);
    return configs.flatMap((cfg) => cfg.map((chainCfg) => chainCfg.chain));
  }

  export function resolveSourceTokens(
    config: Config,
    fromChain: ChainContext<Network>
  ): TokenId[] {
    const srcTokens = Object.entries(config.tokens).reduce<TokenId[]>(
      (acc, [, configs]) => {
        const tokenConf = configs.find(
          (config) => config.chain === fromChain.chain
        );
        if (tokenConf) {
          acc.push(Wormhole.tokenId(fromChain.chain, tokenConf.token));

          if (tokenConf.isWrappedGasToken) {
            acc.push(nativeTokenId(fromChain.chain));
          }
        }
        return acc;
      },
      []
    );

    // TODO: dedupe?  //return routes.uniqueTokens(srcTokens);
    return srcTokens;
  }

  export function resolveDestinationTokens(
    config: Config,
    sourceToken: TokenId,
    fromChain: ChainContext<Network>,
    toChain: ChainContext<Network>
  ) {
    return Object.entries(config.tokens)
      .map(([, configs]) => {
        const match = configs.find(
          (config) =>
            config.chain === fromChain.chain &&
            (config.token.toLowerCase() ===
              canonicalAddress(sourceToken).toLowerCase() ||
              (isNative(sourceToken.address) && config.isWrappedGasToken))
        );
        if (!match) return;

        const remote = configs.find((config) => config.chain === toChain.chain);
        if (!remote) return;

        if (remote.unwrapsOnRedeem || remote.isWrappedGasToken) {
          return nativeTokenId(toChain.chain);
        } else {
          return Wormhole.tokenId(toChain.chain, remote.token);
        }
      })
      .filter((x) => !!x) as TokenId[];
  }

  export function resolveNttContracts(
    config: Config,
    srcToken: TokenId,
    dstToken: TokenId
  ): { srcContracts: Ntt.Contracts; dstContracts: Ntt.Contracts } {
    const cfg = Object.values(config.tokens);
    const srcAddress = canonicalAddress(srcToken);
    const dstAddress = canonicalAddress(dstToken);

    for (const tokens of cfg) {
      const srcFound = tokens.find(
        (tc) =>
          tc.chain === srcToken.chain &&
          (tc.token.toLowerCase() === srcAddress.toLowerCase() ||
            (isNative(srcToken.address) && tc.isWrappedGasToken))
      );

      if (srcFound) {
        const dstFound = tokens.find(
          (tc) =>
            tc.chain === dstToken.chain &&
            (tc.token.toLowerCase() === dstAddress.toLowerCase() ||
              (isNative(dstToken.address) && tc.isWrappedGasToken))
        );

        if (dstFound) {
          return {
            srcContracts: {
              token: srcFound.token,
              manager: srcFound.manager,
              transceiver: {
                wormhole: srcFound.transceiver.find(
                  (v) => v.type === "wormhole"
                )!.address,
              },
              quoter: srcFound.quoter,
              svmShims: srcFound.svmShims,
              eta: srcFound.eta,
            },
            dstContracts: {
              token: dstFound.token,
              manager: dstFound.manager,
              transceiver: {
                wormhole: dstFound.transceiver.find(
                  (v) => v.type === "wormhole"
                )!.address,
              },
              svmShims: dstFound.svmShims,
            },
          };
        }
      }
    }

    throw new Error("Cannot find Ntt contracts in config for: " + srcAddress);
  }

  export function resolveDestinationNttContracts<C extends Chain>(
    config: Config,
    srcManager: ChainAddress<C>,
    dstChain: Chain
  ): Ntt.Contracts {
    const cfg = Object.values(config.tokens);
    const address = canonicalAddress(srcManager);
    for (const tokens of cfg) {
      const found = tokens.find(
        (tc) =>
          tc.manager.toLowerCase() === address.toLowerCase() &&
          tc.chain === srcManager.chain
      );
      if (found) {
        const remote = tokens.find((tc) => tc.chain === dstChain);
        if (!remote) {
          throw new Error(
            `Cannot find destination Ntt contracts in config for: ${address}`
          );
        }
        return {
          token: remote.unwrapsOnRedeem ? "native" : remote.token,
          manager: remote.manager,
          transceiver: {
            wormhole: remote.transceiver.find((v) => v.type === "wormhole")!
              .address,
          },
          quoter: remote.quoter,
          svmShims: remote.svmShims,
        };
      }
    }
    throw new Error("Cannot find Ntt contracts in config for: " + address);
  }

  // returns true if the amount is greater than 95% of the capacity
  // useful for warning about the possibility of a transfer being queued
  export function isCapacityThresholdExceeded(
    amount: bigint,
    capacity: bigint
  ): boolean {
    const threshold = (capacity * 95n) / 100n;
    return amount > threshold;
  }

  export function trimAmount(
    amt: amount.Amount,
    dstTokenDecimals: number
  ): amount.Amount {
    // remove dust to avoid `TransferAmountHasDust` revert reason
    const truncatedAmount = amount.truncate(
      amt,
      Math.min(amt.decimals, dstTokenDecimals, NttRoute.TRIMMED_DECIMALS)
    );
    return truncatedAmount;
  }
}
export namespace MultiTokenNttRoute {
  export type Config = {
    contracts: MultiTokenNtt.Contracts[];
    perTokenOverrides?: MultiTokenNttRoute.PerTokenGasLimit;
    axelarGasMultiplier?: number | "auto";
  };

  export type NormalizedParams = {
    amount: amount.Amount;
    sourceContracts: MultiTokenNtt.Contracts;
    destinationContracts: MultiTokenNtt.Contracts;
    sourceTokenId: TokenId;
    destinationTokenId: TokenId;
    originalTokenId: MultiTokenNtt.OriginalTokenId;
    sendTransceivers: Ntt.TransceiverMeta[];
    gasLimit: bigint;
    referrerFeeDbps?: bigint;
  };

  export type Options = {
    // 0.0 - 1.0 percentage of the maximum gas drop-off amount
    nativeGas?: number;
  };

  export interface ValidatedParams
    extends routes.ValidatedTransferParams<Options> {
    normalizedParams: NormalizedParams;
  }

  export type AttestationReceipt = {
    id: WormholeMessageId;
    attestation: VAA<"MultiTokenNtt:WormholeTransfer">;
  };

  export type TransferReceipt<
    SC extends Chain = Chain,
    DC extends Chain = Chain,
  > = _TransferReceipt<AttestationReceipt, SC, DC> & {
    params: ValidatedParams;
    trackingInfo: {
      transceiverAttested: { [type: string]: boolean };
    };
  };

  export function resolveSupportedNetworks(
    contracts: MultiTokenNtt.Contracts[]
  ): Network[] {
    return ["Mainnet", "Testnet"];
  }

  export function resolveSupportedChains(
    contracts: MultiTokenNtt.Contracts[],
    network: Network
  ): Chain[] {
    return contracts.flatMap((c) => c.chain);
  }

  export function resolveContracts(
    contracts: MultiTokenNtt.Contracts[],
    chain: Chain
  ): MultiTokenNtt.Contracts {
    const cfg = contracts.find((c) => c.chain === chain);
    if (!cfg) {
      throw new Error(
        "Cannot find MultiTokenNtt contracts in config for: " + chain
      );
    }
    return cfg;
  }

  // Helper function to get the destination TokenId
  export async function getDestinationTokenId<N extends Network>(
    sourceToken: TokenId,
    fromChain: ChainContext<N>,
    toChain: ChainContext<N>,
    contracts: MultiTokenNtt.Contracts[],
    originalToken?: MultiTokenNtt.OriginalTokenId
  ): Promise<TokenId> {
    if (sourceToken.chain !== fromChain.chain) {
      throw new Error("Source token must be native to the source chain");
    }

    const sourceNtt = await fromChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: MultiTokenNttRoute.resolveContracts(
        contracts,
        fromChain.chain
      ),
    });

    const destinationNtt = await toChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: MultiTokenNttRoute.resolveContracts(
        contracts,
        toChain.chain
      ),
    });

    if (isNative(sourceToken.address)) {
      sourceToken = await sourceNtt.getWrappedNativeToken();
    }

    originalToken =
      originalToken ?? (await sourceNtt.getOriginalToken(sourceToken));

    // If the token exists on the destination chain, return it
    const destinationToken = await destinationNtt.getLocalToken(originalToken);
    if (destinationToken) {
      // If the destination token is the wrapped native token,
      // return the native token since it gets unwrapped by the contract
      const wrappedNativeToken = await destinationNtt.getWrappedNativeToken();
      if (isSameToken(wrappedNativeToken, destinationToken)) {
        return nativeTokenId(toChain.chain);
      }
      return destinationToken;
    }

    // Otherwise the token will be created by the contract when the transfer is completed
    const tokenMeta = await sourceNtt.getTokenMeta(sourceToken);

    // The destination token address is deterministic, so calculate it here
    // NOTE: there is a very slim race condition where the token is overridden before a transfer is completed
    const destinationTokenAddress =
      await destinationNtt.calculateLocalTokenAddress(originalToken, tokenMeta);

    return {
      chain: toChain.chain,
      address: destinationTokenAddress,
      isUnattested: true,
      // TODO: decimals may need to be adjusted for non-EVM platforms if we support them
      decimals: tokenMeta.decimals,
      originalTokenId: Wormhole.tokenId(
        sourceToken.chain,
        sourceToken.address.toString()
      ),
    } as UnattestedTokenId;
  }

  export type PerTokenGasLimit = Partial<
    Record<
      Chain,
      Record<
        string,
        {
          gasLimit?: bigint;
        }
      >
    >
  >;

  export async function estimateGasLimit<N extends Network>(
    request: routes.RouteTransferRequest<N>,
    originalTokenId: MultiTokenNtt.OriginalTokenId,
    contracts: MultiTokenNtt.Contracts[],
    overrides?: PerTokenGasLimit
  ): Promise<bigint> {
    if (overrides) {
      const destinationTokenAddress = canonicalAddress(request.destination.id);
      const override =
        overrides[request.destination.id.chain]?.[destinationTokenAddress];
      if (override?.gasLimit !== undefined) {
        return override.gasLimit;
      }
    }

    const destinationContracts = MultiTokenNttRoute.resolveContracts(
      contracts,
      request.toChain.chain
    );

    const destinationNtt = await request.toChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: destinationContracts,
    });

    const gasLimit = await destinationNtt.estimateGasLimit(originalTokenId);

    return gasLimit;
  }

  export async function checkRateLimit<N extends Network>(
    destinationNtt: MultiTokenNtt<N, Chain>,
    fromChain: Chain,
    originalTokenId: MultiTokenNtt.OriginalTokenId,
    receivedAmount: amount.Amount,
    duration: bigint
  ): Promise<QuoteWarning[] | undefined> {
    if (duration > 0n) {
      const inboundLimit = await destinationNtt.getInboundLimit(
        originalTokenId,
        fromChain
      );

      if (inboundLimit !== null) {
        const capacity = await destinationNtt.getCurrentInboundCapacity(
          originalTokenId,
          fromChain
        );

        if (
          NttRoute.isCapacityThresholdExceeded(
            amount.units(receivedAmount),
            capacity
          )
        ) {
          return [
            {
              type: "DestinationCapacityWarning",
              delayDurationSec: Number(duration),
            },
          ];
        }
      }
    }
    return undefined;
  }

  export async function isWrappedToken<N extends Network>(
    chain: ChainContext<N>,
    token: TokenId,
    contracts: MultiTokenNtt.Contracts[]
  ): Promise<boolean> {
    const ntt = await chain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: MultiTokenNttRoute.resolveContracts(
        contracts,
        chain.chain
      ),
    });

    return await ntt.isWrappedToken(token);
  }

  export async function getOriginalToken<N extends Network>(
    chain: ChainContext<N>,
    token: TokenId,
    contracts: MultiTokenNtt.Contracts[]
  ): Promise<TokenId> {
    const ntt = await chain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: MultiTokenNttRoute.resolveContracts(
        contracts,
        chain.chain
      ),
    });

    const originalToken = await ntt.getOriginalToken(token);
    if (originalToken === null) {
      throw new Error("Token is not a wrapped token");
    }

    return {
      chain: originalToken.chain,
      address: originalToken.address.toNative(originalToken.chain),
    };
  }

  export async function complete<N extends Network, R extends TransferReceipt>(
    signer: Signer,
    chain: ChainContext<N>,
    receipt: R
  ): Promise<R> {
    if (!isAttested(receipt) && !isFailed(receipt)) {
      if (isRedeemed(receipt)) return receipt;
      throw new Error(
        "The source must be finalized in order to complete the transfer"
      );
    }

    if (!receipt.attestation) {
      throw new Error("No attestation found on the transfer receipt");
    }

    const ntt = await chain.getProtocol("MultiTokenNtt", {
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

    await signSendWait(chain, completeXfer, signer);

    return receipt;
  }

  export async function finalize<N extends Network, R extends TransferReceipt>(
    signer: Signer,
    chain: ChainContext<N>,
    receipt: R
  ): Promise<R> {
    if (!isDestinationQueued(receipt)) {
      throw new Error(
        "The transfer must be destination queued in order to finalize"
      );
    }

    const {
      attestation: { attestation: vaa },
    } = receipt;

    const ntt = await chain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: receipt.params.normalizedParams.destinationContracts,
    });
    const completeTransfer = ntt.completeInboundQueuedTransfer(
      receipt.from,
      vaa.payload.nttManagerPayload
    );
    const finalizeTxids = await signSendWait(chain, completeTransfer, signer);
    return {
      ...receipt,
      state: TransferState.DestinationFinalized,
      destinationTxs: [...(receipt.destinationTxs ?? []), ...finalizeTxids],
    };
  }

  export async function resume<N extends Network, R extends TransferReceipt>(
    tx: TransactionId,
    wh: Wormhole<N>,
    contracts: MultiTokenNtt.Contracts[]
  ): Promise<R> {
    const fromChain = wh.getChain(tx.chain);
    const [msg] = await fromChain.parseTransaction(tx.txid);
    if (!msg) throw new Error("No Wormhole messages found");

    const vaa = await wh.getVaa(msg, "MultiTokenNtt:WormholeTransfer");
    if (!vaa) throw new Error("No VAA found for transaction: " + tx.txid);

    const { payload } = vaa.payload.nttManagerPayload;

    const sourceContracts = MultiTokenNttRoute.resolveContracts(
      contracts,
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
      contracts,
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
      wh.getChain(payload.toChain),
      contracts,
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
          gasLimit: 0n,
        },
        options: {},
      },
      trackingInfo: { transceiverAttested: {} },
    } as R;
  }

  export async function* track<N extends Network, R extends TransferReceipt>(
    wh: Wormhole<N>,
    receipt: R,
    isManual?: boolean,
    timeout?: number
  ) {
    let leftover = timeout ? timeout : 60 * 60 * 1000;
    while (leftover > 0 && !isCompleted(receipt)) {
      const start = Date.now();

      if (isSourceInitiated(receipt) || isSourceFinalized(receipt)) {
        const txid = receipt.originTxs.at(-1)!;

        // TODO: can pass txid when this is published: https://github.com/wormhole-foundation/wormhole-sdk-ts/pull/909
        const fromChain: ChainContext<N> = wh.getChain(receipt.from);
        const [msg] = await fromChain.parseTransaction(txid.txid);
        if (!msg) throw new Error("No Wormhole messages found");

        const vaa = await wh.getVaa(
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

      const toChain = wh.getChain(receipt.to);
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
          };
          yield receipt;
        } else {
          const { sendTransceivers } = receipt.params.normalizedParams;

          // The Wormhole transceiver may wait to attest until all other transceivers have attested
          // so we want to check it last
          const sortedTransceivers = [...sendTransceivers].sort((a, b) => {
            const aType = a.type.toLowerCase();
            const bType = b.type.toLowerCase();
            if (aType === "wormhole" && bType !== "wormhole") return 1;
            if (aType !== "wormhole" && bType === "wormhole") return -1;
            return 0;
          });

          for (const transceiver of sortedTransceivers) {
            const transceiverType = transceiver.type.toLowerCase();
            if (receipt.trackingInfo.transceiverAttested[transceiverType]) {
              continue;
            }

            const attested = await destinationNtt.transceiverAttestedToMessage(
              receipt.from,
              vaa.payload.nttManagerPayload,
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
                };
                yield receipt;
              }
              continue;
            }

            if (transceiverType === "wormhole") {
              // Manual transfers don't use executor
              if (!isManual) {
                receipt = await trackExecutor(wh.network, receipt);
              }
            } else if (transceiverType === "axelar") {
              receipt = await trackAxelar(wh.network, receipt);
            } else {
              throw new Error(
                `Unsupported transceiver type: ${transceiver.type}`
              );
            }
            yield receipt;
            // We are breaking here so we only track one transceiver at a time
            // until all transceivers have attested. Otherwise the receipt state
            // may jump around too much resulting in a glitchy UI.
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
          };
        } else if (await destinationNtt.getIsExecuted(vaa)) {
          receipt = {
            ...receipt,
            state: TransferState.DestinationFinalized,
          };
        }
      }

      yield receipt;

      // Sleep for a bit so we don't spam requests
      await new Promise((resolve) => setTimeout(resolve, 5000));
      leftover -= Date.now() - start;
    }

    return receipt;
  }
}
