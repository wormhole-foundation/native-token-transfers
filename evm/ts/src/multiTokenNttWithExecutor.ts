import { Interface, type Provider, type TransactionRequest } from "ethers";
import {
  AccountAddress,
  ChainAddress,
  ChainsConfig,
  Contracts,
  Network,
  TokenId,
  UnsignedTransaction,
  isNative,
  toChainId,
  nativeChainIds,
} from "@wormhole-foundation/sdk-connect";
import {
  EvmChains,
  EvmPlatform,
  EvmPlatformType,
  EvmAddress,
  EvmUnsignedTransaction,
  addChainId,
} from "@wormhole-foundation/sdk-evm";
import {
  Ntt,
  type MultiTokenNtt,
  type MultiTokenNttWithExecutor,
} from "@wormhole-foundation/sdk-definitions-ntt";

const multiTokenNttWithExecutorAddresses: Partial<
  Record<Network, Partial<Record<EvmChains, string>>>
> = {
  Mainnet: {
    Ethereum: "0x03dB430D830601DB368991eE55DAa9A708df7912",
    Monad: "0xFEA937F7124E19124671f1685671d3f04a9Af4E4",
  },
  Testnet: {
    Sepolia: "0x70b1CD25Aa1DEbEf2BCa0eDbc11228C5EB4dAD0F",
    Monad: "0xFEA937F7124E19124671f1685671d3f04a9Af4E4",
  },
};

export class EvmMultiTokenNttWithExecutor<
  N extends Network,
  C extends EvmChains = EvmChains,
> implements MultiTokenNttWithExecutor<N, C>
{
  readonly chainId: bigint;
  readonly managerAddress: string;
  readonly multiTokenNttWithExecutorAddress: string;

  constructor(
    readonly network: N,
    readonly chain: C,
    readonly provider: Provider,
    readonly contracts: Contracts & { multiTokenNtt?: MultiTokenNtt.Contracts }
  ) {
    this.chainId = nativeChainIds.networkChainToNativeChainId.get(
      network,
      chain
    ) as bigint;

    const managerAddress = contracts.multiTokenNtt?.manager;
    if (!managerAddress) {
      throw new Error(
        `MultiTokenNtt manager address not found for chain ${chain} on network ${network}`
      );
    }
    this.managerAddress = managerAddress;

    const multiTokenNttWithExecutorAddress =
      multiTokenNttWithExecutorAddresses[this.network]?.[this.chain];
    if (!multiTokenNttWithExecutorAddress) {
      throw new Error(
        `MultiTokenNttWithExecutor address not found for chain ${this.chain} on network ${this.network}`
      );
    }
    this.multiTokenNttWithExecutorAddress = multiTokenNttWithExecutorAddress;
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
    const senderAddress = new EvmAddress(sender).toString();
    const isNativeToken = isNative(token.address);

    const abi = [
      "function transfer(address multiTokenNtt, address token, uint256 amount, uint16 recipientChain, bytes32 recipient, bytes32 refundAddress, bytes transceiverInstructions, (uint256 value, address refundAddress, bytes signedQuote, bytes instructions) executorArgs, (uint16 dbps, address payee) feeArgs) external payable returns (uint64)",
      "function transferETH(address multiTokenNtt, uint256 amount, uint16 recipientChain, bytes32 recipient, bytes32 refundAddress, bytes transceiverInstructions, (uint256 value, address refundAddress, bytes signedQuote, bytes instructions) executorArgs, (uint16 dbps, address payee) feeArgs) external payable returns (uint64)",
    ];

    const iface = new Interface(abi);

    const recipientChain = toChainId(destination.chain);
    const recipient = destination.address.toUniversalAddress().toUint8Array();
    const refundAddress = sender.toUniversalAddress().toUint8Array();

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

    if (isNativeToken) {
      data = iface.encodeFunctionData("transferETH", [
        this.managerAddress,
        amount,
        recipientChain,
        recipient,
        refundAddress,
        Ntt.encodeTransceiverInstructions(quote.transceiverInstructions),
        executorArgs,
        feeArgs,
      ]);
      msgValue = quote.estimatedCost + quote.deliveryPrice + amount;
    } else {
      const tokenAddress = new EvmAddress(token.address).toString();

      const tokenContract = EvmPlatform.getTokenImplementation(
        this.provider,
        tokenAddress
      );

      const currentAllowance = await tokenContract.allowance(
        senderAddress,
        this.multiTokenNttWithExecutorAddress
      );

      if (currentAllowance < amount) {
        const approveTx = await tokenContract.approve.populateTransaction(
          this.multiTokenNttWithExecutorAddress,
          amount
        );

        yield this.createUnsignedTx(
          approveTx,
          "MultiTokenNttWithExecutor.Approve"
        );
      }

      data = iface.encodeFunctionData("transfer", [
        this.managerAddress,
        tokenAddress,
        amount,
        recipientChain,
        recipient,
        refundAddress,
        Ntt.encodeTransceiverInstructions(quote.transceiverInstructions),
        executorArgs,
        feeArgs,
      ]);
      msgValue = quote.estimatedCost + quote.deliveryPrice;
    }

    const txReq: TransactionRequest = {
      to: this.multiTokenNttWithExecutorAddress,
      data,
      value: msgValue,
      from: senderAddress,
    };

    yield this.createUnsignedTx(
      txReq,
      isNativeToken
        ? "MultiTokenNttWithExecutor.transferETH"
        : "MultiTokenNttWithExecutor.transfer"
    );
  }

  createUnsignedTx(
    txReq: TransactionRequest,
    description: string,
    parallelizable: boolean = false
  ): EvmUnsignedTransaction<N, C> {
    return new EvmUnsignedTransaction(
      addChainId(txReq, this.chainId),
      this.network,
      this.chain,
      description,
      parallelizable
    );
  }
}
