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

// XRPL caps an account at 250 tickets.
const MAX_TICKETS = 250;

export function createXrplReserveTicketsCommand(
  overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "reserve-tickets",
    describe: "Pre-allocate tickets on the custody account (TicketCreate)",
    builder: (yargs: any) =>
      withCommon(yargs)
        .option("count", {
          describe: `Number of tickets to create (1-${MAX_TICKETS})`,
          type: "number",
          default: 200,
        })
        .option("issuer-seed", {
          describe: "Custody account seed (or env ISSUER_SEED)",
          type: "string",
        })
        .example(
          "$0 xrpl reserve-tickets -n Testnet --count 200 --issuer-seed sEd7...",
          "Reserve 200 tickets on the custody account"
        ),
    handler: (argv: any) =>
      runXrpl(async () => {
        const count: number = argv.count;
        if (!Number.isInteger(count) || count < 1 || count > MAX_TICKETS) {
          throw new Error(`--count must be an integer between 1 and ${MAX_TICKETS}`);
        }

        const network = argv.network as Network;
        const endpoint = resolveXrplEndpoint(network, argv.rpc, overrides);
        const seed = loadSeed(argv["issuer-seed"], "issuer-seed", "ISSUER_SEED");
        const wallet = walletFromSeed(seed, argv.algorithm);

        console.log(
          colors.blue(`Creating ${count} tickets on ${wallet.address} (${network})`)
        );
        const result = await withXrplClient(endpoint, (client) =>
          submitTx(client, wallet, {
            TransactionType: "TicketCreate",
            Account: wallet.address,
            TicketCount: count,
          })
        );

        // Collect the created ticket sequence numbers from the metadata so we
        // can report the allocated range (the first ticket feeds `xrpl init`'s
        // --initial-ticket).
        const meta = result.result.meta;
        const ticketSeqs: number[] = [];
        if (meta && typeof meta !== "string") {
          for (const node of meta.AffectedNodes) {
            const created = (node as any).CreatedNode;
            if (created?.LedgerEntryType === "Ticket") {
              const seq = created.NewFields?.TicketSequence;
              if (typeof seq === "number") ticketSeqs.push(seq);
            }
          }
        }
        ticketSeqs.sort((a, b) => a - b);

        console.log(colors.green(`✅ Created ${count} tickets`));
        if (ticketSeqs.length > 0) {
          const first = ticketSeqs[0];
          const last = ticketSeqs[ticketSeqs.length - 1];
          console.log(`   ticket range: ${first}–${last}`);
          console.log(
            colors.yellow(
              `   for 'xrpl init': --initial-ticket ${first} --ticket-count ${ticketSeqs.length}`
            )
          );
        }
        console.log(`   tx: ${result.result.hash}`);
      }),
  };
}
