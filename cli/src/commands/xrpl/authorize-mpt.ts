import type {
  Network,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk-connect";
import { colors } from "../../colors.js";
import {
  loadSeed,
  resolveXrplEndpoint,
  runXrpl,
  submitTx,
  walletFromSeed,
  withXrplClient,
} from "../../xrpl/helpers";
import { withCommon } from "./common";

export function createAuthorizeMptCommand(
  overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "authorize-mpt",
    describe: "Authorize (opt into) an MPT as a holder (MPTokenAuthorize)",
    builder: (yargs: any) =>
      withCommon(yargs)
        .option("mpt-id", {
          describe: "MPT issuance ID (48-char hex)",
          type: "string",
          demandOption: true,
        })
        .option("seed", {
          describe: "Holder account seed (or env SEED)",
          type: "string",
        })
        .example(
          "$0 xrpl authorize-mpt -n Testnet --mpt-id 00EE5E8C... --seed sEd7...",
          "Opt the holder account into the MPT"
        ),
    handler: (argv: any) =>
      runXrpl(async () => {
        const network = argv.network as Network;
        const endpoint = resolveXrplEndpoint(network, argv.rpc, overrides);
        const seed = loadSeed(argv.seed, "seed", "SEED");
        const wallet = walletFromSeed(seed, argv.algorithm);
        console.log(
          colors.blue(
            `Authorizing MPT ${argv["mpt-id"]} for ${wallet.address} (${network})`
          )
        );
        const result = await withXrplClient(endpoint, (client) =>
          submitTx(client, wallet, {
            TransactionType: "MPTokenAuthorize",
            Account: wallet.address,
            MPTokenIssuanceID: argv["mpt-id"],
          })
        );
        console.log(colors.green("✅ MPT authorized"));
        console.log(`   tx: ${result.result.hash}`);
      }),
  };
}
