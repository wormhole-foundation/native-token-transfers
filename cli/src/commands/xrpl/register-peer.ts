import type {
  Network,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk-connect";
import { xrpToDrops } from "xrpl";
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
import { buildRegisterPeerPayload } from "../../xrpl/admin";
import {
  DEFAULT_TESTNET_CORE_ACCOUNT,
  WORMHOLE_PUBLISH_MEMO_FORMAT,
  buildPublishMemoData,
} from "../../xrpl/onboarding";
import { options } from "../shared";
import { withCommon } from "./common";

export function createXrplRegisterPeerCommand(
  overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "register-peer",
    describe:
      "Register an NTT peer for the custody account (XADM RegisterPeer)",
    builder: (yargs: any) =>
      withCommon(yargs)
        .option("manager", {
          describe:
            "XRPL custody (manager) account r-address (default: xrpl.manager)",
          type: "string",
        })
        .option("peer-chain", {
          describe: "Peer chain (Wormhole name or numeric id)",
          type: "string",
          demandOption: true,
        })
        .option("peer-address", {
          describe: "Peer transceiver emitter address, 32-byte hex",
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
          describe: "Admin account seed (or env ADMIN_SEED)",
          type: "string",
        })
        .option("path", options.deploymentPath)
        .example(
          "$0 xrpl register-peer -n Testnet --peer-chain Solana --peer-address 0x… --admin-seed sEd7...",
          "Register a Solana peer for the recorded custody account"
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
        const peerChainId = resolveChainId(argv["peer-chain"]);

        const payload = buildRegisterPeerPayload({
          manager,
          peerChainId,
          peerAddress: argv["peer-address"],
        });
        const memoData = buildPublishMemoData(payload);

        console.log(
          colors.blue(
            `Registering peer for ${manager} (admin ${wallet.address}) on ${network}`
          )
        );
        console.log(`   peer chain:   ${argv["peer-chain"]} (${peerChainId})`);
        console.log(`   peer address: ${argv["peer-address"]}`);
        console.log(`   core account: ${argv["core-account"]}`);

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
        console.log(colors.green("✅ RegisterPeer message sent"));
        console.log(`   tx: ${result.result.hash}`);
      }),
  };
}
