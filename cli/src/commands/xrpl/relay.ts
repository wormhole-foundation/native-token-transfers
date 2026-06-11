import type {
  Network,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk-connect";
import { toChainId, type Chain } from "@wormhole-foundation/sdk";
import { ethers } from "ethers";
import { decodeAccountID } from "xrpl";
import { colors } from "../../colors.js";
import {
  loadSeed,
  resolveXrplEndpoint,
  runXrpl,
  submitTx,
  walletFromSeed,
  withXrplClient,
} from "../../xrpl/helpers";
import { DEFAULT_EXECUTOR_API, fetchQuote, submitStatusTx } from "../../xrpl/executor";
import { CHAIN_ID_XRPL, DEFAULT_GUARDIAN_API, pollSignedVaa } from "../../xrpl/guardian";
import {
  RequestPrefix,
  buildGasInstructionHex,
  deserializeRelayInstructions,
  deserializeSignedQuote,
  serializeRequestForExecution,
  type RequestForExecution,
  type RequestLayout,
} from "../../xrpl/executorLayouts";
import {
  accountIdFrom,
  computeEmitterAddress,
  tokenIdFromFlags,
  tokenIdFromXrplAmount,
  type TokenId,
} from "../../xrpl/tokenId";
import { withCommon } from "./common";

/** Resolve a --dst-chain value (name or numeric id) to a Wormhole chain id. */
function resolveChainId(value: string | number): number {
  if (typeof value === "number") return value;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return toChainId(value as Chain);
}

function buildRequest(opts: {
  requestType: "ern1" | "erv1";
  emitterHex: string;
  sequence: bigint;
  messageId: `0x${string}`;
  srcManager?: string;
  manager?: string;
}): RequestLayout {
  if (opts.requestType === "erv1") {
    return {
      request: {
        prefix: RequestPrefix.ERV1,
        chain: CHAIN_ID_XRPL,
        address: `0x${opts.emitterHex}` as `0x${string}`,
        sequence: opts.sequence,
      },
    };
  }
  // ERN1: srcManager is the source NTT manager emitter (32 bytes).
  const srcManager =
    opts.srcManager ??
    (opts.manager
      ? ethers.zeroPadValue(ethers.hexlify(accountIdFrom(opts.manager)), 32)
      : undefined);
  if (!srcManager) {
    throw new Error(
      "ERN1 relay requires --src-manager (hex32) or --manager (rAddress) to derive it"
    );
  }
  return {
    request: {
      prefix: RequestPrefix.ERN1,
      srcChain: CHAIN_ID_XRPL,
      srcManager: ethers.zeroPadValue(srcManager as `0x${string}`, 32) as `0x${string}`,
      messageId: opts.messageId,
    },
  };
}

export function createXrplRelayCommand(
  overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "relay",
    describe:
      "Relay a VAA emitted by an XRPL tx to the destination via the Executor",
    builder: (yargs: any) =>
      withCommon(yargs)
        .option("tx-hash", {
          describe: "XRPL transaction hash that emitted the VAA",
          type: "string",
          demandOption: true,
        })
        .option("dst-chain", {
          describe:
            "Destination chain (name or id). NTT: the other chain. Onboarding/peer: Solana.",
          type: "string",
          demandOption: true,
        })
        .option("request-type", {
          describe:
            "ern1 (NTT transfer) or erv1 (onboarding/register-peer → Sequencer)",
          type: "string",
          choices: ["ern1", "erv1"] as const,
          default: "ern1",
        })
        .option("dst-addr", {
          describe:
            "Destination address (hex32). For ERN1 this is the recipient NTT manager.",
          type: "string",
        })
        .option("src-manager", {
          describe:
            "ERN1: source NTT manager emitter (hex32). Default: derived from --manager.",
          type: "string",
        })
        .option("manager", {
          describe:
            "XRPL NTT manager / custody account (r-address or 20-byte hex)",
          type: "string",
        })
        .option("token", {
          describe: "XRPL token type (default: inferred from the tx amount)",
          type: "string",
          choices: ["xrp", "iou", "mpt"] as const,
        })
        .option("currency", {
          describe: "IOU currency: 3-4 char ASCII or 40-char hex [--token iou]",
          type: "string",
        })
        .option("issuer", {
          describe: "IOU issuer r-address [--token iou]",
          type: "string",
        })
        .option("mpt-id", {
          describe: "MPT issuance ID, 48-char hex [--token mpt]",
          type: "string",
        })
        .option("executor", {
          describe: "Executor XRPL address to send the request payment to",
          type: "string",
          demandOption: true,
        })
        .option("executor-api", {
          describe: "Executor API base URL",
          type: "string",
          default: DEFAULT_EXECUTOR_API,
        })
        .option("guardian-api", {
          describe: "Guardian / Wormholescan API base URL",
          type: "string",
          default: DEFAULT_GUARDIAN_API,
        })
        .option("gas-limit", {
          describe: "Relay gas limit",
          type: "string",
          default: "250000",
        })
        .option("msg-value", {
          describe: "Relay msg value (drops)",
          type: "string",
          default: "0",
        })
        .option("relay-instructions", {
          describe:
            "Pre-encoded relay instructions hex (overrides --gas-limit/--msg-value)",
          type: "string",
        })
        .option("poll-interval", {
          describe: "VAA poll interval (ms)",
          type: "number",
          default: 5_000,
        })
        .option("poll-timeout", {
          describe: "VAA poll timeout (ms)",
          type: "number",
          default: 120_000,
        })
        .option("seed", {
          describe: "XRPL seed of the relaying account (or env SEED)",
          type: "string",
        })
        .example(
          "$0 xrpl relay --tx-hash <hash> --dst-chain Solana --executor r… --request-type ern1 --src-manager 0x… --dst-addr 0x…",
          "Relay an NTT transfer from XRPL to Solana"
        ),
    handler: (argv: any) => runXrpl(() => runRelay(argv, overrides)),
  };
}

async function runRelay(
  argv: any,
  overrides: WormholeConfigOverrides<Network>
): Promise<void> {
  const network = argv.network as Network;
  const endpoint = resolveXrplEndpoint(network, argv.rpc, overrides);
  const txHash: string = argv["tx-hash"];
  const dstChain = resolveChainId(argv["dst-chain"]);
  const requestType: "ern1" | "erv1" = argv["request-type"];
  const executor: string = argv.executor;
  const executorApi: string = argv["executor-api"];
  const guardianApi: string = argv["guardian-api"];
  const gasLimit = BigInt(argv["gas-limit"]);
  const msgValue = BigInt(argv["msg-value"]);
  const pollInterval = argv["poll-interval"];
  const pollTimeout = argv["poll-timeout"];

  const seed = loadSeed(argv.seed, "seed", "SEED");
  const wallet = walletFromSeed(seed, argv.algorithm);

  console.log(colors.blue("🚚 XRPL relay"));
  console.log(`  tx hash:      ${colors.yellow(txHash)}`);
  console.log(`  dst chain:    ${colors.yellow(String(dstChain))}`);
  console.log(`  request type: ${colors.yellow(requestType)}`);
  console.log(`  from wallet:  ${colors.yellow(wallet.address)}`);

  // ── 1. Look up the XRPL tx → emitter + sequence (messageId) + token ──
  const { emitterHex, sequence } = await withXrplClient(endpoint, async (client) => {
    const resp = await client.request({ command: "tx", transaction: txHash });
    const tx: any = resp.result;
    const ledgerIndex = tx.ledger_index;
    if (!ledgerIndex) throw new Error("Transaction not validated (no ledger_index)");
    const meta = tx.meta ?? tx.metaData;
    if (typeof meta !== "object" || meta === null || !("TransactionIndex" in meta)) {
      throw new Error("Transaction metadata missing TransactionIndex");
    }
    const txIndex = (meta as any).TransactionIndex as number;

    // Destination = custody account; delivered_amount → token (for emitter derivation)
    const destination: string | undefined =
      tx.Destination ?? tx.tx_json?.Destination;
    if (!destination) throw new Error("Could not determine destination/custody address");

    const deliveredAmount = (meta as any).delivered_amount;
    let token: TokenId;
    if (argv.token) {
      token = tokenIdFromFlags({
        type: argv.token,
        currency: argv.currency,
        issuer: argv.issuer,
        mptId: argv["mpt-id"],
      });
    } else if (deliveredAmount) {
      token = tokenIdFromXrplAmount(deliveredAmount);
    } else {
      token = { type: "XRP" };
    }

    const emitter = computeEmitterAddress(
      Buffer.from(decodeAccountID(destination)),
      token
    );
    const sequence = (BigInt(ledgerIndex) << 32n) | BigInt(txIndex);
    return { emitterHex: emitter.toString("hex"), sequence };
  });

  const messageId = ethers.toBeHex(sequence, 32) as `0x${string}`;
  console.log(`  emitter:      ${colors.gray(emitterHex)}`);
  console.log(`  sequence:     ${colors.gray(sequence.toString())}`);

  // ── 2. Poll the guardian API for the signed VAA ──
  console.log(colors.blue("\n⏳ Waiting for guardian VAA..."));
  await pollSignedVaa({
    guardianApi,
    chain: CHAIN_ID_XRPL,
    emitterHex,
    sequence,
    pollIntervalMs: pollInterval,
    pollTimeoutMs: pollTimeout,
    onAttempt: (n, url) => console.log(colors.dim(`  attempt ${n}: ${url}`)),
  });
  console.log(colors.green("  VAA available."));

  // ── 3. Fetch a quote ──
  const relayInstructions =
    (argv["relay-instructions"] as `0x${string}` | undefined) ??
    buildGasInstructionHex(gasLimit, msgValue);

  console.log(colors.blue("\n💱 Fetching executor quote..."));
  const quote = await fetchQuote({
    executorApi,
    srcChain: CHAIN_ID_XRPL,
    dstChain,
    relayInstructions,
  });
  console.log(`  estimated cost: ${colors.yellow(quote.estimatedCost)} drops`);

  // ── 4. Build the request + RequestForExecution ──
  const request = buildRequest({
    requestType,
    emitterHex,
    sequence,
    messageId,
    srcManager: argv["src-manager"],
    manager: argv.manager,
  });

  if (!argv["dst-addr"]) {
    throw new Error(
      `--dst-addr is required (the destination ${requestType === "ern1" ? "NTT manager" : "contract"})`
    );
  }
  const dstAddr = ethers.zeroPadValue(
    argv["dst-addr"] as `0x${string}`,
    32
  ) as `0x${string}`;

  const refundAddr = ethers.hexlify(
    decodeAccountID(wallet.classicAddress)
  ) as `0x${string}`;

  const rfe: RequestForExecution = {
    payload: {
      version: 0,
      dstChain,
      dstAddr,
      refundAddr,
      signedQuote: deserializeSignedQuote(quote.signedQuote),
      requestBytes: request,
      relayInstructions: deserializeRelayInstructions(relayInstructions),
    },
  };

  const serialized = serializeRequestForExecution(rfe);

  // ── 5. Submit the XRPL Payment carrying the executor-request memo ──
  console.log(colors.blue("\n📤 Submitting executor request payment..."));
  const memoFormat = Buffer.from("application/x-executor-request")
    .toString("hex")
    .toUpperCase();
  const memoData = serialized.slice(2).toUpperCase();

  const result = await withXrplClient(endpoint, (client) =>
    submitTx(client, wallet, {
      TransactionType: "Payment",
      Account: wallet.address,
      Destination: executor,
      Amount: quote.estimatedCost,
      Memos: [{ Memo: { MemoFormat: memoFormat, MemoData: memoData } }],
    })
  );
  const memoTxHash = result.result.hash;
  console.log(colors.green("  tesSUCCESS"));
  console.log(`  tx hash: ${colors.yellow(memoTxHash)}`);

  // ── 6. Trigger executor indexing + report status ──
  console.log(colors.blue("\n📡 Notifying executor (/v0/status/tx)..."));
  const status = await submitStatusTx({
    executorApi,
    chainId: CHAIN_ID_XRPL,
    txHash: memoTxHash,
  });
  console.log(
    JSON.stringify(
      status,
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2
    )
  );

  console.log(colors.green("\n✅ relay dispatched"));
  console.log(`  request tx: ${memoTxHash}`);
  console.log(
    colors.dim(
      "Acks back to the Sequencer (XACK/XTCF/XBRN) are handled automatically by the executor's XRPL poller."
    )
  );
}
