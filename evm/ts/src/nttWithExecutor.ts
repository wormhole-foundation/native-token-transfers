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
    Ethereum: "0xD2D9c936165a85F27a5a7e07aFb974D022B89463",
    HyperEVM: "0x431017B1718b86898C7590fFcCC380DEf0456393",
    Ink: "0x420370DC2ECC4D44b47514B7859fd11809BbeFF5",
    Linea: "0xEAa5AddB5b8939Eb73F7faF46e193EefECaF13E9",
    Mezo: "0x484b5593BbB90383f94FB299470F09427cf6cfE2",
    Moonbeam: "0x1365593C8bae71a55e48E105a2Bb76d5928c7DE3",
    Optimism: "0x85C0129bE5226C9F0Cf4e419D2fefc1c3FCa25cF",
    Plume: "0x6Eb53371f646788De6B4D0225a4Ed1d9267188AD",
    Polygon: "0x6762157b73941e36cEd0AEf54614DdE545d0F990",
    Scroll: "0x055625d48968f99409244E8c3e03FbE73B235a62",
    Sonic: "0xaCa00703bb87F31D6F9fCcc963548b48FA46DfeB",
    Unichain: "0x607723D6353Dae3ef62B7B277Cfabd0F4bc6CB4C",
    Worldchain: "0x66b1644400D51e104272337226De3EF1A820eC79",
    XRPLEVM: "0x6bBd1ff3bB303F88835A714EE3241bF45DE26d29",
    Seievm: "0x3F2D6441C7a59Dfe80f8e14142F9E28F6D440445",
    CreditCoin: "0x5454b995719626256C96fb57454b044ffb3Da2F9",
    Monad: "0xc3F3dDa544815a440633176c7598f5B97500793e",
    MegaETH: "0x3EFEc0c7Ee79135330DD03e995872f84b1AD49b6",
  },
  Testnet: {
    ArbitrumSepolia: "0xd048170F1ECB8D47E499D3459aC379DA023E2C1B",
    Avalanche: "0x4e9Af03fbf1aa2b79A2D4babD3e22e09f18Bb8EE",
    BaseSepolia: "0x5845E08d890E21687F7Ebf7CbAbD360cD91c6245",
    Bsc: "0x39B57Dd9908F8be02CfeE283b67eA1303Bc29fe1",
    OptimismSepolia: "0xaDB1C56D363FF5A75260c3bd27dd7C1fC8421EF5",
    Sepolia: "0x54DD7080aE169DD923fE56d0C4f814a0a17B8f41",
    Ink: "0xF420BFFf922D11c2bBF587C9dF71b83651fAf8Bc",
    Seievm: "0x3F2D6441C7a59Dfe80f8e14142F9E28F6D440445",
    Converge: "0x3d8c26b67BDf630FBB44F09266aFA735F1129197",
    Plume: "0x6Eb53371f646788De6B4D0225a4Ed1d9267188AD",
    PolygonSepolia: "0x2982B9566E912458fE711FB1Fd78158264596937",
    Monad: "0x93FE94Ad887a1B04DBFf1f736bfcD1698D4cfF66",
    Celo: "0x3d69869fcB9e1CD1F4020b637fb8256030BAc8fC",
    Unichain: "0x607723D6353Dae3ef62B7B277Cfabd0F4bc6CB4C",
    XRPLEVM: "0xcDD9d7C759b29680f7a516d0058de8293b2AC7b1",
    Mezo: "0x484b5593BbB90383f94FB299470F09427cf6cfE2",
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
  },
  Testnet: {
    ArbitrumSepolia: 800_000n,
  },
};

// Tracks which executor contracts support the transferETH method.
// Currently only Monad Mainnet supports this, but all executor contracts should eventually
// be upgraded to support transferETH.
const supportsTransferETH: Partial<
  Record<Network, Partial<Record<EvmChains, boolean>>>
> = {
  Mainnet: {
    Monad: true,
  },
};

export class EvmNttWithExecutor<N extends Network, C extends EvmChains>
  implements NttWithExecutor<N, C>
{
  readonly chainId: bigint;
  readonly executorAddress: string;
  readonly supportsTransferETH: boolean;

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
    this.supportsTransferETH =
      supportsTransferETH[this.network]?.[this.chain] ?? false;
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

    const options = { queue: false, automatic: false };

    // This will include any transceiver fees
    const deliveryPrice = await ntt.quoteDeliveryPrice(
      destination.chain,
      options
    );

    // Use transferETH if wrapNative is requested and the contract supports it
    const useTransferETH = wrapNative && this.supportsTransferETH;

    if (wrapNative && !this.supportsTransferETH) {
      yield ntt.wrapNative(sender, amount);
    }

    // ABI for the INttManagerWithExecutor transfer functions
    // TODO: type safety. typechain brings in so much boilerplate code and is soft deprecated. Use Viem instead?
    const abi = [
      "function transfer(address nttManager, uint256 amount, uint16 recipientChain, bytes32 recipientAddress, bytes32 refundAddress, bytes encodedInstructions, (uint256 value, address refundAddress, bytes signedQuote, bytes instructions) executorArgs, (uint16 dbps, address payee) feeArgs) external payable returns (uint64 msgId)",
      "function transferETH(address nttManager, uint256 amount, uint16 recipientChain, bytes32 recipientAddress, bytes32 refundAddress, bytes encodedInstructions, (uint256 value, address refundAddress, bytes signedQuote, bytes instructions) executorArgs, (uint16 dbps, address payee) feeArgs) external payable returns (uint64 msgId)",
    ];

    const iface = new Interface(abi);

    const nttManager = ntt.managerAddress;
    const recipientChain = toChainId(destination.chain);
    const recipientAddress = destination.address
      .toUniversalAddress()
      .toUint8Array();
    const refundAddress = sender.toUniversalAddress().toUint8Array();
    const encodedInstructions = Ntt.encodeTransceiverInstructions(
      ntt.encodeOptions({ queue: false, automatic: false })
    );
    const executorArgs = {
      value: quote.estimatedCost,
      refundAddress: senderAddress,
      signedQuote: quote.signedQuote,
      instructions: quote.relayInstructions,
    };
    const feeArgs = {
      dbps: quote.referrerFeeDbps,
      payee: quote.referrer.address.toString(),
    };

    let data: string;
    let msgValue: bigint;

    if (useTransferETH) {
      data = iface.encodeFunctionData("transferETH", [
        nttManager,
        amount,
        recipientChain,
        recipientAddress,
        refundAddress,
        encodedInstructions,
        executorArgs,
        feeArgs,
      ]);
      msgValue = quote.estimatedCost + deliveryPrice + amount;
    } else {
      // Standard ERC20 transfer flow with approval
      const tokenContract = EvmPlatform.getTokenImplementation(
        this.provider,
        ntt.tokenAddress
      );

      const allowance = await tokenContract.allowance(
        senderAddress,
        this.executorAddress
      );

      if (allowance < amount) {
        const txReq = await tokenContract.approve.populateTransaction(
          this.executorAddress,
          amount
        );

        yield ntt.createUnsignedTx(txReq, "Ntt.Approve");
      }

      data = iface.encodeFunctionData("transfer", [
        nttManager,
        amount,
        recipientChain,
        recipientAddress,
        refundAddress,
        encodedInstructions,
        executorArgs,
        feeArgs,
      ]);
      msgValue = quote.estimatedCost + deliveryPrice;
    }

    const txReq = {
      to: this.executorAddress,
      data,
      value: msgValue,
    };

    yield ntt.createUnsignedTx(
      txReq,
      useTransferETH
        ? "NttWithExecutor.transferETH"
        : "NttWithExecutor.transfer"
    );
  }

  async estimateMsgValueAndGasLimit(
    recipient: ChainAddress | undefined
  ): Promise<{ msgValue: bigint; gasLimit: bigint }> {
    const gasLimit = gasLimitOverrides[this.network]?.[this.chain] ?? 500_000n;
    return { msgValue: 0n, gasLimit };
  }
}

/**
 * Check if an executor (NttWithExecutor) is deployed for a given network and chain combination
 * @param network - The network (e.g., 'Mainnet', 'Testnet')
 * @param chain - The EVM chain (e.g., 'Arbitrum', 'ArbitrumSepolia')
 * @returns true if an executor address exists for this network/chain combination
 */
export function hasExecutorDeployed(network: Network, chain: EvmChains): boolean {
  return nttManagerWithExecutorAddresses[network]?.[chain] !== undefined;
}