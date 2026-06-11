import type {
  Network,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk-connect";
import { colors } from "../../colors.js";
import { runXrpl } from "../../xrpl/helpers";
import { parsePayload, parseVaa } from "../../xrpl/payloads";

function hexToBuffer(input: string): Buffer {
  let s = input.trim();
  if (s.startsWith("0x") || s.startsWith("0X")) s = s.slice(2);
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2 !== 0) {
    throw new Error("Invalid hex input");
  }
  return Buffer.from(s, "hex");
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function createXrplParseVaaCommand(
  _overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "parse-vaa <vaa>",
    describe: "Decode an XRPL-Wormhole VAA (XREL/XRFL/XADM/onboarding) — no tx",
    builder: (yargs: any) =>
      yargs
        .positional("vaa", {
          describe: "Hex VAA bytes (with or without 0x), or --payload-only",
          type: "string",
          demandOption: true,
        })
        .option("payload-only", {
          describe: "Treat the input as a bare payload (not a full VAA)",
          type: "boolean",
          default: false,
        })
        .example(
          "$0 xrpl parse-vaa 01000000...",
          "Decode a full VAA and its XRPL payload"
        ),
    handler: (argv: any) =>
      runXrpl(async () => {
        const bytes = hexToBuffer(argv.vaa);

        if (argv["payload-only"]) {
          const parsed = parsePayload(bytes);
          console.log(colors.blue("📦 Payload"));
          console.log(JSON.stringify(parsed, bigintReplacer, 2));
          return;
        }

        const vaa = parseVaa(bytes);
        console.log(colors.blue("✉️  VAA envelope"));
        console.log(`  version:          ${vaa.version}`);
        console.log(`  guardianSetIndex: ${vaa.guardianSetIndex}`);
        console.log(`  signatures:       ${vaa.signatures.length}`);
        console.log(`  emitterChain:     ${vaa.emitterChain}`);
        console.log(`  emitterAddress:   ${vaa.emitterAddress}`);
        console.log(`  sequence:         ${vaa.sequence}`);
        console.log(`  consistency:      ${vaa.consistencyLevel}`);
        console.log(colors.blue("\n📦 Payload"));
        const parsed = parsePayload(vaa.payload);
        console.log(JSON.stringify(parsed, bigintReplacer, 2));
      }),
  };
}
