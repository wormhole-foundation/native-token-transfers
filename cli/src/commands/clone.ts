import fs from "fs";
import {
  assertChain,
  chains,
  chainToPlatform,
  toUniversal,
  UniversalAddress,
  isNetwork,
  type Chain,
  type Network,
} from "@wormhole-foundation/sdk";
import type { WormholeConfigOverrides } from "@wormhole-foundation/sdk-connect";
import type { Ntt } from "@wormhole-foundation/sdk-definitions-ntt";
import type { Argv } from "yargs";
import { colors } from "../colors.js";
import { options, resolveRpcConcurrency } from "./shared";
import { loadConfig, type ChainConfig } from "../deployments";
import { retryWithExponentialBackoff } from "../validation";
import { pullChainConfig, pullInboundLimits } from "../index";
import { runTaskPoolWithSequential } from "../utils/concurrency";
import type { Config } from "../deployments";

export function createCloneCommand(
  overrides: WormholeConfigOverrides<Network>
) {
  return {
    command: "clone <network> <chain> <address>",
    describe: "initialize a deployment file from an existing contract",
    builder: (yargs: Argv) =>
      yargs
        .positional("network", options.network)
        .positional("chain", options.chain)
        .positional("address", options.address)
        .option("path", options.deploymentPath)
        .option("verbose", options.verbose)
        .option("rpc-concurrency", options.rpcConcurrency)
        .example(
          "$0 clone Testnet Ethereum 0x5678...",
          "Clone an existing Ethereum deployment on Testnet"
        )
        .example(
          "$0 clone Mainnet Solana Sol5678... --path custom-clone.json",
          "Clone an existing Solana deployment on Mainnet to a custom file"
        ),
    handler: async (argv: any) => {
      if (!isNetwork(argv["network"])) {
        console.error("Invalid network");
        process.exit(1);
      }

      const path = argv["path"];
      const verbose = argv["verbose"];
      const maxConcurrent = resolveRpcConcurrency(argv["rpc-concurrency"]);
      // check if the file exists
      if (fs.existsSync(path)) {
        console.error(`Deployment file already exists at ${path}`);
        process.exit(1);
      }

      // step 1. grab the config
      // step 2. discover registrations
      // step 3. grab registered peer configs
      //
      // NOTE: we don't recursively grab peer configs. This means the
      // discovered peers will be the ones that are directly registered with
      // the starting manager (the one we're cloning).
      // For example, if we're cloning manager A, and it's registered with
      // B, and B is registered with C, but C is not registered with A, then
      // C will not be included in the cloned deployment.
      // We could do peer discovery recursively but that would be a lot
      // slower, since peer discovery is already O(n) in the number of
      // supported chains (50+), because there is no way to enumerate the peers, so we
      // need to query all possible chains to see if they're registered.

      const chain = argv["chain"];
      assertChain(chain);

      const manager = argv["address"];
      const network = argv["network"];

      const universalManager = toUniversal(chain, manager);

      const ntts: Partial<{ [C in Chain]: Ntt<Network, C> }> = {};

      const [config, _ctx, ntt, _decimals] = await pullChainConfig(
        network,
        { chain, address: universalManager },
        overrides
      );

      ntts[chain] = ntt as any;

      const configs: Partial<{ [C in Chain]: ChainConfig }> = {
        [chain]: config,
      };

      let lastStatusLineLength = 0;
      const updateStatusLine = (message: string) => {
        if (!process.stdout.isTTY) {
          return;
        }
        const padded = message.padEnd(lastStatusLineLength, " ");
        process.stdout.write(`\r${padded}`);
        lastStatusLineLength = Math.max(lastStatusLineLength, message.length);
      };
      const finishStatusLine = () => {
        if (!process.stdout.isTTY) {
          return;
        }
        if (lastStatusLineLength > 0) {
          process.stdout.write("\n");
        }
      };
      const formatError = (error: unknown) =>
        error instanceof Error ? error.message : String(error);

      // discover peers
      type PeerResult =
        | {
            chain: Chain;
            status: "ok";
            config: ChainConfig;
            ntt: Ntt<Network, Chain>;
          }
        | { chain: Chain; status: "none" }
        | {
            chain: Chain;
            status: "error";
            stage: "peer" | "config";
            error: unknown;
          };
      const peerChains = chains.filter((c) => c !== chain);
      const total = peerChains.length;

      const fetchPeerConfig = async (c: Chain): Promise<PeerResult> => {
        let peer: Awaited<ReturnType<typeof ntt.getPeer>> | null = null;
        try {
          peer = await retryWithExponentialBackoff(
            () => ntt.getPeer(c),
            5,
            5000
          );
        } catch (e) {
          return { chain: c, status: "error", stage: "peer", error: e };
        }
        if (peer === null) {
          return { chain: c, status: "none" };
        }
        const address: UniversalAddress =
          peer.address.address.toUniversalAddress();
        try {
          const [peerConfig, _ctx, peerNtt] = await pullChainConfig(
            network,
            { chain: c, address },
            overrides
          );
          return {
            chain: c,
            status: "ok",
            config: peerConfig,
            ntt: peerNtt as any,
          };
        } catch (e) {
          return { chain: c, status: "error", stage: "config", error: e };
        }
      };

      let completed = 0;
      const peerResults = await runTaskPoolWithSequential(
        peerChains,
        maxConcurrent,
        (item) => chainToPlatform(item) === "Solana",
        async (item) => {
          const result = await fetchPeerConfig(item);
          completed++;
          updateStatusLine(
            `[${completed}/${total}] Fetched peer config for ${item}`
          );
          return result;
        }
      );
      updateStatusLine(
        `[${total}/${total}] Completed attempt fetching peer config for ${total} chain${
          total === 1 ? "" : "s"
        }.`
      );
      finishStatusLine();

      const peerErrors: {
        chain: Chain;
        stage: "peer" | "config";
        error: unknown;
      }[] = [];
      for (const result of peerResults) {
        if (result.status === "ok") {
          ntts[result.chain] = result.ntt as any;
          configs[result.chain] = result.config;
        } else if (result.status === "error") {
          peerErrors.push({
            chain: result.chain,
            stage: result.stage,
            error: result.error,
          });
        }
      }

      // sort chains by name
      const sorted = Object.fromEntries(
        Object.entries(configs).sort(([a], [b]) => a.localeCompare(b))
      );

      // sleep for a bit to avoid rate limiting when making the getDecimals call
      // this can happen when the last we hit the rate limit just in the last iteration of the loop above.
      // (happens more often than you'd think, because the rate limiter
      // gets more aggressive after each hit)
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // now loop through the chains, and query their peer information to get the inbound limits
      await pullInboundLimits(ntts, sorted, verbose, maxConcurrent);

      const deployment: Config = {
        network: argv["network"],
        chains: sorted,
      };
      fs.writeFileSync(path, JSON.stringify(deployment, null, 2));

      if (peerErrors.length > 0) {
        const chainsWithErrors = Array.from(
          new Set(peerErrors.map((entry) => entry.chain))
        ).sort((a, b) => a.localeCompare(b));
        console.error(
          `Completed with errors for ${chainsWithErrors.length} chain(s): ${chainsWithErrors.join(", ")}`
        );
        if (verbose) {
          for (const { chain: errorChain, stage, error } of peerErrors) {
            console.warn(`  - ${errorChain} (${stage}): ${formatError(error)}`);
          }
        } else {
          console.warn("Run with --verbose to see details.");
        }
      } else {
        console.log(
          colors.green(`Deployment file created successfully: ${path}`)
        );
      }
    },
  };
}
