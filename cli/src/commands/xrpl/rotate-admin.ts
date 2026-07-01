import type {
  Network,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk-connect";
import { xrpToDrops } from "xrpl";
import { colors } from "../../colors.js";
import { loadConfig } from "../../deployments";
import { promptYesNo } from "../../prompts.js";
import {
  loadSeed,
  resolveXrplEndpoint,
  runXrpl,
  submitTx,
  validateRAddress,
  walletFromSeed,
  withXrplClient,
} from "../../xrpl/helpers";
import { buildRotateAdminPayload } from "../../xrpl/admin";
import {
  DEFAULT_TESTNET_CORE_ACCOUNT,
  WORMHOLE_PUBLISH_MEMO_FORMAT,
  buildPublishMemoData,
} from "../../xrpl/onboarding";
import { options } from "../shared";
import { withCommon } from "./common";

export function createXrplRotateAdminCommand(
  overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "rotate-admin",
    describe: "Rotate the custody account's admin (XADM RotateAdmin)",
    builder: (yargs: any) =>
      withCommon(yargs)
        .option("manager", {
          describe:
            "XRPL custody (manager) account r-address (default: xrpl.manager)",
          type: "string",
        })
        .option("new-admin", {
          describe: "New admin XRPL r-address",
          type: "string",
          demandOption: true,
        })
        .option("core-account", {
          describe: "Wormhole Core (GMP) account to publish the message to",
          type: "string",
          default: DEFAULT_TESTNET_CORE_ACCOUNT,
        })
        .option("amount", {
          describe: "XRP amount to send with the message",
          type: "string",
          default: "0.000001",
        })
        .option("admin-seed", {
          describe: "Current admin account seed (or env ADMIN_SEED)",
          type: "string",
        })
        .option("yes", options.yes)
        .option("path", options.deploymentPath)
        .example(
          "$0 xrpl rotate-admin -n Testnet --new-admin r9qA... --admin-seed sEd7...",
          "Rotate the admin of the recorded custody account"
        ),
    handler: (argv: any) =>
      runXrpl(async () => {
        const network = argv.network as Network;
        const endpoint = resolveXrplEndpoint(network, argv.rpc, overrides);
        const seed = loadSeed(argv["admin-seed"], "admin-seed", "ADMIN_SEED");
        const wallet = walletFromSeed(seed, argv.algorithm);

        const managerArg = argv.manager || loadConfig(argv.path).xrpl?.manager;
        if (!managerArg) {
          throw new Error(
            "Provide --manager or record one with `ntt xrpl set-manager`"
          );
        }
        const manager = validateRAddress(managerArg);
        const newAdmin = validateRAddress(argv["new-admin"]);

        const payload = buildRotateAdminPayload({ manager, newAdmin });
        const memoData = buildPublishMemoData(payload);

        console.log(
          colors.blue(
            `Rotating admin of ${manager} (current admin ${wallet.address}) on ${network}`
          )
        );
        console.log(`   new admin:    ${newAdmin}`);
        console.log(`   core account: ${argv["core-account"]}`);

        if (!argv.yes) {
          const ok = await promptYesNo("Proceed with RotateAdmin?", {
            defaultYes: false,
          });
          if (!ok) {
            console.log(colors.gray("Aborted."));
            return;
          }
        }

        const result = await withXrplClient(endpoint, (client) =>
          submitTx(client, wallet, {
            TransactionType: "Payment",
            Account: wallet.address,
            Destination: argv["core-account"],
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
        console.log(colors.green("✅ RotateAdmin message sent"));
        console.log(`   tx: ${result.result.hash}`);
      }),
  };
}
