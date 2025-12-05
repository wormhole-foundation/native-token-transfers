import type { Network } from "@wormhole-foundation/sdk-base";
import { chainToChainId } from "@wormhole-foundation/sdk-base";
import {
  Contracts,
  UniversalAddress,
  type AccountAddress,
  type ChainAddress,
  type ChainsConfig,
} from "@wormhole-foundation/sdk-definitions";
import { NttWithExecutor } from "@wormhole-foundation/sdk-definitions-ntt";
import {
  StacksChains,
  StacksPlatform,
  StacksUnsignedTransaction,
  type StacksPlatformType,
} from "@wormhole-foundation/sdk-stacks";
import { StacksNetwork } from "@stacks/network";
import {
  bufferCV,
  ContractCallOptions,
  contractPrincipalCV,
  PostConditionMode,
  standardPrincipalCV,
  uintCV,
} from "@stacks/transactions";
import { StacksNtt, StacksNttContracts } from "./ntt.js";

const nttManagerWithExecutorAddresses: Partial<
  Record<Network, Partial<Record<StacksChains, string>>>
> = {
  Mainnet: {
    // TODO: Add mainnet executor address
  },
  Testnet: {
    Stacks:
      "ST36CY4MQNM6KM52EV9KN56KJXQCPXT5B8RH6B0J5.ntt-manager-with-executor-v7",
  },
};

export class StacksNttWithExecutor<N extends Network, C extends StacksChains>
  implements NttWithExecutor<N, C>
{
  readonly executorAddress: string;

  constructor(
    readonly network: N,
    readonly chain: C,
    readonly connection: StacksNetwork,
    readonly contracts: Contracts & { ntt?: StacksNttContracts }
  ) {
    const executorAddress =
      nttManagerWithExecutorAddresses[this.network]?.[this.chain];
    if (!executorAddress) {
      throw new Error(`Executor address not found for chain ${this.chain}`);
    }
    this.executorAddress = executorAddress;
  }

  static async fromRpc<N extends Network>(
    connection: StacksNetwork,
    config: ChainsConfig<N, StacksPlatformType>
  ): Promise<StacksNttWithExecutor<N, StacksChains>> {
    const [network, chain] = await StacksPlatform.chainFromRpc(connection);
    const conf = config[chain]!;
    if (conf.network !== network) {
      throw new Error(`Network mismatch: ${conf.network} != ${network}`);
    }

    return new StacksNttWithExecutor(
      network as N,
      chain,
      connection,
      conf.contracts
    );
  }

  async *transfer(
    sender: AccountAddress<C>,
    destination: ChainAddress,
    amount: bigint,
    quote: NttWithExecutor.Quote,
    ntt: StacksNtt<N, C>,
    _wrapNative: boolean = false
  ): AsyncGenerator<StacksUnsignedTransaction<N, C>> {
    const destinationChainId = chainToChainId(destination.chain);

    const executorAddressSplit = this.executorAddress.split(".");
    const executorDeployer = executorAddressSplit[0]!;
    const executorContractName = executorAddressSplit[1]!;

    const managerFullAddress = await ntt.getFullAddress();
    const managerSplit = managerFullAddress.split(".");
    const managerDeployer = managerSplit[0]!;
    const managerContractName = managerSplit[1]!;

    const tokenAddress = this.contracts.ntt!.token;
    const tokenSplit = tokenAddress.split(".");
    const tokenDeployer = tokenSplit[0]!;
    const tokenContractName = tokenSplit[1]!;

    const transceiver = await ntt.getTransceiver(0);
    if (!transceiver) {
      throw new Error("Transceiver not found");
    }
    const transceiverAddress = (
      await transceiver.getAddress()
    ).address.toString();
    const transceiverSplit = transceiverAddress.split(".");
    const transceiverDeployer = transceiverSplit[0]!;
    const transceiverContractName = transceiverSplit[1]!;

    const recipientBytes32 = new UniversalAddress(
      destination.address.toString()
    ).toUint8Array();

    const referrerAddress = quote.referrer.address.toString();

    // TODO: ContractCallOptions should be the UnisgnedTransactionType
    const tx: ContractCallOptions = {
      contractName: executorContractName,
      contractAddress: executorDeployer,
      functionName: "transfer",
      functionArgs: [
        contractPrincipalCV(managerDeployer, managerContractName),
        contractPrincipalCV(tokenDeployer, tokenContractName),
        contractPrincipalCV(transceiverDeployer, transceiverContractName),
        uintCV(amount.toString()),
        uintCV(destinationChainId),
        bufferCV(recipientBytes32),
        uintCV(quote.estimatedCost.toString()),
        standardPrincipalCV(sender.toString()), // executor-refund-address
        bufferCV(Buffer.from(quote.signedQuote)),
        bufferCV(Buffer.from(quote.relayInstructions)),
        uintCV(quote.referrerFeeDbps.toString()),
        standardPrincipalCV(referrerAddress),
      ],
      postConditionMode: PostConditionMode.Allow,
    };

    yield {
      transaction: tx,
      network: this.network,
      chain: this.chain,
      description: "NttWithExecutor.transfer",
      parallelizable: false,
    };
  }

  async estimateMsgValueAndGasLimit(
    _recipient: ChainAddress | undefined
  ): Promise<{ msgValue: bigint; gasLimit: bigint }> {
    // TODO: Implement actual estimation logic for Stacks
    // For now, return default values
    const msgValue = 0n;
    // const gasLimit = 500_000n;
    const gasLimit = 0n;

    return { msgValue, gasLimit };
  }
}
