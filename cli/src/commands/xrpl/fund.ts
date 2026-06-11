import fs from "fs";
import type {
  Network,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk-connect";
import { xrpToDrops } from "xrpl";
import { colors } from "../../colors.js";
import { loadConfig } from "../../deployments";
import {
  XRPL_FAUCET_HOSTS,
  getReserveBase,
  loadSeed,
  resolveXrplEndpoint,
  runXrpl,
  submitTx,
  validateRAddress,
  walletFromSeed,
  withXrplClient,
} from "../../xrpl/helpers";
import { withCommon } from "./common";

// Buffer (XRP) added on top of the strict reserve so the account can still pay
// transaction fees after locking up the reserve.
const FEE_BUFFER_XRP = 2;

export function createXrplFundCommand(
  overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "fund",
    describe:
      "Fund a custody account with enough XRP for a signer list + tickets",
    builder: (yargs: any) =>
      withCommon(yargs)
        .option("account", {
          describe: "Account to fund (defaults to xrpl.manager from the deployment file)",
          type: "string",
        })
        .option("amount", {
          describe: "XRP to fund (default: computed from on-ledger reserves)",
          type: "string",
        })
        .option("tickets", {
          describe: "Ticket count to size the reserve for",
          type: "number",
          default: 200,
        })
        .option("faucet", {
          describe: "Use the testnet/devnet faucet to fund --account",
          type: "boolean",
          default: false,
        })
        .option("from-seed", {
          describe: "Funding source seed for a Payment (or env FUNDER_SEED)",
          type: "string",
        })
        .option("path", {
          describe: "Path to the deployment file",
          type: "string",
          default: "deployment.json",
        })
        .example(
          "$0 xrpl fund -n Testnet --faucet --account r9qA...",
          "Fund the account from the testnet faucet"
        )
        .example(
          "$0 xrpl fund -n Mainnet --account r9qA... --amount 50 --from-seed sEd7...",
          "Send 50 XRP to the account from a funded source"
        ),
    handler: (argv: any) =>
      runXrpl(async () => {
        const network = argv.network as Network;
        const endpoint = resolveXrplEndpoint(network, argv.rpc, overrides);

        // Resolve the target account: --account, else the deployment's xrpl.manager.
        let target: string | undefined = argv.account;
        if (!target && fs.existsSync(argv.path)) {
          target = loadConfig(argv.path).xrpl?.manager;
        }
        if (!target) {
          throw new Error(
            "No target account: pass --account or set xrpl.manager (ntt xrpl set-manager)"
          );
        }
        validateRAddress(target);

        await withXrplClient(endpoint, async (client) => {
          const { baseXrp, incXrp } = await getReserveBase(client);
          // +1 object for the signer list itself.
          const requiredXrp =
            baseXrp + incXrp * (argv.tickets + 1) + FEE_BUFFER_XRP;
          console.log(
            colors.gray(
              `Reserve for ${argv.tickets} tickets + signer list: base ${baseXrp} + inc ${incXrp} × ${argv.tickets + 1} + ${FEE_BUFFER_XRP} buffer = ${requiredXrp} XRP`
            )
          );

          if (argv.faucet) {
            const host = XRPL_FAUCET_HOSTS[network];
            if (!host) {
              throw new Error("--faucet is only available on Testnet/Devnet");
            }
            // The faucet requires a whole-XRP integer amount; round up so it
            // still covers the reserve.
            const xrpAmount = String(
              Math.ceil(Number(argv.amount ?? requiredXrp))
            );
            console.log(
              colors.blue(`Funding ${target} via faucet (${xrpAmount} XRP requested)`)
            );
            // The faucet funds the `destination` address directly — no key needed.
            const res = await fetch(`https://${host}/accounts`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ destination: target, xrpAmount }),
            });
            if (!res.ok) {
              throw new Error(
                `Faucet request failed (${res.status}): ${await res.text()}`
              );
            }
            const body: any = await res.json().catch(() => ({}));
            console.log(colors.green("✅ Faucet funded the account"));
            if (body?.balance !== undefined) {
              console.log(`   balance: ${body.balance} XRP`);
            }
            return;
          }

          const fromSeed = loadSeed(
            argv["from-seed"],
            "from-seed",
            "FUNDER_SEED"
          );
          const funder = walletFromSeed(fromSeed, argv.algorithm);

          // If the funding source is the account itself, there's nothing to send —
          // just report whether it already holds the required reserve.
          if (funder.address === target) {
            let balance = 0;
            try {
              balance = await client.getXrpBalance(target);
            } catch {
              balance = 0; // account not found / unfunded
            }
            if (balance >= requiredXrp) {
              console.log(
                colors.green(
                  `✅ ${target} already holds ${balance} XRP (≥ ${requiredXrp} required); no funding needed`
                )
              );
            } else {
              console.log(
                colors.yellow(
                  `⚠️  ${target} holds ${balance} XRP but needs ${requiredXrp} (short ${(
                    requiredXrp - balance
                  ).toFixed(6)}); fund it from another source or use --faucet`
                )
              );
            }
            return;
          }

          const amount = argv.amount ?? String(requiredXrp);
          console.log(
            colors.blue(`Funding ${target} on ${network} with ${amount} XRP`)
          );
          const result = await submitTx(client, funder, {
            TransactionType: "Payment",
            Account: funder.address,
            Destination: target,
            Amount: xrpToDrops(amount),
          });
          console.log(
            colors.green(`✅ Sent ${amount} XRP from ${funder.address}`)
          );
          console.log(`   tx: ${result.result.hash}`);
        });
      }),
  };
}
