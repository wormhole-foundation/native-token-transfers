import type {
  Network,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk-connect";
import { AccountSetAsfFlags } from "xrpl";
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

export function createEnableRipplingCommand(
  overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "enable-rippling",
    describe: "Enable DefaultRipple on an IOU issuer account (AccountSet)",
    builder: (yargs: any) =>
      withCommon(yargs)
        .option("issuer-seed", {
          describe: "Issuer account seed (or env ISSUER_SEED)",
          type: "string",
        })
        .example(
          "$0 xrpl enable-rippling -n Testnet --issuer-seed sEd7...",
          "Enable rippling on the issuer account"
        ),
    handler: (argv: any) =>
      runXrpl(async () => {
        const network = argv.network as Network;
        const endpoint = resolveXrplEndpoint(network, argv.rpc, overrides);
        const seed = loadSeed(argv["issuer-seed"], "issuer-seed", "ISSUER_SEED");
        const wallet = walletFromSeed(seed, argv.algorithm);
        console.log(
          colors.blue(`Enabling DefaultRipple on ${wallet.address} (${network})`)
        );
        const result = await withXrplClient(endpoint, (client) =>
          submitTx(client, wallet, {
            TransactionType: "AccountSet",
            Account: wallet.address,
            SetFlag: AccountSetAsfFlags.asfDefaultRipple,
          })
        );
        console.log(colors.green("✅ DefaultRipple enabled"));
        console.log(`   tx: ${result.result.hash}`);
      }),
  };
}
