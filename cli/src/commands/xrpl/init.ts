import type {
  Network,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk-connect";
import { xrpToDrops } from "xrpl";
import { colors } from "../../colors.js";
import {
  loadSeed,
  resolveXrplEndpoint,
  runXrpl,
  submitTx,
  walletFromSeed,
  withXrplClient,
} from "../../xrpl/helpers";
import {
  getDefaultCoreAccountForNetwork,
  WORMHOLE_PUBLISH_MEMO_FORMAT,
  buildInitData,
  buildOnboardingPayload,
  buildPublishMemoData,
  type TokenInit,
} from "../../xrpl/onboarding";
import { withCommon } from "./common";

// This tool only onboards NTT deployments; WTT/CORE are intentionally not
// exposed, so the onboarding payload's app type is always "NTT".
const APP_TYPE = "NTT";

/** Resolve and validate the token selector args into a TokenInit. */
function resolveTokenInit(argv: any): TokenInit {
  switch (argv.token) {
    case "xrp":
      return { type: "xrp" };
    case "iou":
      if (!argv.currency || !argv.issuer) {
        throw new Error("--token iou requires --currency and --issuer");
      }
      return { type: "iou", currency: argv.currency, issuer: argv.issuer };
    case "mpt":
      if (!argv["mpt-id"]) {
        throw new Error("--token mpt requires --mpt-id");
      }
      return { type: "mpt", mptId: argv["mpt-id"] };
    default:
      throw new Error(`unknown token type: ${argv.token}`);
  }
}

export function createXrplInitCommand(
  overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "init",
    describe:
      "Send an XRPLAppOnboarding message to onboard a custody account to the Wormhole Core",
    builder: (yargs: any) =>
      withCommon(yargs)
        .option("admin", {
          describe: "Admin XRPL r-address (registers peers / rotates admin)",
          type: "string",
          demandOption: true,
        })
        .option("initial-ticket", {
          describe: "First ticket ID in the pre-allocated range",
          type: "string",
          demandOption: true,
        })
        .option("ticket-count", {
          describe: "Number of tickets available",
          type: "string",
          demandOption: true,
        })
        .option("token", {
          describe: "Token type for the NTT deployment",
          type: "string",
          choices: ["xrp", "iou", "mpt"] as const,
          demandOption: true,
        })
        .option("decimals", {
          describe: "Token decimals (XRPL native scale)",
          type: "number",
          default: 6,
        })
        .option("currency", {
          describe: "IOU currency: 3-char ASCII or 40-char hex [--token iou]",
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
        .option("core-account", {
          describe:
            "Wormhole Core (GMP) account to send the onboarding message to (default: resolved per network)",
          type: "string",
        })
        .option("amount", {
          describe: "XRP amount to send with the onboarding message",
          type: "string",
          default: "0.000001",
        })
        .option("issuer-seed", {
          describe: "Custody account seed (or env ISSUER_SEED)",
          type: "string",
        })
        .example(
          "$0 xrpl init -n Testnet --admin r9qA... --initial-ticket 100 --ticket-count 150 --token xrp --issuer-seed sEd7...",
          "Onboard an XRP NTT custody account"
        )
        .example(
          "$0 xrpl init -n Testnet --admin r9qA... --initial-ticket 100 --ticket-count 150 --token mpt --decimals 9 --mpt-id 00EE5E8C... --issuer-seed sEd7...",
          "Onboard an MPT NTT custody account"
        ),
    handler: (argv: any) =>
      runXrpl(async () => {
        const network = argv.network as Network;
        const coreAccount =
          argv["core-account"] ?? getDefaultCoreAccountForNetwork(network);
        const endpoint = resolveXrplEndpoint(network, argv.rpc, overrides);
        const seed = loadSeed(
          argv["issuer-seed"],
          "issuer-seed",
          "ISSUER_SEED"
        );
        const wallet = walletFromSeed(seed, argv.algorithm);

        const token = resolveTokenInit(argv);
        const decimals: number = argv.decimals;

        const initData = buildInitData(decimals, token);
        const payload = buildOnboardingPayload({
          admin: argv.admin,
          app: APP_TYPE,
          initialTicket: BigInt(argv["initial-ticket"]),
          ticketCount: BigInt(argv["ticket-count"]),
          initData,
        });
        const memoData = buildPublishMemoData(payload);

        console.log(
          colors.blue(
            `Onboarding ${wallet.address} as ${APP_TYPE} (${token.type.toUpperCase()}, ${decimals} decimals) on ${network}`
          )
        );
        console.log(`   admin:        ${argv.admin}`);
        console.log(
          `   tickets:      ${argv["ticket-count"]} starting at ${argv["initial-ticket"]}`
        );
        console.log(`   core account: ${coreAccount}`);

        const result = await withXrplClient(endpoint, (client) =>
          submitTx(client, wallet, {
            TransactionType: "Payment",
            Account: wallet.address,
            Destination: coreAccount,
            Amount: xrpToDrops(argv.amount),
            Memos: [
              {
                Memo: {
                  MemoFormat: Buffer.from(
                    WORMHOLE_PUBLISH_MEMO_FORMAT,
                    "ascii"
                  ).toString("hex"),
                  MemoData: memoData,
                },
              },
            ],
          })
        );
        console.log(colors.green("✅ Onboarding message sent"));
        console.log(`   tx: ${result.result.hash}`);
      }),
  };
}
