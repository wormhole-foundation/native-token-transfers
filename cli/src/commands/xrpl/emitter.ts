import type {
  Network,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk-connect";
import { colors } from "../../colors.js";
import { runXrpl } from "../../xrpl/helpers";
import {
  accountIdFrom,
  computeEmitterAddress,
  formatTokenId,
  tokenIdFromFlags,
  type TokenId,
} from "../../xrpl/tokenId";

export function createXrplEmitterCommand(
  _overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "emitter",
    describe:
      "Compute the XRPL transceiver emitter address for a manager + token (no tx)",
    builder: (yargs: any) =>
      yargs
        .option("manager", {
          describe:
            "XRPL NTT manager / custody account (r-address or 20-byte hex)",
          type: "string",
          demandOption: true,
        })
        .option("token", {
          describe: "XRPL token type",
          type: "string",
          choices: ["xrp", "iou", "mpt"] as const,
          demandOption: true,
        })
        .option("currency", {
          describe: "IOU currency: 3-4 char ASCII or 40-char hex [--token iou]",
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
        .example(
          "$0 xrpl emitter --manager rfeMQr71KJQwNUbRwGTgCfVLoUVdWuvyny --token xrp",
          "Emitter for an XRP custody account"
        )
        .example(
          "$0 xrpl emitter --manager rnv8... --token iou --currency FOO --issuer rnv8...",
          "Emitter for an IOU deployment"
        ),
    handler: (argv: any) =>
      runXrpl(async () => {
        const token: TokenId = tokenIdFromFlags({
          type: argv.token,
          currency: argv.currency,
          issuer: argv.issuer,
          mptId: argv["mpt-id"],
        });
        const accountId = accountIdFrom(argv.manager);
        const emitter = computeEmitterAddress(accountId, token);
        const hex = emitter.toString("hex");

        console.log(colors.blue("🧮 XRPL transceiver emitter"));
        console.log(`  manager: ${colors.yellow(argv.manager)}`);
        console.log(`  token:   ${colors.yellow(formatTokenId(token))}`);
        console.log(`  emitter: ${colors.green(hex)}`);
        console.log(`  0x form: ${colors.green("0x" + hex)}`);
        console.log(
          colors.dim(
            "\nUse this with `ntt manual set-transceiver-peer Xrpl 0x… --chain <other>`"
          )
        );
      }),
  };
}
