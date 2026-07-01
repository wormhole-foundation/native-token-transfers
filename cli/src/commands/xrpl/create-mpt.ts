import type {
  Network,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk-connect";
import { type MPTokenIssuanceCreate } from "xrpl";
import { colors } from "../../colors.js";
import {
  loadMetadataHex,
  loadSeed,
  parseMptFlags,
  resolveXrplEndpoint,
  runXrpl,
  submitTx,
  validateMptIssuanceParams,
  walletFromSeed,
  withXrplClient,
} from "../../xrpl/helpers";
import { withCommon } from "./common";

export function createCreateMptCommand(
  overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "create-mpt",
    describe: "Create a Multi-Purpose Token issuance (MPTokenIssuanceCreate)",
    builder: (yargs: any) =>
      withCommon(yargs)
        .option("issuer-seed", {
          describe: "Issuer account seed (or env ISSUER_SEED)",
          type: "string",
        })
        .option("asset-scale", {
          describe: "Number of decimal places (AssetScale)",
          type: "number",
          default: 0,
        })
        .option("max-amount", {
          describe: "Maximum issuance amount (MaximumAmount)",
          type: "string",
        })
        .option("transfer-fee", {
          describe:
            "Secondary-sale fee in tenths of a basis point, 0-50000 (50000 = 50%); requires tfMPTCanTransfer",
          type: "number",
          default: 0,
        })
        .option("flags", {
          describe:
            "Comma-separated MPT flags (e.g. tfMPTCanTransfer,tfMPTCanClawback) or a raw integer",
          type: "string",
        })
        .option("metadata-json", {
          describe: "Inline JSON metadata, or a path to a .json file",
          type: "string",
        })
        .example(
          "$0 xrpl create-mpt -n Testnet --asset-scale 9 --max-amount 10000000000000 --flags tfMPTCanTransfer --issuer-seed sEd7...",
          "Create a transferable MPT issuance"
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
        const flags = parseMptFlags(argv.flags);
        const metadata = loadMetadataHex(argv["metadata-json"]);
        const maxAmount =
          argv["max-amount"] !== undefined
            ? String(argv["max-amount"])
            : undefined;

        validateMptIssuanceParams({
          assetScale: argv["asset-scale"],
          transferFee: argv["transfer-fee"],
          flags,
          maxAmount,
        });

        const tx: MPTokenIssuanceCreate = {
          TransactionType: "MPTokenIssuanceCreate",
          Account: wallet.address,
          AssetScale: argv["asset-scale"],
          Flags: flags,
        };
        // Only set fields that XRPL treats as conditional, to avoid validation
        // errors (e.g. TransferFee without tfMPTCanTransfer).
        if (argv["transfer-fee"]) tx.TransferFee = argv["transfer-fee"];
        if (maxAmount !== undefined) tx.MaximumAmount = maxAmount;
        if (metadata !== undefined) tx.MPTokenMetadata = metadata;

        console.log(
          colors.blue(
            `Creating MPT issuance from ${wallet.address} (${network})`
          )
        );
        const result = await withXrplClient(endpoint, (client) =>
          submitTx(client, wallet, tx)
        );
        const meta = result.result.meta;
        const mptId =
          meta && typeof meta !== "string"
            ? (meta as { mpt_issuance_id?: string }).mpt_issuance_id
            : undefined;
        console.log(colors.green("✅ MPT issuance created"));
        console.log(
          `   mpt_issuance_id: ${colors.yellow(
            mptId ?? "(not found in transaction metadata)"
          )}`
        );
        console.log(`   tx: ${result.result.hash}`);
      }),
  };
}
