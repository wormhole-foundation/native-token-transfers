import type {
  Network,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk-connect";
import { createAuthorizeMptCommand } from "./authorize-mpt";
import { createCreateMptCommand } from "./create-mpt";
import { createEnableRipplingCommand } from "./enable-rippling";
import { createTrustSetCommand } from "./trust-set";
import { createXrplInitCommand } from "./init";
import { createXrplSetManagerCommand } from "./set-manager";
import { createXrplFundCommand } from "./fund";
import { createXrplReserveTicketsCommand } from "./reserve-tickets";
import { createXrplSetSignerListCommand } from "./set-signer-list";

/**
 * `ntt xrpl <subcommand>` — XRPL commands for preparing an NTT deployment.
 *
 * Token setup:
 *   enable-rippling  — issuer enables DefaultRipple (required for an IOU)
 *   trust-set        — a holder opts into an IOU
 *   create-mpt       — issuer creates an MPT issuance (prints mpt_issuance_id)
 *   authorize-mpt    — a holder opts into an MPT
 *
 * Custody-account setup (run in order, while you still hold the account key):
 *   set-manager      — record the custody account in the deployment file
 *   fund             — fund the account for a signer list + tickets
 *   reserve-tickets  — pre-allocate tickets (TicketCreate)
 *   init             — send the XRPLAppOnboarding message
 *   set-signer-list  — hand off to the manager-set multisig (SignerListSet)
 *
 * "Creating" an IOU is just `enable-rippling` (issuer) + `trust-set` (holders).
 */
export function createXrplCommand(overrides: WormholeConfigOverrides<Network>) {
  return {
    command: ["xrpl"] as const,
    describe: "XRP Ledger commands",
    builder: (yargs: any) =>
      yargs
        .command(createEnableRipplingCommand(overrides))
        .command(createTrustSetCommand(overrides))
        .command(createCreateMptCommand(overrides))
        .command(createAuthorizeMptCommand(overrides))
        .command(createXrplSetManagerCommand(overrides))
        .command(createXrplFundCommand(overrides))
        .command(createXrplReserveTicketsCommand(overrides))
        .command(createXrplInitCommand(overrides))
        .command(createXrplSetSignerListCommand(overrides))
        .demandCommand(1, "Specify an xrpl subcommand")
        .strict(),
    handler: () => {},
  };
}
