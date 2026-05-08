import {
  nativeChainIds,
  toChainId,
  type Network,
} from "@wormhole-foundation/sdk-base";
import {
  type AccountAddress,
  type ChainAddress,
  type ChainsConfig,
  Contracts,
  UnsignedTransaction,
} from "@wormhole-foundation/sdk-definitions";
import { Ntt, NttWithExecutor } from "@wormhole-foundation/sdk-definitions-ntt";
import {
  EvmPlatform,
  type EvmPlatformType,
  type EvmChains,
  EvmAddress,
} from "@wormhole-foundation/sdk-evm";
import { Provider, Interface } from "ethers";
import { EvmNtt } from "./ntt.js";

// TODO: update with correct v2 contract addresses
const nttManagerWithExecutorAddresses: Partial<
  Record<Network, Partial<Record<EvmChains, string>>>
> = {
  Mainnet: {
    Arbitrum: "0x0Af42A597b0C201D4dcf450DcD0c06d55ddC1C77",
    Avalanche: "0x4e9Af03fbf1aa2b79A2D4babD3e22e09f18Bb8EE",
    Base: "0x83216747fC21b86173D800E2960c0D5395de0F30",
    Berachain: "0x0a2AF374Cc9CCCbB0Acc4E34B20b9d02a0f08c30",
    Bsc: "0x39B57Dd9908F8be02CfeE283b67eA1303Bc29fe1",
    Celo: "0x3d69869fcB9e1CD1F4020b637fb8256030BAc8fC",
    CreditCoin: "0x5454b995719626256C96fb57454b044ffb3Da2F9",
    Ethereum: "0xD2D9c936165a85F27a5a7e07aFb974D022B89463",
    HyperEVM: "0x431017B1718b86898C7590fFcCC380DEf0456393",
    Ink: "0x420370DC2ECC4D44b47514B7859fd11809BbeFF5",
    Linea: "0xEAa5AddB5b8939Eb73F7faF46e193EefECaF13E9",
    MegaETH: "0x3EFEc0c7Ee79135330DD03e995872f84b1AD49b6",
    Mezo: "0x484b5593BbB90383f94FB299470F09427cf6cfE2",
    Moca: "0xE612837749a0690BA2BCe490D6eFb5F8Fc347df3",
    Monad: "0xc3F3dDa544815a440633176c7598f5B97500793e",
    Moonbeam: "0x1365593C8bae71a55e48E105a2Bb76d5928c7DE3",
    Optimism: "0x85C0129bE5226C9F0Cf4e419D2fefc1c3FCa25cF",
    Plume: "0x6Eb53371f646788De6B4D0225a4Ed1d9267188AD",
    Polygon: "0x6762157b73941e36cEd0AEf54614DdE545d0F990",
    Seievm: "0x3F2D6441C7a59Dfe80f8e14142F9E28F6D440445",
    Sonic: "0xaCa00703bb87F31D6F9fCcc963548b48FA46DfeB",
    Unichain: "0x607723D6353Dae3ef62B7B277Cfabd0F4bc6CB4C",
    Worldchain: "0x66b1644400D51e104272337226De3EF1A820eC79",
    XRPLEVM: "0x6bBd1ff3bB303F88835A714EE3241bF45DE26d29",
    ZeroGravity: "0xe175A8b838f3CdB2e1AAf4Ff74c05cF2F3AEA9a8",
    Nexus: "0x0F8B6B4Bd7Fd645478D7b33346653427814f41FA",
  },
  Testnet: {
    ArbitrumSepolia: "0xD69CF144C31aE8C12b5C7c3D52411F32C824C9a3",
    Avalanche: "0x8196EBa42b2947f519002B8aDa53b1880F580c69",
    BaseSepolia: "0x9fBC8aA6B2f626D13005De92B3f0e4541919f721",
    Bsc: "0x2c9F87bE2eb0caEB8AfFE6F7ae1f046E5D40Ff2a",
    Celo: "0x3d69869fcB9e1CD1F4020b637fb8256030BAc8fC",
    Converge: "0x3d8c26b67BDf630FBB44F09266aFA735F1129197",
    Ink: "0x86B93560FeAbc95a0067a498d8afe1219f3ED0D7",
    Linea: "0x5d98Ded0E46d0aEAB37EA4fEe45A38dc5ccee673",
    Mezo: "0x117F5F5E8d29ED6254c6098457Cea28E3Ee7cDdA",
    Moca: "0x47f26bF9253Eb398fBAf825D7565FE975D839a71",
    Monad: "0x8BcA0315627DA3D2e5FA349a6A1ad2FAde36BCe5",
    OptimismSepolia: "0xA8b1d0520D556b4Ea115562D35077cAA2f13C6D6",
    Plume: "0x6D87C7d416dFf428117b560A981d788E39707195",
    PolygonSepolia: "0x2982B9566E912458fE711FB1Fd78158264596937", // TODO: still v0.0.1, needs redeployment
    Seievm: "0xdb66Dc163A03220661ca33B492c72a6a15B3a8cf",
    Sepolia: "0xc2386453598811D88613331D52e2Ca4B2AEe16E4",
    Unichain: "0xc41853C70bf70a2FFeE3ddd8f38D2b774Fe3E264",
    XRPLEVM: "0x0fbDaE31440f5549e2F08193b5B034F2F9768304",
    ZeroGravity: "0x69BeC29e71711B30F58585C0bb1622e7b47e3707",
  },
};

// Gas limits must be high enough to cover the worst-case scenario for each chain
// to avoid relay failures. However, they should not be too high to reduce the
// `estimatedCost` returned by the quote endpoint.
const gasLimitOverrides: Partial<
  Record<Network, Partial<Record<EvmChains, bigint>>>
> = {
  Mainnet: {
    Arbitrum: 800_000n,
    CreditCoin: 1_500_000n,
    Monad: 1_000_000n,
    MegaETH: 1_000_000n,
    Seievm: 1_000_000n,
  },
  Testnet: {
    ArbitrumSepolia: 800_000n,
    Seievm: 1_000_000n,
  },
};

export const nttWithExecutorAbi = [
  "function transfer(address nttManager, uint256 amount, uint16 recipientChain, bytes32 recipientAddress, bytes32 refundAddress, bytes encodedInstructions, (uint256 value, address refundAddress, bytes signedQuote, bytes instructions) executorArgs, (uint256 transferTokenFee, uint256 nativeTokenFee, address payee) feeArgs) external payable returns (uint64 msgId)",
  "function transferETH(address nttManager, uint256 amount, uint16 recipientChain, bytes32 recipientAddress, bytes32 refundAddress, bytes encodedInstructions, (uint256 value, address refundAddress, bytes signedQuote, bytes instructions) executorArgs, (uint256 transferTokenFee, uint256 nativeTokenFee, address payee) feeArgs) external payable returns (uint64 msgId)",
];

export class EvmNttWithExecutor<N extends Network, C extends EvmChains>
  implements NttWithExecutor<N, C>
{
  readonly chainId: bigint;
  readonly executorAddress: string;

  constructor(
    readonly network: N,
    readonly chain: C,
    readonly provider: Provider,
    readonly contracts: Contracts & { ntt?: Ntt.Contracts }
  ) {
    this.chainId = nativeChainIds.networkChainToNativeChainId.get(
      network,
      chain
    ) as bigint;

    const executorAddress =
      nttManagerWithExecutorAddresses[this.network]?.[this.chain];
    if (!executorAddress)
      throw new Error(`Executor address not found for chain ${this.chain}`);
    this.executorAddress = executorAddress;
  }

  static async fromRpc<N extends Network>(
    provider: Provider,
    config: ChainsConfig<N, EvmPlatformType>
  ): Promise<EvmNttWithExecutor<N, EvmChains>> {
    const [network, chain] = await EvmPlatform.chainFromRpc(provider);
    const conf = config[chain]!;
    if (conf.network !== network)
      throw new Error(`Network mismatch: ${conf.network} != ${network}`);

    return new EvmNttWithExecutor(
      network as N,
      chain,
      provider,
      conf.contracts
    );
  }

  async *transfer(
    sender: AccountAddress<C>,
    destination: ChainAddress,
    amount: bigint,
    quote: NttWithExecutor.Quote,
    ntt: EvmNtt<N, C>,
    wrapNative: boolean = false
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    const senderAddress = new EvmAddress(sender).toString();
    const deliveryPrice = await ntt.quoteDeliveryPrice(destination.chain, {
      queue: false,
      automatic: false,
    });

    // Fee is deducted from the transfer amount.
    // Approval covers remainingAmount + transferTokenFee = the full user amount.
    const totalAmount = quote.remainingAmount + quote.transferTokenFee;

    const iface = new Interface(nttWithExecutorAbi);

    const commonArgs = [
      ntt.managerAddress,
      quote.remainingAmount,
      toChainId(destination.chain),
      destination.address.toUniversalAddress().toUint8Array(),
      sender.toUniversalAddress().toUint8Array(),
      Ntt.encodeTransceiverInstructions(
        ntt.encodeOptions({ queue: false, automatic: false })
      ),
      {
        value: quote.estimatedCost,
        refundAddress: senderAddress,
        signedQuote: quote.signedQuote,
        instructions: quote.relayInstructions,
      },
    ] as const;

    const feeArgs = {
      transferTokenFee: quote.transferTokenFee,
      nativeTokenFee: quote.nativeTokenFee,
      payee: quote.referrer.address.toString(),
    };

    let data: string;
    let msgValue: bigint;

    if (wrapNative) {
      data = iface.encodeFunctionData("transferETH", [...commonArgs, feeArgs]);
      msgValue =
        quote.estimatedCost +
        deliveryPrice +
        quote.nativeTokenFee +
        totalAmount;
    } else {
      yield* this.approveIfNeeded(
        senderAddress,
        this.executorAddress,
        totalAmount,
        ntt
      );
      data = iface.encodeFunctionData("transfer", [...commonArgs, feeArgs]);
      msgValue = quote.estimatedCost + deliveryPrice + quote.nativeTokenFee;
    }

    yield ntt.createUnsignedTx(
      { to: this.executorAddress, data, value: msgValue },
      wrapNative ? "NttWithExecutor.transferETH" : "NttWithExecutor.transfer"
    );
  }

  private async *approveIfNeeded(
    senderAddress: string,
    contractAddress: string,
    requiredAmount: bigint,
    ntt: EvmNtt<N, C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    const tokenContract = EvmPlatform.getTokenImplementation(
      this.provider,
      ntt.tokenAddress
    );

    const allowance = await tokenContract.allowance(
      senderAddress,
      contractAddress
    );

    if (allowance < requiredAmount) {
      const txReq = await tokenContract.approve.populateTransaction(
        contractAddress,
        requiredAmount
      );
      yield ntt.createUnsignedTx(txReq, "Ntt.Approve");
    }
  }

  async estimateMsgValueAndGasLimit(
    recipient: ChainAddress | undefined
  ): Promise<{ msgValue: bigint; gasLimit: bigint }> {
    const gasLimit = gasLimitOverrides[this.network]?.[this.chain] ?? 500_000n;
    return { msgValue: 0n, gasLimit };
  }
}

/**
 * Check if an executor (NttWithExecutor) is deployed for a given network and chain combination.
 */
export function hasExecutorDeployed(
  network: Network,
  chain: EvmChains
): boolean {
  return nttManagerWithExecutorAddresses[network]?.[chain] !== undefined;
}
