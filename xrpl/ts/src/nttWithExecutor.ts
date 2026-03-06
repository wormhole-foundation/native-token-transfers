import type { Network } from "@wormhole-foundation/sdk-base";
import {
  encoding,
  serializeLayout,
  toChainId,
} from "@wormhole-foundation/sdk-base";
import {
  AccountAddress,
  ChainAddress,
  ChainsConfig,
  Contracts,
  toUniversal,
  UnsignedTransaction,
} from "@wormhole-foundation/sdk-definitions";
import { Ntt, NttWithExecutor } from "@wormhole-foundation/sdk-definitions-ntt";
import {
  XrplChains,
  XrplPlatform,
  XrplPlatformType,
} from "@wormhole-foundation/sdk-xrpl";
import {
  Client,
  SubmittableTransaction,
  decodeAccountID,
  encodeAccountID,
} from "xrpl";
import {
  nttTransferLayout,
  executorRequestLayout,
  requestForExecutionLayout,
} from "./layouts.js";
import { XrplNtt } from "./ntt.js";

export class XrplNttWithExecutor<N extends Network, C extends XrplChains>
  implements NttWithExecutor<N, C>
{
  readonly network: N;
  readonly chain: C;
  readonly provider: Client;

  constructor(
    network: N,
    chain: C,
    provider: Client,
    readonly contracts: Contracts & { ntt?: Ntt.Contracts }
  ) {
    if (!contracts.ntt) {
      throw new Error("NTT contracts not found");
    }

    this.network = network;
    this.chain = chain;
    this.provider = provider;
  }

  static async fromRpc<N extends Network>(
    provider: Client,
    config: ChainsConfig<N, XrplPlatformType>
  ): Promise<XrplNttWithExecutor<N, XrplChains>> {
    const [network, chain] = await XrplPlatform.chainFromRpc(provider);
    const conf = config[chain]!;

    if (conf.network !== network)
      throw new Error(`Network mismatch: ${conf.network} != ${network}`);

    if (!("ntt" in conf.contracts)) throw new Error("Ntt contracts not found");

    const ntt = conf.contracts["ntt"];

    return new XrplNttWithExecutor(network as N, chain, provider, {
      ...conf.contracts,
      ntt,
    });
  }

  async *transfer(
    sender: AccountAddress<C>,
    destination: ChainAddress,
    amount: bigint,
    quote: NttWithExecutor.Quote,
    ntt: XrplNtt<N, C>,
    _wrapNative: boolean = false
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    if (this.contracts.ntt!["token"] !== "native") {
      throw new Error("Not implemented for non-XRP tokens");
    }

    const peer = this.contracts.ntt!.peers?.[destination.chain];
    if (!peer) {
      throw new Error(`No peer configured for chain: ${destination.chain}`);
    }
    if (peer.tokenDecimals === undefined) {
      throw new Error("No token decimals configured for peer");
    }

    const recipientManagerAddress = toUniversal(
      destination.chain,
      peer.manager
    ).toUint8Array();

    // Convert destination address to bytes
    // TODO: do this address handling stuff properly, copied from Sui
    let destinationAddressBytes: Uint8Array;
    try {
      if (typeof destination.address.toUint8Array === "function") {
        destinationAddressBytes = destination.address.toUint8Array();
      } else if (typeof destination.address.toUniversalAddress === "function") {
        const universalAddr = destination.address.toUniversalAddress();
        if (!universalAddr) {
          throw new Error("toUniversalAddress() returned null or undefined");
        }
        destinationAddressBytes = universalAddr.toUint8Array();
      } else {
        throw new Error(
          `destination.address does not have expected methods. Type: ${typeof destination.address}`
        );
      }
    } catch (error) {
      throw new Error(
        `Failed to convert destination address to bytes: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const nttMemoData = encoding.hex.encode(
      new Uint8Array(
        serializeLayout(nttTransferLayout, {
          recipient_ntt_manager_address: recipientManagerAddress,
          recipient_address: destinationAddressBytes,
          recipient_chain: toChainId(destination.chain),
          from_decimals: await ntt.getTokenDecimals(),
          to_decimals: peer.tokenDecimals,
        })
      )
    );

    // Transaction 1: NTT transfer payment (same as manual route)
    const nttPayment: SubmittableTransaction = {
      TransactionType: "Payment",
      Account: sender.toString(),
      Destination: this.contracts.ntt!["manager"],
      Amount: amount.toString(), // XRP in drops
      Memos: [
        {
          Memo: {
            MemoFormat: encoding.hex.encode("application/x-ntt-transfer"),
            MemoData: nttMemoData,
          },
        },
      ],
    };

    yield nttPayment as unknown as UnsignedTransaction<N, C>;

    // After the NTT payment is submitted and confirmed, look up the result
    // to compute the messageId = (ledgerIndex << 32) | txIndex
    const senderAddr = sender.toString();
    const accountTx = await this.provider.request({
      command: "account_tx",
      account: senderAddr,
      limit: 1,
      forward: false,
    });

    const lastTx = accountTx.result.transactions[0];
    if (!lastTx || !lastTx.meta || typeof lastTx.meta === "string") {
      throw new Error("Could not retrieve NTT transfer transaction result");
    }

    const ledgerIndex = lastTx.tx_blob
      ? lastTx.validated
        ? (lastTx as any).ledger_index
        : undefined
      : (lastTx.tx as any)?.ledger_index;
    const txIndex = (lastTx.meta as any).TransactionIndex;

    if (ledgerIndex === undefined || txIndex === undefined) {
      throw new Error(
        "Could not determine ledgerIndex or txIndex from NTT transfer result"
      );
    }

    // messageId = (ledgerIndex << 32) | txIndex
    const messageId = (BigInt(ledgerIndex) << 32n) | BigInt(txIndex);

    // Build the ERN1 requestBytes
    const srcManager = toUniversal(
      this.chain,
      this.contracts.ntt!["manager"]
    ).toUint8Array();

    const requestBytes = new Uint8Array(
      serializeLayout(executorRequestLayout, {
        srcChain: toChainId(this.chain),
        srcManager,
        messageId,
      })
    );

    // Build the RequestForExecution envelope
    const refundAddr = decodeAccountID(senderAddr);
    const dstAddr = recipientManagerAddress;

    const executorPayload = new Uint8Array(
      serializeLayout(requestForExecutionLayout, {
        dstChain: toChainId(destination.chain),
        dstAddr,
        refundAddr,
        signedQuote: quote.signedQuote,
        requestBytes,
        relayInstructions: quote.relayInstructions,
      })
    );

    const executorMemoData = encoding.hex.encode(executorPayload);

    // The payee address from the executor quote is a 20-byte XRPL account ID
    const payeeAddress = encodeAccountID(Buffer.from(quote.payeeAddress));

    // Transaction 2: Executor request payment
    const executorPayment: SubmittableTransaction = {
      TransactionType: "Payment",
      Account: senderAddr,
      Destination: payeeAddress,
      Amount: quote.estimatedCost.toString(), // relay fee in drops
      Memos: [
        {
          Memo: {
            MemoFormat: encoding.hex.encode("application/x-executor-request"),
            MemoData: executorMemoData,
          },
        },
      ],
    };

    return executorPayment;
  }

  async estimateMsgValueAndGasLimit(
    _recipient: ChainAddress | undefined
  ): Promise<{ msgValue: bigint; gasLimit: bigint }> {
    return { msgValue: 0n, gasLimit: 0n };
  }
}
