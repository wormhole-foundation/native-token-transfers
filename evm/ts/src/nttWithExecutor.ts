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
import {
  DEFAULT_EXECUTOR_GAS_LIMIT,
  executorGasLimitOverrides,
} from "./executorGasLimits.js";

const nttManagerWithExecutorAddresses: Partial<
  Record<Network, Partial<Record<EvmChains, string>>>
> = {
  Mainnet: {
    Arbitrum: "0x5029a23E0EE11f6c9120EAb7eB48a94a49907EC4",
    Arc: "0xBd9e400d4A64DFEf7B51666d751A29ccBff4e97C",
    Avalanche: "0xf1Aa9693265E0Ba892C4a7AE77591424eEEd5cE9",
    Base: "0x27db1967D469D89318B7119Ced5609f327095de4",
    Berachain: "0x7424E82D27dD80ca47eab5e739C4D5A2D220f64f",
    Bsc: "0x83f5c7b03BBbE20FE2e39312b957D86dc7C3Dee2",
    Celo: "0xb466bA8798a5B516b43cbE6AA7bBb9532bB1708D",
    CreditCoin: "0xcA43AE520E308C6Fb444EB723406febF7c310Da3",
    Ethereum: "0xC079bFA54F348199bA51B2717595fE24e96f1542",
    HyperEVM: "0xBc275e094e031e990b060134AbbDa00132f9A163",
    Ink: "0x9e9980848FcbC11F9e84b5b6f5b88887966F5DAe",
    Linea: "0x6FE9625F59107a4D49a9b5bC10a701dD0Bb396C0",
    MegaETH: "0x7215f45Ea622E0350DF410D2e780BfD03bDc8a4D",
    Mezo: "0x50F11Fe8B0D2B6f18a12291FeD345914D7Ec69d3",
    Moca: "0x494726C75053F63CA906Aee00d6f910afE761B35",
    Monad: "0xcc9FE3526F527bB0A14242A92818e132f3c12059",
    Moonbeam: "0x40bBdD737f2Ca6316777F0B24ac94aaDE1ad1e4b",
    Optimism: "0xC25396Ce2F6FBE6996374a5527c636C71AD5a757",
    Plume: "0x00F39D8897e32B129435499F406b2fD76e37B51E",
    Polygon: "0x9d165221c3c68868D15B154c5Aa66C32e044Eb4b",
    Seievm: "0x70b85A416146A2dc3c760Ad30102F4280471C2b1",
    Sonic: "0x98D1A98Cc398Ef6F5F84D134C1370480AaabA546",
    Unichain: "0x2ceB44DE347641804856E2c468E703e06C5A8A33",
    Worldchain: "0xDdBBa9509B9587516a0736D218B193a0DCf2B3e4",
    XRPLEVM: "0xeddc0228C8719E7220eF4D8D95503258285BD482",
    ZeroGravity: "0x83A1F640d2e31538819b8B2C53cbDD244c9550F0",
  },
  Testnet: {
    Arc: "0xBd9e400d4A64DFEf7B51666d751A29ccBff4e97C",
    ArbitrumSepolia: "0xD69CF144C31aE8C12b5C7c3D52411F32C824C9a3",
    Avalanche: "0x8196EBa42b2947f519002B8aDa53b1880F580c69",
    BaseSepolia: "0x9fBC8aA6B2f626D13005De92B3f0e4541919f721",
    Bsc: "0x2c9F87bE2eb0caEB8AfFE6F7ae1f046E5D40Ff2a",
    Ink: "0x86B93560FeAbc95a0067a498d8afe1219f3ED0D7",
    Linea: "0x5d98Ded0E46d0aEAB37EA4fEe45A38dc5ccee673",
    Mezo: "0x117F5F5E8d29ED6254c6098457Cea28E3Ee7cDdA",
    Monad: "0x8BcA0315627DA3D2e5FA349a6A1ad2FAde36BCe5",
    OptimismSepolia: "0xA8b1d0520D556b4Ea115562D35077cAA2f13C6D6",
    Plume: "0x6D87C7d416dFf428117b560A981d788E39707195",
    Seievm: "0xdb66Dc163A03220661ca33B492c72a6a15B3a8cf",
    Sepolia: "0xc2386453598811D88613331D52e2Ca4B2AEe16E4",
    Unichain: "0xc41853C70bf70a2FFeE3ddd8f38D2b774Fe3E264",
    XRPLEVM: "0x0fbDaE31440f5549e2F08193b5B034F2F9768304",
    ZeroGravity: "0x69BeC29e71711B30F58585C0bb1622e7b47e3707",
  },
};

const nttManagerWithExecutorWithTokenAddresses: Partial<
  Record<Network, Partial<Record<EvmChains, string>>>
> = {
  Mainnet: {
    Tempo: "0x46d59af07A35751Deb45EC778150C7f0dFbb3d3a",
  },
  Testnet: {
    Tempo: "0x3A91179E506A15ff91467e42f5B4bD4239c6eC68",
  },
};

export const nttWithExecutorAbi = [
  "function transfer(address nttManager, uint256 amount, uint16 recipientChain, bytes32 recipientAddress, bytes32 refundAddress, bytes encodedInstructions, (uint256 value, address refundAddress, bytes signedQuote, bytes instructions) executorArgs, (uint256 transferTokenFee, uint256 nativeTokenFee, address payee) feeArgs) external payable returns (uint64 msgId)",
  "function transferETH(address nttManager, uint256 amount, uint16 recipientChain, bytes32 recipientAddress, bytes32 refundAddress, bytes encodedInstructions, (uint256 value, address refundAddress, bytes signedQuote, bytes instructions) executorArgs, (uint256 transferTokenFee, uint256 nativeTokenFee, address payee) feeArgs) external payable returns (uint64 msgId)",
];

export const nttWithExecutorWithTokenAbi = [
  "function transfer(address nttManager, uint256 amount, uint16 recipientChain, bytes32 recipientAddress, bytes32 refundAddress, bytes encodedInstructions, (uint256 value, uint256 amount, address srcToken, address refundAddress, bytes signedQuote, bytes instructions) executorArgs, (uint256 transferTokenFee, uint256 nativeTokenFee, address payee) feeArgs) external payable returns (uint64 msgId)",
  "function transferETH(address nttManager, uint256 amount, uint16 recipientChain, bytes32 recipientAddress, bytes32 refundAddress, bytes encodedInstructions, (uint256 value, uint256 amount, address srcToken, address refundAddress, bytes signedQuote, bytes instructions) executorArgs, (uint256 transferTokenFee, uint256 nativeTokenFee, address payee) feeArgs) external payable returns (uint64 msgId)",
];

export class EvmNttWithExecutor<N extends Network, C extends EvmChains>
  implements NttWithExecutor<N, C>
{
  readonly chainId: bigint;
  readonly executorAddress: string | undefined;
  readonly executorWithTokenAddress: string | undefined;

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

    this.executorAddress =
      nttManagerWithExecutorAddresses[this.network]?.[this.chain];
    this.executorWithTokenAddress =
      nttManagerWithExecutorWithTokenAddresses[this.network]?.[this.chain];
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

  private requireShimAddress(quote: NttWithExecutor.Quote): string {
    if (quote.feeToken) {
      if (!this.executorWithTokenAddress) {
        throw new Error(
          `NttManagerWithExecutorWithToken address not found for chain ${this.chain}`
        );
      }
      return this.executorWithTokenAddress;
    }
    if (!this.executorAddress) {
      throw new Error(`Executor address not found for chain ${this.chain}`);
    }
    return this.executorAddress;
  }

  async *transfer(
    sender: AccountAddress<C>,
    destination: ChainAddress,
    amount: bigint,
    quote: NttWithExecutor.Quote,
    ntt: EvmNtt<N, C>,
    wrapNative: boolean = false
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    const shimAddress = this.requireShimAddress(quote);
    const senderAddress = new EvmAddress(sender).toString();
    const deliveryPrice = await ntt.quoteDeliveryPrice(destination.chain, {
      queue: false,
      automatic: false,
    });

    const isTokenFee = quote.feeToken !== undefined;
    const iface = new Interface(
      isTokenFee ? nttWithExecutorWithTokenAbi : nttWithExecutorAbi
    );

    // executorArgs.value = native forwarded to the Executor: estimatedCost on
    // the native-fee path, 0 on the token-fee path (the fee is pulled as ERC20).
    const executorArgs = isTokenFee
      ? {
          value: 0n,
          amount: quote.estimatedCost,
          srcToken: quote.feeToken!,
          refundAddress: senderAddress,
          signedQuote: quote.signedQuote,
          instructions: quote.relayInstructions,
        }
      : {
          value: quote.estimatedCost,
          refundAddress: senderAddress,
          signedQuote: quote.signedQuote,
          instructions: quote.relayInstructions,
        };

    const commonArgs = [
      ntt.managerAddress,
      quote.remainingAmount,
      toChainId(destination.chain),
      destination.address.toUniversalAddress().toUint8Array(),
      sender.toUniversalAddress().toUint8Array(),
      Ntt.encodeTransceiverInstructions(
        ntt.encodeOptions({ queue: false, automatic: false })
      ),
      executorArgs,
    ] as const;

    // Merge into one approval when feeToken == bridged token (non-wrap only).
    const sameTokenAsFee =
      isTokenFee &&
      quote.feeToken!.toLowerCase() === ntt.tokenAddress.toLowerCase();
    const mergeFeeIntoBridgedApproval = sameTokenAsFee && !wrapNative;

    if (isTokenFee && !mergeFeeIntoBridgedApproval) {
      yield* this.approveIfNeeded(
        senderAddress,
        shimAddress,
        quote.feeToken!,
        quote.estimatedCost,
        ntt
      );
    }

    let data: string;
    let msgValue: bigint;

    if (wrapNative) {
      // The source token is native gas, deposited into WETH by the shim, so
      // transferTokenFee can't be pulled as ERC20. Fold it into nativeTokenFee
      // (same units) — the referrer is paid out of msg.value directly.
      const combinedNativeFee = quote.nativeTokenFee + quote.transferTokenFee;
      const feeArgs = {
        transferTokenFee: 0n,
        nativeTokenFee: combinedNativeFee,
        payee: quote.referrer.address.toString(),
      };
      data = iface.encodeFunctionData("transferETH", [...commonArgs, feeArgs]);
      msgValue =
        deliveryPrice +
        executorArgs.value +
        combinedNativeFee +
        quote.remainingAmount;
    } else {
      const feeArgs = {
        transferTokenFee: quote.transferTokenFee,
        nativeTokenFee: quote.nativeTokenFee,
        payee: quote.referrer.address.toString(),
      };
      const bridgedApprovalAmount =
        quote.remainingAmount +
        quote.transferTokenFee +
        (mergeFeeIntoBridgedApproval ? quote.estimatedCost : 0n);
      yield* this.approveIfNeeded(
        senderAddress,
        shimAddress,
        ntt.tokenAddress,
        bridgedApprovalAmount,
        ntt
      );
      data = iface.encodeFunctionData("transfer", [...commonArgs, feeArgs]);
      msgValue = deliveryPrice + executorArgs.value + quote.nativeTokenFee;
    }

    yield ntt.createUnsignedTx(
      { to: shimAddress, data, value: msgValue },
      this.txDescription(isTokenFee, wrapNative)
    );
  }

  private txDescription(isTokenFee: boolean, wrapNative: boolean): string {
    if (isTokenFee) {
      return wrapNative
        ? "NttWithExecutorWithToken.transferETH"
        : "NttWithExecutorWithToken.transfer";
    }
    return wrapNative
      ? "NttWithExecutor.transferETH"
      : "NttWithExecutor.transfer";
  }

  private async *approveIfNeeded(
    senderAddress: string,
    spender: string,
    tokenAddress: string,
    requiredAmount: bigint,
    ntt: EvmNtt<N, C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    const tokenContract = EvmPlatform.getTokenImplementation(
      this.provider,
      tokenAddress
    );

    const allowance = await tokenContract.allowance(senderAddress, spender);

    if (allowance < requiredAmount) {
      const txReq = await tokenContract.approve.populateTransaction(
        spender,
        requiredAmount
      );
      yield ntt.createUnsignedTx(txReq, "Ntt.Approve");
    }
  }

  async estimateMsgValueAndGasLimit(
    recipient: ChainAddress | undefined
  ): Promise<{ msgValue: bigint; gasLimit: bigint }> {
    const gasLimit =
      executorGasLimitOverrides[this.network]?.[this.chain] ??
      DEFAULT_EXECUTOR_GAS_LIMIT;
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

export function hasExecutorWithTokenDeployed(
  network: Network,
  chain: EvmChains
): boolean {
  return (
    nttManagerWithExecutorWithTokenAddresses[network]?.[chain] !== undefined
  );
}
