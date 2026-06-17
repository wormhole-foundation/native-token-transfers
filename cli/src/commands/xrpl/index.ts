import type {
  Network,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk-connect";
import { createAuthorizeMptCommand } from "./authorize-mpt";
import { createCreateMptCommand } from "./create-mpt";
import { createEnableRipplingCommand } from "./enable-rippling";
import { createTrustSetCommand } from "./trust-set";

/**
 * `ntt xrpl <subcommand>` — low-level XRPL token setup used when preparing an
 * NTT deployment on the XRP Ledger. These are pure, single-purpose commands:
 *
 *   enable-rippling  — issuer enables DefaultRipple (required for an IOU)
 *   trust-set        — a holder opts into an IOU
 *   create-mpt       — issuer creates an MPT issuance (prints mpt_issuance_id)
 *   authorize-mpt    — a holder opts into an MPT
 *
 * "Creating" an IOU is just `enable-rippling` (issuer) + `trust-set` (holders).
 */
export function createXrplCommand(overrides: WormholeConfigOverrides<Network>) {
  return {
    command: ["xrpl"] as const,
    describe: "XRP Ledger token commands",
    builder: (yargs: any) =>
      yargs
        .command(createEnableRipplingCommand(overrides))
        .command(createTrustSetCommand(overrides))
        .command(createCreateMptCommand(overrides))
        .command(createAuthorizeMptCommand(overrides))
        .demandCommand(1, "Specify an xrpl subcommand")
        .strict(),
    handler: () => {},
  };
}
