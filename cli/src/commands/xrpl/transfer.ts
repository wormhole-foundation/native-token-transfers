import type {
  Network,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk-connect";
import {
  xrpToDrops,
  type Amount,
  type MPTAmount,
  type SubmittableTransaction,
} from "xrpl";
import { colors } from "../../colors.js";
import { loadConfig } from "../../deployments";
import {
  loadSeed,
  resolveChainId,
  resolveXrplEndpoint,
  runXrpl,
  submitTx,
  validateRAddress,
  walletFromSeed,
  withXrplClient,
} from "../../xrpl/helpers";
import { runRelay } from "./relay";
import { withCommon } from "./common";

/** NTT manager payload prefix (0x994E5454 = "\x99NTT"). */
const NTT_PREFIX = "994E5454";

/** MemoFormat used for an NTT transfer Payment to a custody account. */
const NTT_TRANSFER_MEMO_FORMAT = "application/x-ntt-transfer";

/** Normalise a hex string to a left-padded 32-byte (64 hex char) value. */
function normalizeHex32(hex: string, label: string): string {
  const clean = hex.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error(`Invalid hex for ${label}: "${hex}"`);
  }
  if (clean.length > 64) {
    throw new Error(`${label} too long: ${clean.length / 2} bytes, max 32`);
  }
  return clean.padStart(64, "0");
}

/**
 * Build the NTT transfer memo data (72 bytes, hex):
 *   prefix(4) recipient(32) sender(32) dstChain(2) trimmedDecimals(1) decimals(1)
 * Mirrors ripple/xrpl-client/src/integration/transfer.ts::buildNttMemoData.
 */
function buildNttMemoData(opts: {
  recipientHex: string;
  senderHex: string;
  dstChain: number;
  trimmedDecimals: number;
  decimals: number;
}): string {
  const recipient = normalizeHex32(opts.recipientHex, "recipient");
  const sender = normalizeHex32(opts.senderHex, "sender");
  const chain = opts.dstChain.toString(16).padStart(4, "0");
  const trimDec = opts.trimmedDecimals.toString(16).padStart(2, "0");
  const dec = opts.decimals.toString(16).padStart(2, "0");
  return `${NTT_PREFIX}${recipient}${sender}${chain}${trimDec}${dec}`.toUpperCase();
}

/** Build the XRPL Amount field for XRP, IOU, or MPT. */
function buildAmount(opts: {
  currency?: string;
  issuer?: string;
  mptIssuanceId?: string;
  amount: string;
}): Amount | MPTAmount {
  if (opts.mptIssuanceId) {
    if (opts.amount.includes(".")) {
      throw new Error(
        "MPT amounts must be integer strings (scaled by AssetScale), not decimals"
      );
    }
    return { mpt_issuance_id: opts.mptIssuanceId, value: opts.amount };
  }
  if (opts.currency && opts.issuer) {
    return { currency: opts.currency, value: opts.amount, issuer: opts.issuer };
  }
  return xrpToDrops(opts.amount);
}

/**
 * Resolve the IOU/MPT token args from `xrpl.token` in the deployment file when
 * not given explicitly. `xrpl.token` is "native" for XRP, an IOU "CODE.rIssuer",
 * or a 48-char hex MPT issuance id (see `set-token`).
 */
function resolveTokenArgs(argv: any): {
  currency?: string;
  issuer?: string;
  mptIssuanceId?: string;
} {
  if (argv.currency && argv.issuer) {
    return { currency: argv.currency, issuer: argv.issuer };
  }
  if (argv["mpt-id"]) {
    return { mptIssuanceId: argv["mpt-id"] };
  }
  const token = argv.token ?? loadConfig(argv.path).xrpl?.token;
  if (!token || token === "native") {
    return {}; // native XRP
  }
  // IOU recorded as "CODE.rIssuer".
  const dot = token.indexOf(".");
  if (dot > 0) {
    return { currency: token.slice(0, dot), issuer: token.slice(dot + 1) };
  }
  // Otherwise treat as a 48-char hex MPT issuance id.
  if (/^[0-9a-fA-F]{48}$/.test(token)) {
    return { mptIssuanceId: token };
  }
  throw new Error(
    `Could not resolve token "${token}" from the deployment file; pass --currency/--issuer or --mpt-id`
  );
}

export function createXrplTransferCommand(
  overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "transfer",
    describe:
      "Send an NTT transfer from XRPL to another chain (Payment + NTT memo), then relay it",
    builder: (yargs: any) =>
      withCommon(yargs)
        .option("custody", {
          describe:
            "XRPL custody (manager) account to send to (default: xrpl.manager)",
          type: "string",
        })
        .option("dst-chain", {
          describe: "Destination chain (Wormhole name or numeric id)",
          type: "string",
          demandOption: true,
        })
        .option("recipient", {
          describe:
            "Destination recipient NTT manager, 32-byte hex (dst-addr for the relay)",
          type: "string",
          demandOption: true,
        })
        .option("sender", {
          describe: "Your address on the destination chain, 32-byte hex",
          type: "string",
          demandOption: true,
        })
        .option("amount", {
          describe: "Amount to send (default: 0.0001 XRP/IOU, 1 MPT)",
          type: "string",
        })
        .option("decimals", {
          describe: "Token decimals (default: xrpl.decimals or 6)",
          type: "number",
        })
        .option("trimmed-decimals", {
          describe: "Trimmed decimals carried in the memo (default: decimals)",
          type: "number",
        })
        .option("token", {
          describe: '"native", an IOU "CODE.rIssuer", or a 48-hex MPT id',
          type: "string",
        })
        .option("currency", { describe: "IOU currency [IOU]", type: "string" })
        .option("issuer", { describe: "IOU issuer r-address [IOU]", type: "string" })
        .option("mpt-id", { describe: "MPT issuance id, 48-hex [MPT]", type: "string" })
        .option("seed", {
          describe: "XRPL seed of the sending wallet (or env SEED)",
          type: "string",
        })
        // ── relay control ──
        .option("relay", {
          describe: "Automatically relay the transfer after it lands",
          type: "boolean",
          default: true,
        })
        .option("executor", {
          describe: "Executor XRPL address (required unless --no-relay)",
          type: "string",
        })
        .option("gas-limit", {
          describe: "Relay gas limit",
          type: "string",
          default: "250000",
        })
        .option("msg-value", {
          describe: "Relay msg value (drops)",
          type: "string",
          default: "9705000",
        })
        .option("path", {
          describe: "Deployment file",
          type: "string",
          default: "deployment.json",
        })
        .example(
          "$0 xrpl transfer -n Testnet --dst-chain Avalanche --recipient 0x… --sender 0x… --executor r… --seed sEd7…",
          "Transfer XRP from XRPL to Avalanche and relay it"
        ),
    handler: (argv: any) => runXrpl(() => runTransfer(argv, overrides)),
  };
}

export async function runTransfer(
  argv: any,
  overrides: WormholeConfigOverrides<Network>
): Promise<void> {
  const network = argv.network as Network;
  const endpoint = resolveXrplEndpoint(network, argv.rpc, overrides);
  const seed = loadSeed(argv.seed, "seed", "SEED");
  const wallet = walletFromSeed(seed, argv.algorithm);

  const config = loadConfig(argv.path);
  const custodyArg = argv.custody || config.xrpl?.manager;
  if (!custodyArg) {
    throw new Error(
      "Provide --custody or record one with `ntt xrpl set-manager`"
    );
  }
  const custody = validateRAddress(custodyArg);
  const dstChain = resolveChainId(argv["dst-chain"]);

  const decimals: number = argv.decimals ?? config.xrpl?.decimals ?? 6;
  const trimmedDecimals: number = argv["trimmed-decimals"] ?? decimals;

  const { currency, issuer, mptIssuanceId } = resolveTokenArgs(argv);
  const isMpt = !!mptIssuanceId;
  const isIou = !isMpt && !!(currency && issuer);
  const amount: string = argv.amount ?? (isMpt ? "1" : "0.0001");

  const memoData = buildNttMemoData({
    recipientHex: argv.recipient,
    senderHex: argv.sender,
    dstChain,
    trimmedDecimals,
    decimals,
  });
  const memoFormat = Buffer.from(NTT_TRANSFER_MEMO_FORMAT, "ascii")
    .toString("hex")
    .toUpperCase();
  const paymentAmount = buildAmount({ currency, issuer, mptIssuanceId, amount });

  const tokenLabel = isMpt ? "MPT" : isIou ? currency : "XRP";
  console.log(colors.blue("💸 XRPL NTT transfer"));
  console.log(`  from:      ${colors.yellow(wallet.address)}`);
  console.log(`  custody:   ${colors.yellow(custody)}`);
  console.log(`  dst chain: ${colors.yellow(String(dstChain))}`);
  console.log(`  amount:    ${colors.yellow(`${amount} ${tokenLabel}`)}`);

  const tx: SubmittableTransaction = {
    TransactionType: "Payment",
    Account: wallet.address,
    Destination: custody,
    Amount: paymentAmount,
    Memos: [{ Memo: { MemoData: memoData, MemoFormat: memoFormat } }],
  };

  const result = await withXrplClient(endpoint, (client) =>
    submitTx(client, wallet, tx)
  );
  const txHash = result.result.hash;
  console.log(colors.green("✅ Transfer sent"));
  console.log(`  tx: ${colors.yellow(txHash)}`);

  if (!argv.relay) {
    console.log(
      colors.dim(
        `\nRelay later with:\n  ntt xrpl relay -n ${network} --request-type ern1 \\\n    --tx-hash ${txHash} --dst-chain ${argv["dst-chain"]} \\\n    --dst-addr ${argv.recipient} --manager ${custody} --executor <executor> --seed <seed>`
      )
    );
    return;
  }

  if (!argv.executor) {
    throw new Error("--executor is required to relay (or pass --no-relay)");
  }

  // Hand off to the existing relay flow: it re-derives the ern1 transceiver
  // emitter + sequence from the tx, polls the VAA, and sends the executor memo.
  // `--manager custody` lets relay derive the source NTT manager emitter.
  console.log(colors.blue("\n↪ Relaying transfer (ern1)..."));
  await runRelay(
    {
      network,
      rpc: argv.rpc,
      algorithm: argv.algorithm,
      "tx-hash": txHash,
      "dst-chain": argv["dst-chain"],
      "request-type": "ern1",
      "dst-addr": argv.recipient,
      manager: custody,
      "src-manager": argv["src-manager"],
      token: isMpt ? "mpt" : isIou ? "iou" : "xrp",
      currency,
      issuer,
      "mpt-id": mptIssuanceId,
      executor: argv.executor,
      "executor-api": argv["executor-api"],
      "guardian-api": argv["guardian-api"],
      "gas-limit": argv["gas-limit"],
      "msg-value": argv["msg-value"],
      "relay-instructions": argv["relay-instructions"],
      "poll-interval": argv["poll-interval"] ?? 5_000,
      "poll-timeout": argv["poll-timeout"] ?? 120_000,
      seed: argv.seed,
    },
    overrides
  );
}
