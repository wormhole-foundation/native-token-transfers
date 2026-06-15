import type {
  Network,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk-connect";
import { colors } from "../../colors.js";
import { promptYesNo } from "../../prompts.js";
import {
  loadSeed,
  resolveXrplEndpoint,
  runXrpl,
  submitTx,
  walletFromSeed,
  withXrplClient,
} from "../../xrpl/helpers";
import {
  deriveSignerEntries,
  fetchDelegatedManagerSet,
  signerEntriesFromAddresses,
  type SignerEntry,
} from "../../xrpl/manager-set";
import { options } from "../shared";
import { withCommon } from "./common";

export function createXrplSetSignerListCommand(
  overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "set-signer-list",
    describe:
      "Hand the custody account over to the manager-set multisig (SignerListSet)",
    builder: (yargs: any) =>
      withCommon(yargs)
        .option("signers", {
          describe:
            "Explicit comma-separated signer r-addresses (skips the EVM fetch)",
          type: "string",
        })
        .option("manager-chain-id", {
          describe: "Wormhole chain ID of the XRPL custody account",
          type: "number",
          default: 66,
        })
        .option("manager-set-index", {
          describe: "Manager set index to fetch, or 'latest'",
          type: "string",
          default: "latest",
        })
        .option("rpc-eth", {
          describe: "EVM RPC URL hosting the delegated manager set contract",
          type: "string",
        })
        .option("delegated-manager-set-addr", {
          describe: "Delegated manager set contract address (EVM)",
          type: "string",
        })
        .option("quorum", {
          describe:
            "Signer quorum (required with --signers; the EVM fetch always uses the manager-set threshold)",
          type: "number",
        })
        .option("issuer-seed", {
          describe: "Custody account seed (or env ISSUER_SEED)",
          type: "string",
        })
        .option("yes", options.yes)
        .example(
          "$0 xrpl set-signer-list -n Testnet --rpc-eth https://... --delegated-manager-set-addr 0x... --issuer-seed sEd7...",
          "Fetch the latest manager set and set the signer list"
        )
        .example(
          "$0 xrpl set-signer-list -n Testnet --signers r1,r2,r3 --quorum 2 --issuer-seed sEd7...",
          "Set an explicit signer list"
        ),
    handler: (argv: any) =>
      runXrpl(async () => {
        const network = argv.network as Network;
        const endpoint = resolveXrplEndpoint(network, argv.rpc, overrides);
        const seed = loadSeed(
          argv["issuer-seed"],
          "issuer-seed",
          "ISSUER_SEED"
        );
        const wallet = walletFromSeed(seed, argv.algorithm);

        // Resolve signer entries + quorum, either from an explicit list or by
        // fetching the delegated manager set from an EVM contract.
        let entries: SignerEntry[];
        let quorum: number;
        if (argv.signers) {
          entries = signerEntriesFromAddresses(String(argv.signers).split(","));
          if (argv.quorum === undefined) {
            throw new Error("--quorum is required when using --signers");
          }
          quorum = argv.quorum;
        } else {
          if (!argv["rpc-eth"] || !argv["delegated-manager-set-addr"]) {
            throw new Error(
              "Provide --signers, or both --rpc-eth and --delegated-manager-set-addr"
            );
          }
          if (argv.quorum !== undefined) {
            throw new Error(
              "Do not pass --quorum with the EVM fetch; the quorum is the manager-set threshold"
            );
          }
          const idxArg = argv["manager-set-index"];
          const index: number | "latest" =
            idxArg === "latest" ? "latest" : Number(idxArg);
          if (index !== "latest" && (!Number.isInteger(index) || index < 0)) {
            throw new Error(
              "--manager-set-index must be a non-negative integer or 'latest'"
            );
          }
          const managerSet = await fetchDelegatedManagerSet(
            argv["manager-chain-id"],
            index,
            argv["rpc-eth"],
            argv["delegated-manager-set-addr"]
          );
          entries = deriveSignerEntries(managerSet.pubkeys);
          // The quorum is fixed by the manager set; not user-overridable.
          quorum = managerSet.mThreshold;
          console.log(
            colors.gray(
              `   fetched manager set #${managerSet.index}: ${managerSet.nTotal} signers, threshold ${managerSet.mThreshold}`
            )
          );
        }

        if (
          !Number.isInteger(quorum) ||
          quorum < 1 ||
          quorum > entries.length
        ) {
          throw new Error(
            `quorum ${quorum} must be between 1 and the signer count (${entries.length})`
          );
        }

        console.log(
          colors.blue(
            `Setting signer list on ${wallet.address} (${network}): ${entries.length} signers, quorum ${quorum}`
          )
        );
        for (const e of entries) {
          console.log(colors.gray(`   - ${e.SignerEntry.Account}`));
        }
        console.log(
          colors.yellow(
            "⚠️  This hands signing authority to the multisig. The master key remains\n" +
              "    enabled until you disable it separately (asfDisableMaster)."
          )
        );

        if (!argv.yes) {
          const ok = await promptYesNo("Proceed with SignerListSet?", {
            defaultYes: false,
          });
          if (!ok) {
            console.log(colors.gray("Aborted."));
            return;
          }
        }

        const result = await withXrplClient(endpoint, (client) =>
          submitTx(client, wallet, {
            TransactionType: "SignerListSet",
            Account: wallet.address,
            SignerQuorum: quorum,
            SignerEntries: entries,
          })
        );
        console.log(colors.green("✅ Signer list set"));
        console.log(`   tx: ${result.result.hash}`);
      }),
  };
}
