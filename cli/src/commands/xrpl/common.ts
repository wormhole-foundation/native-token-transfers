import { options } from "../shared";

/**
 * Options common to every `ntt xrpl` subcommand: which network/endpoint to
 * talk to, and (optionally) which key algorithm to derive the wallet with.
 */
export const withCommon = (yargs: any) =>
  yargs
    .option("network", options.network)
    .option("rpc", {
      describe: "XRPL WebSocket endpoint (overrides the network default)",
      type: "string",
    })
    .option("algorithm", {
      describe: "Key algorithm to derive the wallet from the seed",
      type: "string",
      choices: ["ed25519", "secp256k1"] as const,
    });
