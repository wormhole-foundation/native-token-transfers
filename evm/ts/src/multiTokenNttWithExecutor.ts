import type { Provider } from "ethers";
import {
  AccountAddress,
  ChainAddress,
  ChainsConfig,
  Contracts,
  Network,
  TokenAddress,
  TokenId,
  UnsignedTransaction,
} from "@wormhole-foundation/sdk-connect";
import { EvmChains, EvmPlatform } from "@wormhole-foundation/sdk-evm";
import type {
  MultiTokenNtt,
  MultiTokenNttWithExecutor,
} from "@wormhole-foundation/sdk-definitions-ntt";
import { EvmPlatformType } from "@wormhole-foundation/sdk-evm";

export class EvmMultiTokenNttWithExecutor<
  N extends Network,
  C extends EvmChains = EvmChains
> implements MultiTokenNttWithExecutor<N, C>
{
  readonly chainId: bigint;
  readonly executorAddress: string;

  constructor(
    readonly network: N,
    readonly chain: C,
    readonly provider: Provider,
    readonly contracts: Contracts & { multiTokenNtt?: MultiTokenNtt.Contracts }
  ) {
    throw new Error("not implemented");
  }

  static async fromRpc<N extends Network>(
    provider: Provider,
    config: ChainsConfig<N, EvmPlatformType>
  ): Promise<EvmMultiTokenNttWithExecutor<N, EvmChains>> {
    const [network, chain] = await EvmPlatform.chainFromRpc(provider);
    const conf = config[chain]!;
    if (conf.network !== network)
      throw new Error(`Network mismatch: ${conf.network} != ${network}`);

    return new EvmMultiTokenNttWithExecutor(
      network as N,
      chain,
      provider,
      conf.contracts
    );
  }

  async *transfer(
    sender: AccountAddress<C>,
    destination: ChainAddress,
    token: TokenId<C>,
    amount: bigint,
    quote: MultiTokenNttWithExecutor.Quote
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    throw new Error("not implemented");
  }

  async estimateMsgValueAndGasLimit(
    token: TokenAddress<C>,
    recipient: ChainAddress | undefined
  ): Promise<{ msgValue: bigint; gasLimit: bigint }> {
    //// Check if there's a gas limit override for this chain
    //const gasLimitOverride = gasLimitOverrides.get(this.network, this.chain);

    //return {
    //  msgValue: quote.msgValue,
    //  gasLimit: gasLimitOverride?.gasLimit ?? quote.gasLimit,
    //};
    throw new Error("not implemented");
  }
}
