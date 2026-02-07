import fs from "fs";
import {
  assertChain,
  chains,
  toUniversal,
  UniversalAddress,
  isNetwork,
  type Chain,
  type Network,
} from "@wormhole-foundation/sdk";
import type { WormholeConfigOverrides } from "@wormhole-foundation/sdk-connect";
import type { Ntt } from "@wormhole-foundation/sdk-definitions-ntt";
import type { Argv } from "yargs";
import { options } from "./shared";
import { loadConfig, type ChainConfig } from "../deployments";
import { retryWithExponentialBackoff } from "../validation";
import { pullChainConfig, pullInboundLimits } from "../index";
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

      // discover peers
      let count = 0;
      for (const c of chains) {
        process.stdout.write(
          `[${count}/${chains.length - 1}] Fetching peer config for ${c}`
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        count++;

        const peer = await retryWithExponentialBackoff(
          () => ntt.getPeer(c),
          5,
          5000
        );

        process.stdout.write(`\n`);
        if (peer === null) {
          continue;
        }
        const address: UniversalAddress =
          peer.address.address.toUniversalAddress();
        try {
          const [peerConfig, _ctx, peerNtt] = await pullChainConfig(
            network,
            { chain: c, address },
            overrides
          );
          ntts[c] = peerNtt as any;
          configs[c] = peerConfig;
        } catch (e) {
          console.error(`Failed to pull config for ${c}:`, e);
          continue;
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
      await pullInboundLimits(ntts, sorted, verbose);

      const deployment: Config = {
        network: argv["network"],
        chains: sorted,
      };
      fs.writeFileSync(path, JSON.stringify(deployment, null, 2));
    },
  };
}
