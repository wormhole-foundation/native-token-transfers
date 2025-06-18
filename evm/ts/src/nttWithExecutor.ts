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
    Linea: "0xEAa5AddB5b8939Eb73F7faF46e193EefECaF13E9",
    Moonbeam: "0x1365593C8bae71a55e48E105a2Bb76d5928c7DE3",
    Optimism: "0x85C0129bE5226C9F0Cf4e419D2fefc1c3FCa25cF",
    Polygon: "0x6762157b73941e36cEd0AEf54614DdE545d0F990",
    Scroll: "0x055625d48968f99409244E8c3e03FbE73B235a62",
    Sonic: "0xaCa00703bb87F31D6F9fCcc963548b48FA46DfeB",
    Unichain: "0x607723D6353Dae3ef62B7B277Cfabd0F4bc6CB4C",
    Worldchain: "0x66b1644400D51e104272337226De3EF1A820eC79",
  },
  Testnet: {
    Avalanche: "0x4e9Af03fbf1aa2b79A2D4babD3e22e09f18Bb8EE",
    BaseSepolia: "0x5845E08d890E21687F7Ebf7CbAbD360cD91c6245",
    Sepolia: "0x54DD7080aE169DD923fE56d0C4f814a0a17B8f41",
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
  },
  Testnet: {},
};

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

    const options = { queue: false, automatic: false };

    // This will include any transceiver fees
    const deliveryPrice = await ntt.quoteDeliveryPrice(
      destination.chain,
      options
    );

    if (wrapNative) {
      yield ntt.wrapNative(sender, amount);
    }

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

    // ABI for the INttManagerWithExecutor transfer function
    // TODO: type safety. typechain brings in so much boilerplate code and is soft deprecated. Use Viem instead?
    const abi = [
      "function transfer(address nttManager, uint256 amount, uint16 recipientChain, bytes32 recipientAddress, bytes32 refundAddress, bytes encodedInstructions, (uint256 value, address refundAddress, bytes signedQuote, bytes instructions) executorArgs, (uint16 dbps, address payee) feeArgs) external payable returns (uint64 msgId)",
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

    const data = iface.encodeFunctionData("transfer", [
      nttManager,
      amount,
      recipientChain,
      recipientAddress,
      refundAddress,
      encodedInstructions,
      executorArgs,
      feeArgs,
    ]);

    const txReq = {
      to: this.executorAddress,
      data,
      value: quote.estimatedCost + deliveryPrice,
    };

    yield ntt.createUnsignedTx(txReq, "NttWithExecutor.transfer");
  }

  async estimateMsgValueAndGasLimit(
    recipient: ChainAddress | undefined
  ): Promise<{ msgValue: bigint; gasLimit: bigint }> {
    const gasLimit = gasLimitOverrides[this.network]?.[this.chain] ?? 500_000n;
    return { msgValue: 0n, gasLimit };
  }
}
