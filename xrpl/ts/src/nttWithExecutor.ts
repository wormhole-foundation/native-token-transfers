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
  UnsignedTransaction,
} from "@wormhole-foundation/sdk-definitions";
import { Ntt, NttWithExecutor } from "@wormhole-foundation/sdk-definitions-ntt";
import {
  XrplChains,
  XrplPlatform,
  XrplPlatformType,
  XrplUnsignedTransaction,
} from "@wormhole-foundation/sdk-xrpl";
import { Client, SubmittableTransaction, decodeAccountID } from "xrpl";
import { executorRequestLayout, requestForExecutionLayout } from "./layouts.js";
import { XrplNtt } from "./ntt.js";
import {
  buildNttPayment,
  toXrplAddress,
  xrplAddressToUniversalBytes,
} from "./utils.js";

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
    const { payment: nttPayment, recipientManagerAddress } =
      await buildNttPayment({
        sender,
        amount,
        destination,
        contracts: this.contracts,
        getTokenDecimals: () => ntt.getTokenDecimals(),
      });

    yield new XrplUnsignedTransaction(
      nttPayment,
      this.network,
      this.chain,
      "NTT transfer"
    ) as unknown as UnsignedTransaction<N, C>;

    // After the NTT payment is submitted and confirmed, look up the result
    // to compute the messageId = (ledgerIndex << 32) | txIndex
    if (!this.provider.isConnected()) {
      await this.provider.connect();
    }
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

    // account_tx response shape varies by API version:
    // v1: { tx: { ledger_index, ... }, meta: { TransactionIndex, ... } }
    // v2: { tx_json: { ledger_index, ... }, meta: { TransactionIndex, ... }, ledger_index }
    const entry = lastTx as any;
    const ledgerIndex =
      entry.ledger_index ??
      entry.tx_json?.ledger_index ??
      entry.tx?.ledger_index;
    const txIndex = (entry.meta as any)?.TransactionIndex;

    if (ledgerIndex === undefined || txIndex === undefined) {
      throw new Error(
        `Could not determine ledgerIndex or txIndex from NTT transfer result. ` +
          `Keys: ${Object.keys(entry).join(", ")}, ` +
          `meta keys: ${typeof entry.meta === "object" ? Object.keys(entry.meta).join(", ") : "N/A"}`
      );
    }

    // messageId = (ledgerIndex << 32) | txIndex
    const messageId = (BigInt(ledgerIndex) << 32n) | BigInt(txIndex);

    // Build the ERN1 requestBytes
    // Manager address may be a universal hex string or a native r-address
    const srcManager = xrplAddressToUniversalBytes(
      this.contracts.ntt!["manager"]
    );

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

    // The payee address is a 32-byte universal address; convert to r-address
    const payeeAddress = toXrplAddress(
      encoding.hex.encode(new Uint8Array(quote.payeeAddress))
    );

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

    yield new XrplUnsignedTransaction(
      executorPayment,
      this.network,
      this.chain,
      "Executor request"
    ) as unknown as UnsignedTransaction<N, C>;
  }

  async estimateMsgValueAndGasLimit(
    _recipient: ChainAddress | undefined
  ): Promise<{ msgValue: bigint; gasLimit: bigint }> {
    return { msgValue: 0n, gasLimit: 0n };
  }
}
