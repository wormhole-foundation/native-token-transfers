import {
  Chain,
  ChainAddress,
  ChainContext,
  Network,
  TokenId,
  UnattestedTokenId,
  VAA,
  Wormhole,
  WormholeMessageId,
  TransferReceipt as _TransferReceipt,
  amount,
  canonicalAddress,
  isNative,
  isSameToken,
  nativeTokenId,
  routes,
} from "@wormhole-foundation/sdk-connect";
import { MultiTokenNtt, Ntt } from "@wormhole-foundation/sdk-definitions-ntt";

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
    DC extends Chain = Chain
  > = _TransferReceipt<ManualAttestationReceipt, SC, DC> & {
    params: ValidatedParams;
  };

  export type AutomaticTransferReceipt<
    SC extends Chain = Chain,
    DC extends Chain = Chain
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

        return Wormhole.tokenId(toChain.chain, remote.token);
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
            },
            dstContracts: {
              token: dstFound.token,
              manager: dstFound.manager,
              transceiver: {
                wormhole: dstFound.transceiver.find(
                  (v) => v.type === "wormhole"
                )!.address,
              },
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
          token: remote.token,
          manager: remote.manager,
          transceiver: {
            wormhole: remote.transceiver.find((v) => v.type === "wormhole")!
              .address,
          },
          quoter: remote.quoter,
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
  };

  export type NormalizedParams = {
    amount: amount.Amount;
    sourceContracts: MultiTokenNtt.Contracts;
    destinationContracts: MultiTokenNtt.Contracts;
    sourceTokenId: TokenId;
    destinationTokenId: TokenId;
    originalTokenId: MultiTokenNtt.OriginalTokenId;
  };

  export interface ValidatedParams
    extends routes.ValidatedTransferParams<routes.Options> {
    normalizedParams: NormalizedParams;
  }

  export type ManualAttestationReceipt = {
    id: WormholeMessageId;
    attestation: VAA<"MultiTokenNtt:WormholeTransfer">;
  };

  export type ManualTransferReceipt<
    SC extends Chain = Chain,
    DC extends Chain = Chain
  > = _TransferReceipt<ManualAttestationReceipt, SC, DC> & {
    params: ValidatedParams;
  };

  export function resolveSupportedNetworks(config: Config): Network[] {
    return ["Mainnet", "Testnet"];
  }

  export function resolveSupportedChains(
    config: Config,
    network: Network
  ): Chain[] {
    return config.contracts.flatMap((c) => c.chain);
  }

  export function resolveContracts(
    config: Config,
    chain: Chain
  ): MultiTokenNtt.Contracts {
    const cfg = config.contracts.find((c) => c.chain === chain);
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
    config: MultiTokenNttRoute.Config,
    originalToken?: MultiTokenNtt.OriginalTokenId
  ): Promise<TokenId> {
    if (sourceToken.chain !== fromChain.chain) {
      throw new Error("Source token must be native to the source chain");
    }

    const sourceNtt = await fromChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: MultiTokenNttRoute.resolveContracts(
        config,
        fromChain.chain
      ),
    });

    const destinationNtt = await toChain.getProtocol("MultiTokenNtt", {
      multiTokenNtt: MultiTokenNttRoute.resolveContracts(config, toChain.chain),
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
}
