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
} from "@wormhole-foundation/sdk-evm";
import {
  Ntt,
  type MultiTokenNtt,
  type MultiTokenNttWithExecutor,
} from "@wormhole-foundation/sdk-definitions-ntt";
import { EvmMultiTokenNtt } from "./multiTokenNtt.js";

const multiTokenNttWithExecutorAddresses: Partial<
  Record<Network, Partial<Record<EvmChains, string>>>
> = {
  Testnet: {
    Sepolia: "0xc2EA39E0072b37C34c67C486C0B1526a96b0b77e",
    Monad: "0x780720817647E6C2532F821C4eC925840489942B",
  },
};

export class EvmMultiTokenNttWithExecutor<
  N extends Network,
  C extends EvmChains = EvmChains
> implements MultiTokenNttWithExecutor<N, C>
{
  readonly chainId: bigint;
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
    quote: MultiTokenNttWithExecutor.Quote,
    multiTokenNtt: EvmMultiTokenNtt<N, C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    const senderAddress = new EvmAddress(sender).toString();
    const isNativeToken = isNative(token.address);

    const abi = [
      "function transfer(address multiTokenNtt, address token, uint256 amount, uint16 recipientChain, uint256 gasLimit, bytes32 recipient, bytes32 refundAddress, bytes transceiverInstructions, (uint256 value, address refundAddress, bytes signedQuote, bytes instructions) executorArgs, (uint16 dbps, address payee) feeArgs) external payable returns (uint64)",
      "function transferETH(address multiTokenNtt, uint256 amount, uint16 recipientChain, uint256 gasLimit, bytes32 recipient, bytes32 refundAddress, bytes transceiverInstructions, (uint256 value, address refundAddress, bytes signedQuote, bytes instructions) executorArgs, (uint16 dbps, address payee) feeArgs) external payable returns (uint64)",
    ];

    const iface = new Interface(abi);

    const recipientChain = toChainId(destination.chain);
    const recipient = destination.address.toUniversalAddress().toUint8Array();
    const refundAddress = sender.toUniversalAddress().toUint8Array();

    // Calculate core bridge fee (delivery price)
    // TODO: need to pass the axelar transceiver gas required here
    const deliveryPrice = await multiTokenNtt.quoteDeliveryPrice(
      destination.chain,
      { relayerGasLimit: 0n }
    );

    // For transceiverInstructions, we'll use empty bytes for now
    // This should be configurable based on the specific requirements
    const whTransceiverInstruction: Ntt.TransceiverInstruction = {
      index: 0,
      payload: new Uint8Array([1]),
    };
    const transceiverInstructions = Ntt.encodeTransceiverInstructions([
      whTransceiverInstruction,
      // TODO: add the axelar transceiver instruction
    ]);

    // This is the standard relayer gasLimit (not used in executor transfers),
    // but we still need to provide it
    const gasLimit = 0n;

    // Executor args from quote
    const executorArgs = {
      value: quote.estimatedCost,
      refundAddress: senderAddress,
      signedQuote: quote.signedQuote,
      instructions: quote.relayInstructions,
    };

    // Fee args from quote
    const feeArgs = {
      dbps: quote.referrerFeeDbps,
      payee: quote.referrer.address.toString(),
    };

    let data: string;
    let msgValue: bigint;

    if (isNativeToken) {
      data = iface.encodeFunctionData("transferETH", [
        multiTokenNtt.managerAddress,
        amount,
        recipientChain,
        gasLimit,
        recipient,
        refundAddress,
        transceiverInstructions,
        executorArgs,
        feeArgs,
      ]);
      msgValue = quote.estimatedCost + deliveryPrice + amount;
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

        yield multiTokenNtt.createUnsignedTx(
          approveTx,
          "MultiTokenNttWithExecutor.Approve"
        );
      }

      data = iface.encodeFunctionData("transfer", [
        multiTokenNtt.managerAddress,
        tokenAddress,
        amount,
        recipientChain,
        gasLimit,
        recipient,
        refundAddress,
        transceiverInstructions,
        executorArgs,
        feeArgs,
      ]);
      msgValue = quote.estimatedCost + deliveryPrice;
    }

    const txReq: TransactionRequest = {
      to: this.multiTokenNttWithExecutorAddress,
      data,
      value: msgValue,
      from: senderAddress,
    };

    yield multiTokenNtt.createUnsignedTx(
      txReq,
      isNativeToken
        ? "MultiTokenNttWithExecutor.transferETH"
        : "MultiTokenNttWithExecutor.transfer"
    );
  }

  async estimateMsgValueAndGasLimit(
    originalToken: MultiTokenNtt.OriginalTokenId,
    multiTokenNtt: EvmMultiTokenNtt<N, C>
  ): Promise<{ msgValue: bigint; gasLimit: bigint }> {
    const GAS_LIMIT = 500_000n;

    // More gas is needed to create the token on the destination chain
    const GAS_LIMIT_CREATE_TOKEN = 1_000_000n;

    // Check if the token already exists on the destination chain
    const existingToken = await multiTokenNtt.getLocalToken(originalToken);
    const isUnattested = existingToken === null;

    const gasLimit = isUnattested ? GAS_LIMIT_CREATE_TOKEN : GAS_LIMIT;

    return {
      msgValue: 0n,
      gasLimit,
    };
  }
}
