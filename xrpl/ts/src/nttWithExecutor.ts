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
import {
  Client,
  SubmittableTransaction,
  decodeAccountID,
  type AccountTxTransaction,
  type Payment,
} from "xrpl";
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

    if (!this.provider.isConnected()) {
      await this.provider.connect();
    }
    const senderAddr = sender.toString();

    // The memo data uniquely identifies the payment we yielded (XRPL stores
    // memo fields as uppercase hex). nttPayment is a Payment with one memo.
    const yieldedPayment = nttPayment as Payment;
    const expectedMemoData =
      yieldedPayment.Memos?.[0]?.Memo?.MemoData?.toUpperCase();
    const expectedDestination = yieldedPayment.Destination;

    const accountTx = await this.provider.request({
      command: "account_tx",
      account: senderAddr,
      limit: 20,
      forward: false,
    });

    // account_tx response shape varies by API version: the transaction body is
    // under `tx_json` (v2) or `tx` (v1); both are typed as Transaction.
    const txBody = (entry: AccountTxTransaction): Payment | undefined => {
      const body = entry.tx_json ?? entry.tx;
      return body?.TransactionType === "Payment" ? body : undefined;
    };

    const match = accountTx.result.transactions.find((entry) => {
      const body = txBody(entry);
      if (!body) return false;
      if (expectedDestination && body.Destination !== expectedDestination)
        return false;
      const memoData = body.Memos?.[0]?.Memo?.MemoData?.toUpperCase();
      return (
        expectedMemoData !== undefined &&
        memoData === expectedMemoData &&
        typeof entry.meta !== "string"
      );
    });

    if (!match) {
      throw new Error(
        "Could not locate the submitted NTT transfer transaction in the " +
          "sender's recent account transactions"
      );
    }

    // `ledger_index` is on the entry directly; `meta` is the validated
    // TransactionMetadata (string form already excluded by the match above).
    const ledgerIndex = match.ledger_index;
    const meta = match.meta;
    const txIndex =
      typeof meta !== "string" ? meta?.TransactionIndex : undefined;

    if (ledgerIndex === undefined || txIndex === undefined) {
      throw new Error(
        "Could not determine ledgerIndex or txIndex from NTT transfer result"
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
