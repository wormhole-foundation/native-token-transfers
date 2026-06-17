import type {
  Network,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk-connect";
import { colors } from "../../colors.js";
import {
  loadSeed,
  normalizeCurrency,
  resolveXrplEndpoint,
  runXrpl,
  submitTx,
  walletFromSeed,
  withXrplClient,
} from "../../xrpl/helpers";
import { withCommon } from "./common";

export function createTrustSetCommand(
  overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "trust-set",
    describe: "Open a trust line so a holder can hold an IOU (TrustSet)",
    builder: (yargs: any) =>
      withCommon(yargs)
        .option("currency", {
          describe: "Currency code (3-char ASCII or 40-char hex)",
          type: "string",
          demandOption: true,
        })
        .option("issuer", {
          describe: "IOU issuer account address",
          type: "string",
          demandOption: true,
        })
        .option("limit", {
          describe: "Trust line limit (max amount the holder will hold)",
          type: "string",
          demandOption: true,
        })
        .option("seed", {
          describe: "Holder account seed (or env SEED)",
          type: "string",
        })
        .example(
          "$0 xrpl trust-set -n Testnet --currency FOO --issuer r9qA... --limit 1000000 --seed sEd7...",
          "Open a trust line to the issuer for FOO"
        ),
    handler: (argv: any) =>
      runXrpl(async () => {
        const network = argv.network as Network;
        const endpoint = resolveXrplEndpoint(network, argv.rpc, overrides);
        const seed = loadSeed(argv.seed, "seed", "SEED");
        const wallet = walletFromSeed(seed, argv.algorithm);
        const currency = normalizeCurrency(argv.currency);
        console.log(
          colors.blue(
            `Trust line: ${wallet.address} trusts ${argv.issuer} for ${currency} (limit ${argv.limit})`
          )
        );
        const result = await withXrplClient(endpoint, (client) =>
          submitTx(client, wallet, {
            TransactionType: "TrustSet",
            Account: wallet.address,
            LimitAmount: {
              currency,
              issuer: argv.issuer,
              value: String(argv.limit),
            },
          })
        );
        console.log(colors.green("✅ Trust line set"));
        console.log(`   tx: ${result.result.hash}`);
      }),
  };
}
