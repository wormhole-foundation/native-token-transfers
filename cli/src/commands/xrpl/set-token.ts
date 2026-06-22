import fs from "fs";
import type {
  Network,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk-connect";
import { colors } from "../../colors.js";
import { loadConfig } from "../../deployments";
import { runXrpl } from "../../xrpl/helpers";
import { XrplAddress, XrplZeroAddress } from "@wormhole-foundation/sdk-xrpl";
import { options } from "../shared";

const XRP_DECIMALS = 6;

export function createXrplSetTokenCommand(
  _overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "set-token",
    describe:
      "Record the XRPL NTT token (address + decimals) in the deployment file",
    builder: (yargs: any) =>
      yargs
        .option("token", {
          describe:
            'Token: "native" for native XRP, an IOU "CODE.rIssuer", or a ' +
            "48-char hex MPT issuance id (IOU/MPT validated via the Wormhole " +
            "SDK XRPL address conventions)",
          type: "string",
          demandOption: true,
        })
        .option("decimals", {
          describe: "Token decimals on XRPL (e.g. 6 for XRP); 0-255",
          type: "number",
          demandOption: true,
        })
        .option("path", options.deploymentPath)
        .example(
          "$0 xrpl set-token --token native --decimals 6",
          "Record native XRP"
        )
        .example(
          "$0 xrpl set-token --token FOO.rBa2jdUu8S2ZzaCJv8y1Lx9Pdrns51hJj --decimals 9",
          "Record an IOU token"
        )
        .example(
          "$0 xrpl set-token --token 00EE5E8C9F... --decimals 9",
          "Record an MPT token (48-char hex issuance id)"
        ),
    handler: (argv: any) =>
      runXrpl(async () => {
        const path = argv.path;
        const config = loadConfig(path);

        // Native XRP is recorded as the literal "native" (the zero/black-hole
        // account is also accepted and normalized to it). IOU/MPT identifiers
        // are validated + normalized via the SDK's XRPL address conventions.
        const raw = String(argv.token);
        const token =
          raw.toLowerCase() === "native" || raw === XrplZeroAddress
            ? "native"
            : new XrplAddress(raw).toString();

        const decimals = argv.decimals;
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
          throw new Error(
            `--decimals must be an integer between 0 and 255, got ${decimals}`
          );
        }

        if (token === "native" && decimals != XRP_DECIMALS) {
          throw new Error(
            `--decimals must be 6 if the token is XRP, got ${decimals}`
          );
        }

        config.xrpl = { ...config.xrpl, token, decimals };
        fs.writeFileSync(path, JSON.stringify(config, null, 2));

        console.log(
          colors.green(
            `✅ Recorded XRPL token: ${colors.yellow(token)} (${decimals} decimals)`
          )
        );
        console.log(`   ${path} → xrpl.token, xrpl.decimals`);
      }),
  };
}
