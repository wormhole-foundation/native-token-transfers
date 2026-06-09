import type {
  WormholeConfigOverrides,
  Network,
} from "@wormhole-foundation/sdk-connect";
import { chains, toChainId, type Chain } from "@wormhole-foundation/sdk";
import { decodeAccountID } from "ripple-address-codec";
import { padHex, toHex } from "viem";
import { Buffer } from "node:buffer";

import { colors } from "../colors.js";
import { xrplOptions } from "../xrpl/options.js";
import {
  computeEmitterAddress,
  tokenIdFromFlags,
  tokenIdFromXrplAmount,
  formatTokenId,
  type TokenId,
} from "../xrpl/tokenId.js";
import { parsePayload, parseVaa } from "../xrpl/payloads.js";
import { getXrplWallet, withXrplClient } from "../xrpl/client.js";
import { CHAIN_ID_XRPL, pollSignedVaa } from "../xrpl/guardian.js";
import { fetchQuote, submitStatusTx } from "../xrpl/executor.js";
import {
  RequestPrefix,
  buildGasInstructionHex,
  deserializeSignedQuote,
  deserializeRelayInstructions,
  serializeRequestForExecution,
  type RequestForExecution,
  type RequestLayout,
} from "../xrpl/executorLayouts.js";

/** Accept an r-address or 20-byte hex and return the 20-byte account ID. */
function accountIdFrom(addr: string): Buffer {
  if (addr.startsWith("r")) {
    return Buffer.from(decodeAccountID(addr));
  }
  const hex = addr.replace(/^0x/, "");
  if (hex.length !== 40) {
    throw new Error(
      `Expected an r-address or 20-byte hex (40 chars), got "${addr}"`,
    );
  }
  return Buffer.from(hex, "hex");
}

/** Resolve a --dst-chain value (name or numeric id) to a Wormhole chain id. */
function resolveChainId(value: string | number): number {
  if (typeof value === "number") return value;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return toChainId(value as Chain);
}

function hexToBuffer(input: string): Buffer {
  let s = input.trim();
  if (s.startsWith("0x") || s.startsWith("0X")) s = s.slice(2);
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2 !== 0) {
    throw new Error("Invalid hex input");
  }
  return Buffer.from(s, "hex");
}

export function createXrplCommand(_overrides: WormholeConfigOverrides<Network>) {
  return {
    command: "xrpl",
    describe: "XRPL NTT operations",
    builder: (yargs: any) => {
      return (
        yargs
          // ── emitter ───────────────────────────────────────────────────
          .command(
            "emitter",
            "Compute the XRPL transceiver emitter address for a manager + token (no tx)",
            (y: any) =>
              y
                .option("manager", {
                  ...xrplOptions.manager,
                  demandOption: true,
                })
                .option("token", { ...xrplOptions.token, demandOption: true })
                .option("currency", xrplOptions.currency)
                .option("issuer", xrplOptions.issuer)
                .option("mpt-id", xrplOptions.mptId)
                .example(
                  "$0 xrpl emitter --manager rfeMQr71KJQwNUbRwGTgCfVLoUVdWuvyny --token xrp",
                  "Emitter for an XRP custody account",
                )
                .example(
                  "$0 xrpl emitter --manager rnv8... --token iou --currency FOO --issuer rnv8...",
                  "Emitter for an IOU deployment",
                ),
            (argv: any) => {
              const token: TokenId = tokenIdFromFlags({
                type: argv["token"],
                currency: argv["currency"],
                issuer: argv["issuer"],
                mptId: argv["mpt-id"],
              });
              const accountId = accountIdFrom(argv["manager"]);
              const emitter = computeEmitterAddress(accountId, token);
              const hex = emitter.toString("hex");

              console.log(colors.blue("🧮 XRPL transceiver emitter"));
              console.log(`  manager: ${colors.yellow(argv["manager"])}`);
              console.log(`  token:   ${colors.yellow(formatTokenId(token))}`);
              console.log(`  emitter: ${colors.green(hex)}`);
              console.log(`  0x form: ${colors.green("0x" + hex)}`);
              console.log(
                colors.dim(
                  "\nUse this with `ntt manual set-transceiver-peer Xrpl 0x… --chain <other>`",
                ),
              );
            },
          )
          // ── parse-vaa ─────────────────────────────────────────────────
          .command(
            "parse-vaa <vaa>",
            "Decode an XRPL-Wormhole VAA (XREL/XRFL/XADM/onboarding) — no tx",
            (y: any) =>
              y
                .positional("vaa", {
                  describe: "Hex VAA bytes (with or without 0x), or --payload-only",
                  type: "string",
                  demandOption: true,
                })
                .option("payload-only", {
                  describe: "Treat the input as a bare payload (not a full VAA)",
                  type: "boolean",
                  default: false,
                })
                .example(
                  "$0 xrpl parse-vaa 01000000... ",
                  "Decode a full VAA and its XRPL payload",
                ),
            (argv: any) => {
              const bytes = hexToBuffer(argv["vaa"]);

              if (argv["payload-only"]) {
                const parsed = parsePayload(bytes);
                console.log(colors.blue("📦 Payload"));
                console.log(JSON.stringify(parsed, bigintReplacer, 2));
                return;
              }

              const vaa = parseVaa(bytes);
              console.log(colors.blue("✉️  VAA envelope"));
              console.log(`  version:         ${vaa.version}`);
              console.log(`  guardianSetIndex:${vaa.guardianSetIndex}`);
              console.log(`  signatures:      ${vaa.signatures.length}`);
              console.log(`  emitterChain:    ${vaa.emitterChain}`);
              console.log(`  emitterAddress:  ${vaa.emitterAddress}`);
              console.log(`  sequence:        ${vaa.sequence}`);
              console.log(`  consistency:     ${vaa.consistencyLevel}`);
              console.log(colors.blue("\n📦 Payload"));
              const parsed = parsePayload(vaa.payload);
              console.log(JSON.stringify(parsed, bigintReplacer, 2));
            },
          )
          // ── relay ─────────────────────────────────────────────────────
          .command(
            "relay",
            "Relay a VAA emitted by an XRPL tx to the destination via the Executor",
            (y: any) =>
              y
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
                  choices: ["ern1", "erv1"],
                  default: "ern1",
                })
                .option("dst-addr", {
                  describe:
                    "Destination address (hex32). For ERN1 this is the recipient NTT manager.",
                  type: "string",
                })
                .option("src-manager", {
                  describe: "ERN1: source NTT manager emitter (hex32). Default: derived.",
                  type: "string",
                })
                .option("manager", xrplOptions.manager)
                .option("token", xrplOptions.token)
                .option("currency", xrplOptions.currency)
                .option("issuer", xrplOptions.issuer)
                .option("mpt-id", xrplOptions.mptId)
                .option("executor", { ...xrplOptions.executor, demandOption: true })
                .option("executor-api", xrplOptions.executorApi)
                .option("guardian-api", xrplOptions.guardianApi)
                .option("rpc", xrplOptions.rpc)
                .option("seed", xrplOptions.seed)
                .option("ed25519", xrplOptions.ed25519)
                .option("gas-limit", xrplOptions.gasLimit)
                .option("msg-value", xrplOptions.msgValue)
                .option("relay-instructions", xrplOptions.relayInstructions)
                .option("poll-interval", xrplOptions.pollInterval)
                .option("poll-timeout", xrplOptions.pollTimeout)
                .example(
                  "$0 xrpl relay --tx-hash <hash> --dst-chain Solana --executor r… --request-type ern1 --src-manager 0x… --dst-addr 0x…",
                  "Relay an NTT transfer from XRPL to Solana",
                ),
            async (argv: any) => {
              try {
                await runRelay(argv);
              } catch (e) {
                console.error(colors.red("\n❌ relay failed:"));
                console.error(e instanceof Error ? e.message : String(e));
                process.exit(1);
              }
            },
          )
          .demandCommand()
      );
    },
    handler: (_argv: any) => {},
  };
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

async function runRelay(argv: any): Promise<void> {
  const txHash: string = argv["tx-hash"];
  const dstChain = resolveChainId(argv["dst-chain"]);
  const requestType: "ern1" | "erv1" = argv["request-type"];
  const executor: string = argv["executor"];
  const executorApi: string = argv["executor-api"];
  const guardianApi: string = argv["guardian-api"];
  const rpc: string = argv["rpc"];
  const gasLimit = BigInt(argv["gas-limit"]);
  const msgValue = BigInt(argv["msg-value"]);
  const pollInterval = argv["poll-interval"];
  const pollTimeout = argv["poll-timeout"];

  const wallet = getXrplWallet(argv["seed"], !argv["ed25519"]);

  console.log(colors.blue("🚚 XRPL relay"));
  console.log(`  tx hash:      ${colors.yellow(txHash)}`);
  console.log(`  dst chain:    ${colors.yellow(String(dstChain))}`);
  console.log(`  request type: ${colors.yellow(requestType)}`);
  console.log(`  from wallet:  ${colors.yellow(wallet.address)}`);

  // ── 1. Look up the XRPL tx → emitter + sequence (messageId) + token ──
  const { emitterHex, sequence } = await withXrplClient(rpc, async (client) => {
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
    if (argv["token"]) {
      token = tokenIdFromFlags({
        type: argv["token"],
        currency: argv["currency"],
        issuer: argv["issuer"],
        mptId: argv["mpt-id"],
      });
    } else if (deliveredAmount) {
      token = tokenIdFromXrplAmount(deliveredAmount);
    } else {
      token = { type: "XRP" };
    }

    const emitter = computeEmitterAddress(
      Buffer.from(decodeAccountID(destination)),
      token,
    );
    const sequence = (BigInt(ledgerIndex) << 32n) | BigInt(txIndex);
    return { emitterHex: emitter.toString("hex"), sequence };
  });

  const messageId = padHex(`0x${sequence.toString(16)}`, {
    dir: "left",
    size: 32,
  });
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
    onAttempt: (n, url) =>
      console.log(colors.dim(`  attempt ${n}: ${url}`)),
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
    dstChain,
    emitterHex,
    sequence,
    messageId,
    srcManager: argv["src-manager"],
    manager: argv["manager"],
  });

  const dstAddr = padHex(
    (argv["dst-addr"] as `0x${string}` | undefined) ??
      // ERV1 default: target the destination contract via dst-addr; require it for ERN1.
      requireDstAddr(requestType, argv["dst-addr"]),
    { dir: "left", size: 32 },
  );

  const refundAddr = toHex(decodeAccountID(wallet.classicAddress));

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

  const memoTxHash = await withXrplClient(rpc, async (client) => {
    const prepared = await client.autofill({
      TransactionType: "Payment",
      Account: wallet.address,
      Destination: executor,
      Amount: quote.estimatedCost,
      Memos: [{ Memo: { MemoFormat: memoFormat, MemoData: memoData } }],
    });
    const signed = wallet.sign(prepared);
    console.log(`  tx hash: ${colors.yellow(signed.hash)}`);
    const result = await client.submitAndWait(signed.tx_blob);
    const m = result.result.meta;
    const txResult = typeof m === "object" ? (m as any)?.TransactionResult : m;
    if (txResult !== "tesSUCCESS") {
      throw new Error(`Executor request payment failed: ${txResult}`);
    }
    return signed.hash;
  });
  console.log(colors.green("  tesSUCCESS"));

  // ── 6. Trigger executor indexing + report status ──
  console.log(colors.blue("\n📡 Notifying executor (/v0/status/tx)..."));
  const status = await submitStatusTx({
    executorApi,
    chainId: CHAIN_ID_XRPL,
    txHash: memoTxHash,
  });
  console.log(JSON.stringify(status, bigintReplacer, 2));

  console.log(colors.green("\n✅ relay dispatched"));
  console.log(`  request tx: ${memoTxHash}`);
  console.log(
    colors.dim(
      "Acks back to the Sequencer (XACK/XTCF/XBRN) are handled automatically by the executor's XRPL poller.",
    ),
  );
}

function requireDstAddr(
  requestType: string,
  dstAddr: string | undefined,
): `0x${string}` {
  if (!dstAddr) {
    throw new Error(
      `--dst-addr is required for ${requestType} (the destination ${requestType === "ern1" ? "NTT manager" : "contract"})`,
    );
  }
  return dstAddr as `0x${string}`;
}

function buildRequest(opts: {
  requestType: "ern1" | "erv1";
  dstChain: number;
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
        address: `0x${opts.emitterHex}`,
        sequence: opts.sequence,
      },
    };
  }
  // ERN1: srcManager is the source NTT manager emitter (32 bytes).
  const srcManager =
    opts.srcManager ??
    (opts.manager
      ? "0x" +
        padHex(toHex(accountIdFrom(opts.manager)), { dir: "left", size: 32 }).slice(2)
      : undefined);
  if (!srcManager) {
    throw new Error(
      "ERN1 relay requires --src-manager (hex32) or --manager (rAddress) to derive it",
    );
  }
  return {
    request: {
      prefix: RequestPrefix.ERN1,
      srcChain: CHAIN_ID_XRPL,
      srcManager: padHex(srcManager as `0x${string}`, { dir: "left", size: 32 }),
      messageId: opts.messageId,
    },
  };
}
