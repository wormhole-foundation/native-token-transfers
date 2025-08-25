import type { Chain, Network } from "@wormhole-foundation/sdk-base";
import { chainToChainId } from "@wormhole-foundation/sdk-base";
import {
  Contracts,
  UnsignedTransaction,
  type AccountAddress,
  type ChainAddress,
  type ChainsConfig,
} from "@wormhole-foundation/sdk-definitions";
import { Ntt, NttWithExecutor } from "@wormhole-foundation/sdk-definitions-ntt";
import {
  isSameType,
  SuiAddress,
  SuiChains,
  SuiPlatform,
  type SuiPlatformType,
  SuiUnsignedTransaction,
} from "@wormhole-foundation/sdk-sui";
import { PublicKey } from "@solana/web3.js";
import { SuiClient } from "@mysten/sui/client";
import {
  Transaction,
  TransactionObjectArgument,
} from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { SuiNtt } from "./ntt.js";
import { SUI_ADDRESSES } from "./constants.js";
import {
  isNativeToken,
  getWormholePackageId,
  getPackageId,
  getTransceivers,
} from "./utils.js";

export class SuiNttWithExecutor<N extends Network, C extends SuiChains>
  implements NttWithExecutor<N, C>
{
  readonly executorId: string;
  readonly executorRequestsId: string;
  readonly coreBridgeStateId: string;
  readonly nttContracts: Ntt.Contracts | undefined;

  constructor(
    readonly network: N,
    readonly chain: C,
    readonly provider: SuiClient,
    readonly contracts: Contracts & { ntt?: Ntt.Contracts }
  ) {
    if (!SUI_ADDRESSES[network as keyof typeof SUI_ADDRESSES]) {
      throw new Error(`Network ${network} not supported`);
    }

    this.executorId =
      SUI_ADDRESSES[network as keyof typeof SUI_ADDRESSES].executorId;
    this.executorRequestsId =
      SUI_ADDRESSES[network as keyof typeof SUI_ADDRESSES].executorRequestsId;
    this.coreBridgeStateId =
      SUI_ADDRESSES[network as keyof typeof SUI_ADDRESSES].coreBridgeStateId;
    this.nttContracts = contracts.ntt;
  }

  static async fromRpc<N extends Network>(
    provider: SuiClient,
    config: ChainsConfig<N, SuiPlatformType>
  ): Promise<SuiNttWithExecutor<N, SuiChains>> {
    const [network, chain] = await SuiPlatform.chainFromRpc(provider as any);
    const conf = config[chain]!;
    if (conf.network !== network)
      throw new Error(`Network mismatch: ${conf.network} != ${network}`);

    return new SuiNttWithExecutor(
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
    ntt: SuiNtt<N, C>,
    wrapNative: boolean = false
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    // Validate the quote hasn't expired
    if (new Date() > quote.expires) {
      throw new Error("Quote has expired");
    }

    // Validate destination chain is supported (Solana and Evm only for executor)
    const supportedDestChains = await this.getSupportedDestinationChains();
    if (!supportedDestChains.includes(destination.chain)) {
      throw new Error(
        "Executor only supports Solana and EVM destination chains"
      );
    }

    // Create a single transaction following executor pattern
    const tx = await this.createSuiNttTransferWithExecutor(
      sender,
      destination,
      quote,
      ntt
    );

    // Create and return the complete transaction
    const executorTx = new SuiUnsignedTransaction(
      tx as any,
      this.network,
      this.chain,
      "NTT Transfer with Executor"
    );

    yield executorTx;
  }

  private async createSuiNttTransferWithExecutor(
    sender: AccountAddress<C>,
    destination: ChainAddress,
    quote: NttWithExecutor.Quote,
    ntt: SuiNtt<N, C>
  ): Promise<Transaction> {
    const tx = new Transaction();
    const destinationChainId = chainToChainId(destination.chain);

    // Get required package and object IDs
    const managerStateId = ntt.contracts.ntt!["manager"];
    const token = ntt.contracts.ntt!["token"];
    const isNative = isNativeToken(token);
    const tokenAddress = new SuiAddress(
      isNative
        ? SuiPlatform.nativeTokenId(this.network, this.chain).address
        : token
    );
    const coinType: string = tokenAddress.getCoinType();
    const { packageId, fields } = await getPackageId(
      ntt.provider,
      managerStateId
    );

    // Get transceiver info
    const [transceiverStateId] = await getTransceivers(
      ntt.provider,
      fields.transceivers.fields.id.id
    );

    if (!transceiverStateId) {
      throw new Error("No transceiver state ID found");
    }

    // Get package ID for transceiver
    const { packageId: transceiverId } = await getPackageId(
      ntt.provider,
      transceiverStateId
    );

    // Convert destination address to bytes
    let destinationAddressBytes: Uint8Array;
    try {
      if (destination.address.toUniversalAddress) {
        destinationAddressBytes = destination.address
          .toUniversalAddress()
          .toUint8Array();
      } else {
        destinationAddressBytes = destination.address.toUint8Array();
      }
    } catch (error) {
      throw new Error(
        `Failed to convert destination address to bytes: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // Get coin metadata
    const coinMetadata = await ntt.provider.getCoinMetadata({
      coinType,
    });
    if (!coinMetadata?.id) {
      throw new Error(`CoinMetadata not found for ${coinType}`);
    }
    const coinMetadataId = coinMetadata.id;

    // For non-native tokens, we need to prepare coins once and split multiple times
    let primaryCoinInput: TransactionObjectArgument | undefined;
    if (!isNative) {
      const coins = await SuiPlatform.getCoins(this.provider, sender, coinType);
      const [primaryCoin, ...mergeCoins] = coins.filter((coin) =>
        isSameType(coin.coinType, coinType)
      );
      if (primaryCoin === undefined) {
        throw new Error(
          `Coins array doesn't contain any coins of type ${coinType}`
        );
      }
      primaryCoinInput = tx.object(primaryCoin.coinObjectId);
      if (mergeCoins.length) {
        tx.mergeCoins(
          primaryCoinInput,
          mergeCoins.map((coin) => tx.object(coin.coinObjectId))
        );
      }
    }

    // Split coins for transfer amount
    const [coin] = isNative
      ? tx.splitCoins(tx.gas, [tx.pure.u64(quote.remainingAmount)])
      : tx.splitCoins(primaryCoinInput!, [tx.pure.u64(quote.remainingAmount)]);

    // Create VersionGated object
    const [versionGated] = tx.moveCall({
      target: `${packageId}::upgrades::new_version_gated`,
      arguments: [],
    });

    // Prepare the transfer
    const [ticket, dust] = tx.moveCall({
      target: `${packageId}::ntt::prepare_transfer`,
      typeArguments: [coinType],
      arguments: [
        tx.object(managerStateId),
        coin,
        tx.object(coinMetadataId),
        tx.pure.u16(destinationChainId),
        tx.pure.vector("u8", Array.from(destinationAddressBytes)),
        tx.pure.option("vector<u8>", null),
        tx.pure.bool(false),
      ],
    });

    // Get source chain info
    const [sourceChain] = tx.moveCall({
      target: `${packageId}::state::get_chain_id`,
      typeArguments: [coinType],
      arguments: [tx.object(managerStateId)],
    });

    // Get next sequence number
    const [sequenceBytes32] = tx.moveCall({
      target: `${packageId}::state::get_next_sequence`,
      typeArguments: [coinType],
      arguments: [tx.object(managerStateId)],
    });

    const coreBridgePackageId = await getWormholePackageId(
      this.provider,
      this.coreBridgeStateId
    );

    // Convert sequence bytes32 to Sui object
    const [sequence] = tx.moveCall({
      target: `${coreBridgePackageId}::bytes32::to_bytes`,
      arguments: [sequenceBytes32 as any],
    });

    // Execute the transfer
    tx.moveCall({
      target: `${packageId}::ntt::transfer_tx_sender`,
      typeArguments: [coinType],
      arguments: [
        tx.object(managerStateId),
        versionGated as any,
        tx.object(coinMetadataId),
        ticket as any,
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });

    // Create transceiver message
    const [transceiverMessage] = tx.moveCall({
      target: `${packageId}::state::create_transceiver_message`,
      typeArguments: [
        `${transceiverId}::wormhole_transceiver::TransceiverAuth`,
        coinType,
      ],
      arguments: [
        tx.object(managerStateId),
        sequenceBytes32 as any,
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });

    // Release outbound message
    const [messageTicket] = tx.moveCall({
      target: `${transceiverId}::wormhole_transceiver::release_outbound`,
      typeArguments: [`${packageId}::auth::ManagerAuth`],
      arguments: [tx.object(transceiverStateId), transceiverMessage as any],
    });

    // Split fee coin for publishing message
    const [feeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(0n)]);

    // Publish message to Wormhole
    tx.moveCall({
      target: `${coreBridgePackageId}::publish_message::publish_message`,
      arguments: [
        tx.object(this.coreBridgeStateId),
        feeCoin,
        messageTicket as any,
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });

    // Handle dust by converting back to coin and merging with gas if native or back to sender otherwise
    const [dustCoin] = tx.moveCall({
      target: `0x2::coin::from_balance`,
      typeArguments: [coinType],
      arguments: [dust as any],
    });

    if (isNative) {
      tx.mergeCoins(tx.gas, [dustCoin as any]);
    } else {
      tx.transferObjects(
        [dustCoin as any],
        `0x${Buffer.from(sender.address).toString("hex")}`
      );
    }

    // Handle referrer fee if present
    if (quote.referrerFee > 0n) {
      // Convert referrer address to Sui address format
      const referrerAddress = `0x${Buffer.from(
        quote.referrer.address.toUint8Array()
      ).toString("hex")}`;

      // Split coins for referrer fee from the same source
      const [referrerCoin] = isNative
        ? tx.splitCoins(tx.gas, [tx.pure.u64(quote.referrerFee)])
        : tx.splitCoins(primaryCoinInput!, [tx.pure.u64(quote.referrerFee)]);

      // Transfer the referrer fee
      tx.transferObjects([referrerCoin], referrerAddress);
    }

    // Convert manager state ID to bytes
    const managerStateBytes = Buffer.from(managerStateId.substring(2), "hex");

    // Make NTT v1 request
    const [requestBytes] = tx.moveCall({
      target: `${this.executorRequestsId}::executor_requests::make_ntt_v1_request`,
      arguments: [
        sourceChain as any,
        tx.pure.vector("u8", managerStateBytes),
        sequence as any,
      ],
    });

    // Split coins for executor fee
    const [executorCoin] = tx.splitCoins(tx.gas, [
      tx.pure.u64(quote.estimatedCost),
    ]);

    // Handle destination address for Solana and other chains
    let destinationAddress: string;
    if (destination.chain === "Solana") {
      const destAddrString = destination.address.toString();
      const pubkey = new PublicKey(destAddrString);
      destinationAddress = `0x${pubkey.toBuffer().toString("hex")}`;
    } else {
      destinationAddress = destination.address.toString();
      if (!destinationAddress.startsWith("0x")) {
        destinationAddress = `0x${destinationAddress}`;
      }
    }

    // Get destination manager address from NTT peer
    let destinationManagerAddress: string | undefined;
    const peer = (await ntt.getPeer(destination.chain))?.address;
    if (peer) {
      destinationManagerAddress = peer.address.toString();
    }

    let executorDestAddress: string;
    if (destinationManagerAddress) {
      executorDestAddress = destinationManagerAddress;
    } else {
      executorDestAddress = destinationAddress;
    }

    // Call request_execution on the executor
    tx.moveCall({
      target: `${this.executorId}::executor::request_execution`,
      arguments: [
        executorCoin, // payment for execution
        tx.object(SUI_CLOCK_OBJECT_ID),
        tx.pure.u16(destinationChainId), // destination chain
        tx.pure.address(executorDestAddress), // destination manager address
        tx.pure.address(
          typeof sender === "string"
            ? sender
            : `0x${Array.from(sender.address || [])
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("")}`
        ), // payer address
        tx.pure.vector("u8", Array.from(quote.signedQuote)),
        requestBytes as any,
        tx.pure.vector("u8", Array.from(quote.relayInstructions)),
      ],
    });

    return tx;
  }

  async estimateMsgValueAndGasLimit(
    recipient: ChainAddress | undefined
  ): Promise<{ msgValue: bigint; gasLimit: bigint }> {
    // Message value should be 0 for Sui executor
    let msgValue = 0n;

    // Gas limit here is an estimate based on the complexity of our operations
    const gasLimit = 20_000_000n;

    return { msgValue, gasLimit };
  }

  // Helper function to get supported destination chains
  getSupportedDestinationChains(): Chain[] {
    // Sui executor supports Solana and EVM chains
    return [
      "Solana",
      "Ethereum",
      "Bsc",
      "Polygon",
      "Avalanche",
      "Arbitrum",
      "Optimism",
      "Base",
    ] as Chain[];
  }
}
