#!/usr/bin/env bun
import "./side-effects"; // doesn't quite work for silencing the bigint error message. why?
import evm from "@wormhole-foundation/sdk/platforms/evm";
import solana from "@wormhole-foundation/sdk/platforms/solana";
import { encoding, type RpcConnection, type UnsignedTransaction, type WormholeConfigOverrides } from '@wormhole-foundation/sdk-connect';
import { execSync } from "child_process";
import * as myEvmSigner from "./evmsigner.js";

import evmDeployFile from "../../evm/script/DeployWormholeNtt.s.sol" with { type: "file" };
import evmDeployFileHelper from "../../evm/script/helpers/DeployWormholeNttBase.sol" with { type: "file" };

import chalk from "chalk";
import yargs from "yargs";
import { $ } from "bun";
import { hideBin } from "yargs/helpers";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as spl from "@solana/spl-token";
import fs from "fs";
import readline from "readline";
import { ChainContext, UniversalAddress, Wormhole, assertChain, canonicalAddress, chainToPlatform, chains, isNetwork, networks, platforms, signSendWait, toUniversal, type AccountAddress, type Chain, type ChainAddress, type Network, type Platform } from "@wormhole-foundation/sdk";
import "@wormhole-foundation/sdk-evm-ntt";
import "@wormhole-foundation/sdk-solana-ntt";
import "@wormhole-foundation/sdk-definitions-ntt";
import type { Ntt, NttTransceiver } from "@wormhole-foundation/sdk-definitions-ntt";

import { type SolanaChains, SolanaAddress } from "@wormhole-foundation/sdk-solana";

import { colorizeDiff, diffObjects } from "./diff";
import { forgeSignerArgs, getSigner, type SignerType } from "./getSigner";
import { NTT, SolanaNtt } from "@wormhole-foundation/sdk-solana-ntt";
import type { EvmNtt, EvmNttWormholeTranceiver } from "@wormhole-foundation/sdk-evm-ntt";
import type { EvmChains, EvmNativeSigner, EvmUnsignedTransaction } from "@wormhole-foundation/sdk-evm";
import { getAvailableVersions, getGitTagName } from "./tag";
import * as configuration from "./configuration";
import { AbiCoder, ethers, Interface } from "ethers";
import { newSignSendWaiter, signSendWaitWithOverride } from "./signSendWait.js";

// TODO: contract upgrades on solana
// TODO: set special relaying?
// TODO: currently, we just default all evm chains to standard relaying. should we not do that? what's a good way to configure this?

// TODO: check if manager can mint the token in burning mode (on solana it's
// simple. on evm we need to simulate with prank)
const overrides: WormholeConfigOverrides<Network> = (function () {
    // read overrides.json file if exists
    if (fs.existsSync("overrides.json")) {
        console.error(chalk.yellow("Using overrides.json"));
        return JSON.parse(fs.readFileSync("overrides.json").toString());
    } else {
        return {};
    }
})();

export type Deployment<C extends Chain> = {
    ctx: ChainContext<Network, C>,
    ntt: Ntt<Network, C>,
    whTransceiver: NttTransceiver<Network, C, Ntt.Attestation>,
    decimals: number,
    manager: ChainAddress<C>,
    config: {
        remote?: ChainConfig,
        local?: ChainConfig,
    },
}

// TODO: rename
export type ChainConfig = {
    version: string,
    mode: Ntt.Mode,
    paused: boolean,
    owner: string,
    pauser?: string,
    manager: string,
    token: string,
    transceivers: {
        threshold: number,
        wormhole: { address: string, pauser?: string },
    },
    limits: {
        outbound: string,
        inbound: Partial<{ [C in Chain]: string }>,
    }
}

export type Config = {
    network: Network,
    chains: Partial<{
        [C in Chain]: ChainConfig
    }>,
    defaultLimits?: {
        outbound: string,
    }
}

const options = {
    network: {
        alias: "n",
        describe: "Network",
        choices: networks,
        demandOption: true,
    },
    deploymentPath: {
        alias: "p",
        describe: "Path to the deployment file",
        default: "deployment.json",
        type: "string",
    },
    yes: {
        alias: "y",
        describe: "Skip confirmation",
        type: "boolean",
        default: false,
    },
    signerType: {
        alias: "s",
        describe: "Signer type",
        type: "string",
        choices: ["privateKey", "ledger"],
        default: "privateKey",
    },
    verbose: {
        alias: "v",
        describe: "Verbose output",
        type: "boolean",
        default: false,
    },
    chain: {
        describe: "Chain",
        type: "string",
        choices: chains,
        demandOption: true,
    },
    address: {
        describe: "Address",
        type: "string",
        demandOption: true,
    },
    local: {
        describe: "Use the current local version for deployment (advanced).",
        type: "boolean",
        default: false,
    },
    version: {
        describe: "Version of NTT to deploy",
        type: "string",
        demandOption: false,
    },
    latest: {
        describe: "Use the latest version",
        type: "boolean",
        default: false,
    },
    platform: {
        describe: "Platform",
        type: "string",
        choices: platforms,
        demandOption: true,
    },
    skipVerify:
    {
        describe: "Skip contract verification",
        type: "boolean",
        default: false,
    },
    payer: {
        describe: "Path to the payer json file (Solana)",
        type: "string",
    },
    skipChain: {
        describe: "Skip chains",
        type: "array",
        choices: chains,
    },
    onlyChain: {
        describe: "Only do these chains (can be skipped)",
        type: "array",
        choices: chains,
    }
} as const;


// TODO: this is a temporary hack to allow deploying from main (as we only need
// the changes to the evm script)
async function withCustomEvmDeployerScript<A>(pwd: string, then: () => Promise<A>): Promise<A> {
    ensureNttRoot(pwd);
    const overrides = [
        { path: `${pwd}/evm/script/DeployWormholeNtt.s.sol`, with: evmDeployFile },
        { path: `${pwd}/evm/script/helpers/DeployWormholeNttBase.sol`, with: evmDeployFileHelper },
    ]
    for (const { path, with: withFile } of overrides) {
        const old = `${path}.old`;
        if (fs.existsSync(path)) {
            fs.copyFileSync(path, old);
        }
        fs.copyFileSync(withFile, path);
    }
    try {
        return await then()
    } finally {
        // restore old files
        for (const { path } of overrides) {
            const old = `${path}.old`;
            if (fs.existsSync(old)) {
                fs.copyFileSync(old, path);
                fs.unlinkSync(old);
            }
        }
    }
}

yargs(hideBin(process.argv))
    .wrap(Math.min(process.stdout.columns || 120, 160)) // Use terminal width, but no more than 160 characters
    .scriptName("ntt")
    .version((() => {
        const ver = nttVersion();
        if (!ver) {
            return "unknown";
        }
        const { version, commit, path, remote } = ver;
        const defaultPath = `${process.env.HOME}/.ntt-cli/.checkout`;
        const remoteString = remote.includes("wormhole-foundation") ? "" : `${remote}@`;
        if (path === defaultPath) {
            return `ntt v${version} (${remoteString}${commit})`;
        } else {
            return `ntt v${version} (${remoteString}${commit}) from ${path}`;
        }
    })())
    // config group of commands
    .command("config",
        "configuration commands",
        configuration.command
    )
    .command("update",
        "update the NTT CLI",
        (yargs) => yargs
            .option("path", {
                describe: "Path to a local NTT repo to install from. If not specified, the latest version will be installed.",
                type: "string",
            })
            .option("branch", {
                describe: "Git branch to install from",
                type: "string",
            })
            .option("repo", {
                describe: "Git repository to install from",
                type: "string",
            })
            .example("$0 update", "Update the NTT CLI to the latest version")
            .example("$0 update --path /path/to/ntt", "Update the NTT CLI from a local repo")
            .example("$0 update --branch cli", "Update the NTT CLI to the cli branch"),
        async (argv) => {
            const localPath = argv["path"];
            if (localPath) {
                if (argv["ref"]) {
                    console.error("Cannot specify both --path and --ref");
                    process.exit(1);
                }
                if (argv["repo"]) {
                    console.error("Cannot specify both --path and --repo");
                    process.exit(1);
                }
                await $`${localPath}/cli/install.sh`;
            } else {
                let branchArg = "";
                let repoArg = "";
                if (argv["branch"]) {
                    branchArg = `--branch ${argv["branch"]}`;
                }
                if (argv["repo"]) {
                    repoArg = `--repo ${argv["repo"]}`;
                }
                const installScript = "https://raw.githubusercontent.com/wormhole-foundation/example-native-token-transfers/main/cli/install.sh";
                // save it to "$HOME/.ntt-cli/install.sh"
                const nttDir = `${process.env.HOME}/.ntt-cli`;
                const installer = `${nttDir}/install.sh`;
                execSync(`mkdir -p ${nttDir}`);
                execSync(`curl -s ${installScript} > ${installer}`);
                execSync(`chmod +x ${installer}`);
                execSync(`${installer} ${branchArg} ${repoArg}`, { stdio: "inherit" });
            }
        })
    .command("new <path>",
        "create a new NTT project",
        (yargs) => yargs
            .positional("path", {
                describe: "Path to the project",
                type: "string",
                demandOption: true,
            })
            .example("$0 new my-ntt-project", "Create a new NTT project in the 'my-ntt-project' directory"),
        async (argv) => {
            const git = execSync("git rev-parse --is-inside-work-tree || echo false", {
                stdio: ["inherit", null, null]
            });
            if (git.toString().trim() === "true") {
                console.error("Already in a git repository");
                process.exit(1);
            }
            const path = argv["path"];
            await $`git clone -b main https://github.com/wormhole-foundation/example-native-token-transfers.git ${path}`;
        })
    .command("add-chain <chain>",
        "add a chain to the deployment file",
        (yargs) => yargs
            .positional("chain", options.chain)
            // TODO: add ability to specify manager address (then just pull the config)
            // .option("manager", {
            //     describe: "Manager address",
            //     type: "string",
            // })
            .option("program-key", {
                describe: "Path to program key json (Solana)",
                type: "string",
            })
            .option("payer", {
                describe: "Path to payer key json (Solana)",
                type: "string",
            })
            .option("binary", {
                describe: "Path to program binary (.so file -- Solana)",
                type: "string",
            })
            .option("token", {
                describe: "Token address",
                type: "string",
            })
            .option("mode", {
                alias: "m",
                describe: "Mode",
                type: "string",
                choices: ["locking", "burning"],
            })
            .option("solana-priority-fee", {
                describe: "Priority fee for Solana deployment (in microlamports)",
                type: "number",
                default: 50000,
            })
            .option("signer-type", options.signerType)
            .option("skip-verify", options.skipVerify)
            .option("ver", options.version)
            .option("latest", options.latest)
            .option("local", options.local)
            .option("path", options.deploymentPath)
            .option("yes", options.yes)
            .example("$0 add-chain Ethereum --token 0x1234... --mode burning --latest", "Add Ethereum chain with the latest contract version in burning mode")
            .example("$0 add-chain Solana --token Sol1234... --mode locking --ver 1.0.0", "Add Solana chain with a specific contract version in locking mode")
            .example("$0 add-chain Avalanche --token 0xabcd... --mode burning --local", "Add Avalanche chain using the local contract version"),
        async (argv) => {
            const path = argv["path"];
            const deployments: Config = loadConfig(path);
            const chain: Chain = argv["chain"];
            const version = resolveVersion(argv["latest"], argv["ver"], argv["local"], chainToPlatform(chain));
            let mode = argv["mode"] as Ntt.Mode | undefined;
            const signerType = argv["signer-type"] as SignerType;
            const token = argv["token"];
            const network = deployments.network as Network;

            if (chain in deployments.chains) {
                console.error(`Chain ${chain} already exists in ${path}`);
                process.exit(1);
            }

            validateChain(network, chain);

            const existsLocking = Object.values(deployments.chains).some((c) => c.mode === "locking");

            if (existsLocking) {
                if (mode && mode === "locking") {
                    console.error("Only one locking chain is allowed");
                    process.exit(1);
                }
                mode = "burning";
            }

            if (!mode) {
                console.error("Mode is required (use --mode)");
                process.exit(1);
            }

            if (!token) {
                console.error("Token is required (use --token)");
                process.exit(1);
            }

            // let's deploy

            // TODO: factor out to function to get chain context
            const wh = new Wormhole(network, [solana.Platform, evm.Platform], overrides);
            const ch = wh.getChain(chain);

            // TODO: make manager configurable
            const deployedManager = await deploy(version, mode, ch, token, signerType, !argv["skip-verify"], argv["yes"], argv["payer"], argv["program-key"], argv["binary"], argv["solana-priority-fee"]);

            const [config, _ctx, _ntt, decimals] =
                await pullChainConfig(network, deployedManager, overrides);

            console.log("token decimals:", chalk.yellow(decimals));

            deployments.chains[chain] = config;
            fs.writeFileSync(path, JSON.stringify(deployments, null, 2));
            console.log(`Added ${chain} to ${path}`);
        })
    .command("upgrade <chain>",
        "upgrade the contract on a specific chain",
        (yargs) => yargs
            .positional("chain", options.chain)
            .option("ver", options.version)
            .option("latest", {
                describe: "Use the latest version",
                type: "boolean",
                default: false,
            })
            .option("local", options.local)
            .option("signer-type", options.signerType)
            .option("skip-verify", options.skipVerify)
            .option("path", options.deploymentPath)
            .option("yes", options.yes)
            .option("payer", {
                describe: "Path to payer key json (Solana)",
                type: "string",
            })
            .option("program-key", {
                describe: "Path to program key json (Solana)",
                type: "string",
            })
            .option("binary", {
                describe: "Path to program binary (.so file -- Solana)",
                type: "string",
            })
            .example("$0 upgrade Ethereum --latest", "Upgrade the Ethereum contract to the latest version")
            .example("$0 upgrade Solana --ver 1.1.0", "Upgrade the Solana contract to version 1.1.0")
            .example("$0 upgrade Polygon --local --skip-verify", "Upgrade the Polygon contract using the local version, skipping explorer bytecode verification"),
        async (argv) => {
            const path = argv["path"];
            const deployments: Config = loadConfig(path);
            const chain: Chain = argv["chain"];
            const signerType = argv["signer-type"] as SignerType;
            const network = deployments.network as Network;

            if (!(chain in deployments.chains)) {
                console.error(`Chain ${chain} not found in ${path}`);
                process.exit(1);
            }

            const chainConfig = deployments.chains[chain]!;
            const currentVersion = chainConfig.version;
            const platform = chainToPlatform(chain);

            const toVersion = resolveVersion(argv["latest"], argv["ver"], argv["local"], platform);

            if (argv["local"]) {
                await warnLocalDeployment(argv["yes"]);
            }

            if (toVersion === currentVersion && !argv["local"]) {
                console.log(`Chain ${chain} is already at version ${currentVersion}`);
                process.exit(0);
            }

            console.log(`Upgrading ${chain} from version ${currentVersion} to ${toVersion || 'local version'}`);

            if (!argv["yes"]) {
                await askForConfirmation();
            }

            const wh = new Wormhole(network, [solana.Platform, evm.Platform], overrides);
            const ch = wh.getChain(chain);

            const [_, ctx, ntt] = await pullChainConfig(
                network,
                { chain, address: toUniversal(chain, chainConfig.manager) },
                overrides
            );

            await upgrade(
                currentVersion,
                toVersion,
                ntt,
                ctx,
                signerType,
                !argv["skip-verify"],
                argv["payer"],
                argv["program-key"],
                argv["binary"]
            );

            // reinit the ntt object to get the new version
            // TODO: is there an easier way to do this?
            const { ntt: upgraded } = await nttFromManager(ch, chainConfig.manager);

            chainConfig.version = getVersion(chain, upgraded)
            fs.writeFileSync(path, JSON.stringify(deployments, null, 2));

            console.log(`Successfully upgraded ${chain} to version ${toVersion || 'local version'}`);
        }
    )
    .command("clone <network> <chain> <address>",
        "initialize a deployment file from an existing contract",
        (yargs) => yargs
            .positional("network", options.network)
            .positional("chain", options.chain)
            .positional("address", options.address)
            .option("path", options.deploymentPath)
            .option("verbose", options.verbose)
            .example("$0 clone Testnet Ethereum 0x5678...", "Clone an existing Ethereum deployment on Testnet")
            .example("$0 clone Mainnet Solana Sol5678... --path custom-clone.json", "Clone an existing Solana deployment on Mainnet to a custom file"),
        async (argv) => {
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
            assertChain(chain)

            const manager = argv["address"];
            const network = argv["network"];

            const universalManager = toUniversal(chain, manager);

            const ntts: Partial<{ [C in Chain]: Ntt<Network, C> }> = {};

            const [config, _ctx, ntt, _decimals] =
                await pullChainConfig(network, { chain, address: universalManager }, overrides);

            ntts[chain] = ntt as any;

            const configs: Partial<{ [C in Chain]: ChainConfig }> = {
                [chain]: config,
            }

            // discover peers
            let count = 0;
            for (const c of chains) {
                process.stdout.write(`[${count}/${chains.length - 1}] Fetching peer config for ${c}`);
                await new Promise((resolve) => setTimeout(resolve, 100));
                count++;

                const peer = await retryWithExponentialBackoff(() => ntt.getPeer(c), 5, 5000);

                process.stdout.write(`\n`);
                if (peer === null) {
                    continue;
                }
                const address: UniversalAddress = peer.address.address.toUniversalAddress()
                const [peerConfig, _ctx, peerNtt] = await pullChainConfig(network, { chain: c, address }, overrides);
                ntts[c] = peerNtt as any;
                configs[c] = peerConfig;
            }

            // sort chains by name
            const sorted = Object.fromEntries(Object.entries(configs).sort(([a], [b]) => a.localeCompare(b)));

            // sleep for a bit to avoid rate limiting when making the getDecimals call
            // this can happen when the last we hit the rate limit just in the last iteration of the loop above.
            // (happens more often than you'd think, because the rate limiter
            // gets more aggressive after each hit)
            await new Promise((resolve) => setTimeout(resolve, 2000));

            // now loop through the chains, and query their peer information to get the inbound limits
            await pullInboundLimits(ntts, sorted, verbose)

            const deployment: Config = {
                network: argv["network"],
                chains: sorted,
            };
            fs.writeFileSync(path, JSON.stringify(deployment, null, 2));
        })
    .command("init <network>",
        "initialize a deployment file",
        (yargs) => yargs
            .positional("network", options.network)
            .option("path", options.deploymentPath)
            .example("$0 init Testnet", "Initialize a new deployment file for the Testnet network")
            .example("$0 init Mainnet --path custom.json", "Initialize a new deployment file for Mainnet with a custom file name"),
        async (argv) => {
            if (!isNetwork(argv["network"])) {
                console.error("Invalid network");
                process.exit(1);
            }
            const deployment = {
                network: argv["network"],
                chains: {},
            };
            const path = argv["path"];
            // check if the file exists
            if (fs.existsSync(path)) {
                console.error(`Deployment file already exists at ${path}. Specify a different path with --path`);
                process.exit(1);
            }
            fs.writeFileSync(path, JSON.stringify(deployment, null, 2));
        })
    .command("pull",
        "pull the remote configuration",
        (yargs) => yargs
            .option("path", options.deploymentPath)
            .option("yes", options.yes)
            .option("verbose", options.verbose)
            .example("$0 pull", "Pull the latest configuration from the blockchain for all chains")
            .example("$0 pull --yes", "Pull the latest configuration and apply changes without confirmation"),
        async (argv) => {
            const deployments: Config = loadConfig(argv["path"]);
            const verbose = argv["verbose"];
            const network = deployments.network as Network;
            const path = argv["path"];
            const deps: Partial<{ [C in Chain]: Deployment<Chain> }> = await pullDeployments(deployments, network, verbose);

            let changed = false;
            for (const [chain, deployment] of Object.entries(deps)) {
                assertChain(chain);
                const diff = diffObjects(deployments.chains[chain]!, deployment.config.remote!);
                if (Object.keys(diff).length !== 0) {
                    console.error(chalk.reset(colorizeDiff({ [chain]: diff })));
                    changed = true;
                    deployments.chains[chain] = deployment.config.remote!
                }
            }
            if (!changed) {
                console.log(`${path} is already up to date`);
                process.exit(0);
            }

            if (!argv["yes"]) {
                await askForConfirmation();
            }
            fs.writeFileSync(path, JSON.stringify(deployments, null, 2));
            console.log(`Updated ${path}`);
        })
    .command("push",
        "push the local configuration",
        (yargs) => yargs
            .option("path", options.deploymentPath)
            .option("yes", options.yes)
            .option("signer-type", options.signerType)
            .option("verbose", options.verbose)
            .option("skip-verify", options.skipVerify)
            .option("payer", options.payer)
            .option("skip-chain", options.skipChain)
            .option("only-chain", options.onlyChain)
            .example("$0 push", "Push local configuration changes to the blockchain")
            .example("$0 push --signer-type ledger", "Push changes using a Ledger hardware wallet for signing")
            .example("$0 push --skip-verify", "Push changes without verifying contracts on EVM chains")
            .example("$0 push --payer <SOLANA_KEYPAIR_PATH>", "Path to the payer json file (Solana), instead of setting SOLANA_PRIVATE_KEY env variable"),
        async (argv) => {
            const deployments: Config = loadConfig(argv["path"]);
            const verbose = argv["verbose"];
            const network = deployments.network as Network;
            const deps: Partial<{ [C in Chain]: Deployment<Chain> }> = await pullDeployments(deployments, network, verbose);
            const signerType = argv["signer-type"] as SignerType;
            const payerPath = argv["payer"];
            const skipChains = argv["skip-chain"] as string[] || [];
            const onlyChains = argv["only-chain"] as string[] || [];
            const shouldSkipChain = (chain: string) => {
                if(onlyChains.length > 0) {
                    if(!onlyChains.includes(chain)) {
                        return true
                    }
                }
                if(skipChains.includes(chain)) {
                    return true
                }
                return false
            }
            const missing = await missingConfigs(deps, verbose);

            if (checkConfigErrors(deps)) {
                console.error("There are errors in the config file. Please fix these before continuing.");
                process.exit(1);
            }

            const nttOwnerForChain: Record<string, string | undefined> = {};


            for (const [chain, _] of Object.entries(deps)) {
                if(shouldSkipChain(chain)) {
                    console.log(`skipping registration for chain ${chain}`)
                    continue
                }
                assertChain(chain);
                if (chainToPlatform(chain) === "Evm") {
                    const ntt = deps[chain]!.ntt;
                    const ctx = deps[chain]!.ctx;
                    const signer = await getSigner(ctx, signerType, undefined, payerPath);
                    const rpc = ctx.config.rpc;
                    const provider = new ethers.JsonRpcProvider(rpc);
                    // get the owner of the ntt manager
                    const contractOwner = await ntt.getOwner();
                    // check if the owner has data to see if it is a smart contract
                    if(!signer.address.address.equals(contractOwner.toUniversalAddress())) {
                        const contractCode = await provider.getCode(contractOwner.address.toString())
                        if(contractCode.length <= 2) {
                            console.error(`cannot update ${chain} because the configured private key does not correspond to owner ${contractOwner.address}`)
                            continue
                        } else {
                            const eip165Interface = new Interface([
                                "function supportsInterface(bytes4 interfaceId) external view returns (bool)",
                            ] as const)
                            const callData = eip165Interface.encodeFunctionData("supportsInterface", ["0x43412b75"])
                            const supports = await provider.call({
                                to: contractOwner.toString(),
                                data: callData,
                            })
                            const supportsInt = parseInt(supports)
                            if(supportsInt !== 1)  {
                                console.error(`cannot update ${chain} because the owning contract does not implement INttOwner`)
                                process.exit(1)
                            }
                            nttOwnerForChain[chain] = contractOwner.toString()
                        }
                    }
                }
            }
            for (const [chain, missingConfig] of Object.entries(missing)) {
                if(shouldSkipChain(chain)) {
                    console.log(`skipping registration for chain ${chain}`)
                    continue
                }
                assertChain(chain);
                const ntt = deps[chain]!.ntt;
                const ctx = deps[chain]!.ctx;
                const signer = await getSigner(ctx, signerType, undefined, payerPath);
                const signSendWaitFunc = newSignSendWaiter(nttOwnerForChain[chain])
                for (const manager of missingConfig.managerPeers) {
                    const tx = ntt.setPeer(manager.address, manager.tokenDecimals, manager.inboundLimit, signer.address.address)
                    await signSendWaitFunc(ctx, tx, signer.signer)
                }
                for (const transceiver of missingConfig.transceiverPeers) {
                    const tx = ntt.setTransceiverPeer(0, transceiver, signer.address.address)
                    await signSendWaitFunc(ctx, tx, signer.signer)
                }
                for (const evmChain of missingConfig.evmChains) {
                    const tx = (await ntt.getTransceiver(0) as EvmNttWormholeTranceiver<Network, EvmChains>).setIsEvmChain(evmChain, true)
                    await signSendWaitFunc(ctx, tx, signer.signer)
                }
                for (const relayingTarget of missingConfig.standardRelaying) {
                    const tx = (await ntt.getTransceiver(0) as EvmNttWormholeTranceiver<Network, EvmChains>).setIsWormholeRelayingEnabled(relayingTarget, true)
                    await signSendWaitFunc(ctx, tx, signer.signer)
                }
                for (const relayingTarget of missingConfig.specialRelaying) {
                    const tx = (await ntt.getTransceiver(0) as EvmNttWormholeTranceiver<Network, EvmChains>).setIsSpecialRelayingEnabled(relayingTarget, true)
                    await signSendWaitFunc(ctx, tx, signer.signer)
                }
                if (missingConfig.solanaWormholeTransceiver) {
                    if (chainToPlatform(chain) !== "Solana") {
                        console.error("Solana wormhole transceiver can only be set on Solana chains");
                        continue;
                    }
                    const solanaNtt = ntt as SolanaNtt<Network, SolanaChains>;
                    const tx = solanaNtt.registerWormholeTransceiver({
                        payer: signer.address.address as AccountAddress<SolanaChains>,
                        owner: signer.address.address as AccountAddress<SolanaChains>,
                    })
                    try {
                        await signSendWait(ctx, tx, signer.signer)
                    } catch (e: any) {
                        console.error(e.logs);
                    }
                }
                if (missingConfig.solanaUpdateLUT) {
                    if (chainToPlatform(chain) !== "Solana") {
                        console.error("Solana update LUT can only be set on Solana chains");
                        continue;
                    }
                    const solanaNtt = ntt as SolanaNtt<Network, SolanaChains>;
                    const tx = solanaNtt.initializeOrUpdateLUT({ payer: new SolanaAddress(signer.address.address).unwrap() })
                    try {
                        await signSendWait(ctx, tx, signer.signer)
                    } catch (e: any) {
                        console.error(e.logs);
                    }
                }
            }

            // pull deps again
            const depsAfterRegistrations: Partial<{ [C in Chain]: Deployment<Chain> }> = await pullDeployments(deployments, network, verbose);

            for (const [chain, deployment] of Object.entries(depsAfterRegistrations)) {
                if(shouldSkipChain(chain)) {
                    console.log(`skipping deployment for chain ${chain}`)
                    continue
                }
                assertChain(chain);
                const signSendWaitFunc = newSignSendWaiter(nttOwnerForChain[chain])
                await pushDeployment(deployment as any,
                    signSendWaitFunc,
                    signerType, !argv["skip-verify"], argv["yes"], payerPath);
            }
        })
    .command("status",
        "check the status of the deployment",
        (yargs) => yargs
            .option("path", options.deploymentPath)
            .option("verbose", options.verbose)
            .example("$0 status", "Check the status of the deployment across all chains")
            .example("$0 status --verbose", "Check the status with detailed output"),
        async (argv) => {
            const path = argv["path"];
            const verbose = argv["verbose"];
            // TODO: I don't like the variable names here
            const deployments: Config = loadConfig(path);

            const network = deployments.network as Network;

            let deps: Partial<{ [C in Chain]: Deployment<Chain> }> = await pullDeployments(deployments, network, verbose);

            let fixable = 0;

            const extraInfo: any = {};

            if (checkConfigErrors(deps)) {
                console.error("There are errors in the config file. Please fix these before continuing.");
                process.exit(1);
            }

            // diff remote and local configs
            for (const [chain, deployment] of Object.entries(deps)) {
                assertChain(chain);
                const local = deployment.config.local;
                const remote = deployment.config.remote;
                const a = { [chain]: local! };
                const b = { [chain]: remote! };

                const diff = diffObjects(a, b);
                if (Object.keys(diff).length !== 0) {
                    console.error(chalk.reset(colorizeDiff(diff)));
                    fixable++;
                }

                if (verbose) {
                    const immutables = await getImmutables(chain, deployment.ntt);
                    if (immutables) {
                        extraInfo[chain] = immutables;
                    }
                    const pdas = await getPdas(chain, deployment.ntt);
                    if (pdas) {
                        extraInfo[chain] = pdas;
                    }
                }
            }

            if (Object.keys(extraInfo).length > 0) {
                console.log(chalk.yellow(JSON.stringify(extraInfo, null, 2)));
            }

            // verify peers
            const missing = await missingConfigs(deps, verbose);

            if (Object.keys(missing).length > 0) {
                fixable++;
            }

            for (const [chain, missingConfig] of Object.entries(missing)) {
                console.error(`${chain} status:`);
                for (const manager of missingConfig.managerPeers) {
                    console.error(`  Missing manager peer: ${manager.address.chain}`);
                }
                for (const transceiver of missingConfig.transceiverPeers) {
                    console.error(`  Missing transceiver peer: ${transceiver.chain}`);
                }
                for (const evmChain of missingConfig.evmChains) {
                    console.error(`  ${evmChain} needs to be configured as an EVM chain`);
                }
                for (const relayingTarget of missingConfig.standardRelaying) {
                    console.warn(`  No standard relaying to ${relayingTarget}`);
                }
                for (const relayingTarget of missingConfig.specialRelaying) {
                    console.warn(`  No special relaying to ${relayingTarget}`);
                }
                if (missingConfig.solanaWormholeTransceiver) {
                    console.error("  Missing Solana wormhole transceiver");
                }
                if (missingConfig.solanaUpdateLUT) {
                    console.error("  Missing or outdated LUT");
                }
            }

            if (fixable > 0) {
                console.error("Run `ntt pull` to pull the remote configuration (overwriting the local one)");
                console.error("Run `ntt push` to push the local configuration (overwriting the remote one) by executing the necessary transactions");
                process.exit(1);
            } else {
                console.log(`${path} is up to date with the on-chain configuration.`);
                process.exit(0);
            }
        })
    .command("solana",
        "Solana commands",
        (yargs) => {
            yargs
                .command("key-base58 <keypair>",
                    "print private key in base58",
                    (yargs) => yargs
                        .positional("keypair", {
                            describe: "Path to keypair.json",
                            type: "string",
                            demandOption: true,
                        }),
                    (argv) => {
                        const keypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(argv["keypair"]).toString())));
                        console.log(encoding.b58.encode(keypair.secretKey));
                    })
                .command("token-authority <programId>",
                    "print the token authority address for a given program ID",
                    (yargs) => yargs
                        .positional("programId", {
                            describe: "Program ID",
                            type: "string",
                            demandOption: true,
                        }),
                    (argv) => {
                        const programId = new PublicKey(argv["programId"]);
                        const tokenAuthority = NTT.pdas(programId).tokenAuthority();
                        console.log(tokenAuthority.toBase58());
                    })
                .command("ata <mint> <owner> <tokenProgram>",
                    "print the token authority address for a given program ID",
                    (yargs) => yargs
                        .positional("mint", {
                            describe: "Mint address",
                            type: "string",
                            demandOption: true,
                        })
                        .positional("owner", {
                            describe: "Owner address",
                            type: "string",
                            demandOption: true,
                        })
                        .positional("tokenProgram", {
                            describe: "Token program ID",
                            type: "string",
                            choices: ["legacy", "token22"],
                            demandOption: true,
                        }),
                    (argv) => {
                        const mint = new PublicKey(argv["mint"]);
                        const owner = new PublicKey(argv["owner"]);
                        const tokenProgram = argv["tokenProgram"] === "legacy"
                            ? spl.TOKEN_PROGRAM_ID
                            : spl.TOKEN_2022_PROGRAM_ID
                        const ata = spl.getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
                        console.log(ata.toBase58());
                    })
                .demandCommand()
        }
    )
    .help()
    .strict()
    .demandCommand()
    .parse();

// Implicit configuration that's missing from a contract deployment. These are
// implicit in the sense that they don't need to be explicitly set in the
// deployment file.
// For example, all managers and transceivers need to be registered with each other.
// Additionally, the EVM chains need to be registered as such, and the standard relaying
// needs to be enabled for all chains where this is supported.
type MissingImplicitConfig = {
    managerPeers: Ntt.Peer<Chain>[];
    transceiverPeers: ChainAddress<Chain>[];
    evmChains: Chain[];
    standardRelaying: Chain[];
    specialRelaying: Chain[];
    solanaWormholeTransceiver: boolean;
    solanaUpdateLUT: boolean;
}

function checkConfigErrors(deps: Partial<{ [C in Chain]: Deployment<Chain> }>): number {
    let fatal = 0;
    for (const [chain, deployment] of Object.entries(deps)) {
        assertChain(chain);
        const config = deployment.config.local!;
        if (!checkNumberFormatting(config.limits.outbound, deployment.decimals)) {
            console.error(`ERROR: ${chain} has an outbound limit (${config.limits.outbound}) with the wrong number of decimals. The number should have ${deployment.decimals} decimals.`);
            fatal++;
        }
        if (config.limits.outbound === formatNumber(0n, deployment.decimals)) {
            console.warn(chalk.yellow(`${chain} has an outbound limit of 0`));
        }
        for (const [c, limit] of Object.entries(config.limits.inbound)) {
            if (!checkNumberFormatting(limit, deployment.decimals)) {
                console.error(`ERROR: ${chain} has an inbound limit with the wrong number of decimals for ${c} (${limit}). The number should have ${deployment.decimals} decimals.`);
                fatal++;
            }
            if (limit === formatNumber(0n, deployment.decimals)) {
                console.warn(chalk.yellow(`${chain} has an inbound limit of 0 from ${c}`));
            }
        }
    }
    return fatal;
}

function createWorkTree(platform: Platform, version: string): string {
    const tag = getGitTagName(platform, version);
    if (!tag) {
        console.error(`No tag found matching ${version} for ${platform}`);
        process.exit(1);
    }

    const worktreeName = `.deployments/${platform}-${version}`;

    if (fs.existsSync(worktreeName)) {
        console.log(chalk.yellow(`Worktree already exists at ${worktreeName}. Resetting to ${tag}`));
        execSync(`git -C ${worktreeName} reset --hard ${tag}`, {
            stdio: "inherit"
        });
    } else {
        // create worktree
        execSync(`git worktree add ${worktreeName} ${tag}`, {
            stdio: "inherit"
        });
    }

    // NOTE: we create this symlink whether or not the file exists.
    // this way, if it's created later, the symlink will be correct
    execSync(`ln -fs $(pwd)/overrides.json $(pwd)/${worktreeName}/overrides.json`, {
        stdio: "inherit"
    });

    console.log(chalk.green(`Created worktree at ${worktreeName} from tag ${tag}`));
    return worktreeName;
}

async function upgrade<N extends Network, C extends Chain>(
    _fromVersion: string,
    toVersion: string | null,
    ntt: Ntt<N, C>,
    ctx: ChainContext<N, C>,
    signerType: SignerType,
    evmVerify: boolean,
    solanaPayer?: string,
    solanaProgramKeyPath?: string,
    solanaBinaryPath?: string
): Promise<void> {
    // TODO: check that fromVersion is safe to upgrade to toVersion from
    const platform = chainToPlatform(ctx.chain);
    const worktree = toVersion ? createWorkTree(platform, toVersion) : ".";
    switch (platform) {
        case "Evm":
            const evmNtt = ntt as EvmNtt<N, EvmChains>;
            const evmCtx = ctx as ChainContext<N, EvmChains>;
            return upgradeEvm(worktree, evmNtt, evmCtx, signerType, evmVerify);
        case "Solana":
            if (solanaPayer === undefined || !fs.existsSync(solanaPayer)) {
                console.error("Payer not found. Specify with --payer");
                process.exit(1);
            }
            const solanaNtt = ntt as SolanaNtt<N, SolanaChains>;
            const solanaCtx = ctx as ChainContext<N, SolanaChains>;
            return upgradeSolana(worktree, toVersion, solanaNtt, solanaCtx, solanaPayer, solanaProgramKeyPath, solanaBinaryPath);
        default:
            throw new Error("Unsupported platform");
    }
}

async function upgradeEvm<N extends Network, C extends EvmChains>(
    pwd: string,
    ntt: EvmNtt<N, C>,
    ctx: ChainContext<N, C>,
    signerType: SignerType,
    evmVerify: boolean
): Promise<void> {
    ensureNttRoot(pwd);

    console.log("Upgrading EVM chain", ctx.chain);

    const signer = await getSigner(ctx, signerType);
    const signerArgs = forgeSignerArgs(signer.source);

    console.log("Installing forge dependencies...")
    execSync("forge install", {
        cwd: `${pwd}/evm`,
        stdio: "pipe"
    });

    let verifyArgs: string = "";
    if (evmVerify) {
        // TODO: verify etherscan api key?
        const etherscanApiKey = configuration.get(ctx.chain, "scan_api_key", { reportError: true })
        if (!etherscanApiKey) {
            process.exit(1);
        }
        verifyArgs = `--verify --etherscan-api-key ${etherscanApiKey}`;
    }

    console.log("Upgrading manager...");
    await withCustomEvmDeployerScript(pwd, async () => {
        execSync(
            `forge script --via-ir script/DeployWormholeNtt.s.sol \
--rpc-url ${ctx.config.rpc} \
--sig "upgrade(address)" \
${ntt.managerAddress} \
${signerArgs} \
--broadcast \
${verifyArgs} | tee last-run.stdout`, {
                cwd: `${pwd}/evm`,
                stdio: "inherit"
            });
    });

}

async function upgradeSolana<N extends Network, C extends SolanaChains>(
    pwd: string,
    version: string | null,
    ntt: SolanaNtt<N, C>,
    ctx: ChainContext<N, C>,
    payer: string,
    programKeyPath?: string,
    binaryPath?: string
): Promise<void> {
    if (version === null) {
        throw new Error("Cannot upgrade Solana to local version"); // TODO: this is not hard to enabled
    }
    const mint = (await (ntt.getConfig())).mint;
    await deploySolana(pwd, version, await ntt.getMode(), ctx, mint.toBase58(), payer, false, programKeyPath, binaryPath);
    // TODO: call initializeOrUpdateLUT. currently it's done in the following 'ntt push' step.
}

async function deploy<N extends Network, C extends Chain>(
    version: string | null,
    mode: Ntt.Mode,
    ch: ChainContext<N, C>,
    token: string,
    signerType: SignerType,
    evmVerify: boolean,
    yes: boolean,
    solanaPayer?: string,
    solanaProgramKeyPath?: string,
    solanaBinaryPath?: string,
    solanaPriorityFee?: number
): Promise<ChainAddress<C>> {
    if (version === null) {
        await warnLocalDeployment(yes);
    }
    const platform = chainToPlatform(ch.chain);
    const worktree = version ? createWorkTree(platform, version) : ".";
    switch (platform) {
        case "Evm":
            return await deployEvm(worktree, mode, ch, token, signerType, evmVerify);
        case "Solana":
            if (solanaPayer === undefined || !fs.existsSync(solanaPayer)) {
                console.error("Payer not found. Specify with --payer");
                process.exit(1);
            }
            const solanaCtx = ch as ChainContext<N, SolanaChains>;
            return await deploySolana(worktree, version, mode, solanaCtx, token, solanaPayer, true, solanaProgramKeyPath, solanaBinaryPath, solanaPriorityFee) as ChainAddress<C>;
        default:
            throw new Error("Unsupported platform");
    }
}

async function deployEvm<N extends Network, C extends Chain>(
    pwd: string,
    mode: Ntt.Mode,
    ch: ChainContext<N, C>,
    token: string,
    signerType: SignerType,
    verify: boolean,
): Promise<ChainAddress<C>> {
    ensureNttRoot(pwd);

    const wormhole = ch.config.contracts.coreBridge;
    if (!wormhole) {
        console.error("Core bridge not found");
        process.exit(1);
    }
    const relayer = ch.config.contracts.relayer;
    if (!relayer) {
        console.error("Relayer not found");
        process.exit(1);
    }

    const rpc = ch.config.rpc;
    // TODO: how to make specialRelayer configurable??
    let specialRelayer: string;
    if (ch.chain === "Avalanche") {
        specialRelayer = "0x1a19d8a194630642f750376Ae72b4eDF5aDFd25F";
    } else if (ch.chain === "Bsc") {
        specialRelayer = "0x8C56eE9cd232d23541a697C0eBd3cA597DE3c88D";
    } else {
        specialRelayer = "0x63BE47835c7D66c4aA5B2C688Dc6ed9771c94C74";
    }

    const provider = new ethers.JsonRpcProvider(rpc);
    const abi = ["function decimals() external view returns (uint8)"];
    const tokenContract = new ethers.Contract(token, abi, provider);
    const decimals: number = await tokenContract.decimals();

    // TODO: should actually make these ENV variables.
    const sig = "run(address,address,address,address,uint8,uint8)";
    const modeUint = mode === "locking" ? 0 : 1;
    const signer = await getSigner(ch, signerType);
    const signerArgs = forgeSignerArgs(signer.source);

    // TODO: verify etherscan api key?
    let verifyArgs: string[] = [];
    if (verify) {
        const etherscanApiKey = configuration.get(ch.chain, "scan_api_key", { reportError: true })
        if (!etherscanApiKey) {
            process.exit(1);
        }
        verifyArgs = ["--verify", "--etherscan-api-key", etherscanApiKey]
    }

    console.log("Installing forge dependencies...")
    execSync("forge install", {
        cwd: `${pwd}/evm`,
        stdio: "pipe"
    });

    console.log("Deploying manager...");
    const deploy = async (simulate: boolean): Promise<string> => {
        const simulateArg = simulate ? "" : "--skip-simulation";
        await withCustomEvmDeployerScript(pwd, async () => {
            try {
                execSync(`
forge script --via-ir script/DeployWormholeNtt.s.sol \
--rpc-url ${rpc} \
${simulateArg} \
--sig "${sig}" ${wormhole} ${token} ${relayer} ${specialRelayer} ${decimals} ${modeUint} \
--broadcast ${verifyArgs.join(' ')} ${signerArgs} 2>&1 | tee last-run.stdout`, {
                        cwd: `${pwd}/evm`,
                        encoding: 'utf8',
                        stdio: 'inherit'
                    });
            } catch (error) {
                console.error("Failed to deploy manager");
                // NOTE: we don't exit here. instead, we check if the manager was
                // deployed successfully (below) and proceed if it was.
                // process.exit(1);
            }
        });
        return fs.readFileSync(`${pwd}/evm/last-run.stdout`).toString();
    }

    // we attempt to deploy with simulation first, then without if it fails
    let out = await deploy(true);
    if (out.includes("Simulated execution failed")) {
        if (out.includes("NotActivated")) {
            console.error("Simulation failed, likely because the token contract is compiled against a different EVM version. It's probably safe to continue without simulation.")
            await askForConfirmation("Do you want to proceed with the deployment without simulation?");
        } else {
            console.error("Simulation failed. Please read the error message carefully, and proceed with caution.");
            await askForConfirmation("Do you want to proceed with the deployment without simulation?");
        }
        out = await deploy(false);
    }

    if (!out) {
        console.error("Failed to deploy manager");
        process.exit(1);
    }
    const logs = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const manager = logs.find((l) => l.includes("NttManager: 0x"))?.split(" ")[1];
    if (!manager) {
        console.error("Manager not found");
        process.exit(1);
    }
    const universalManager = toUniversal(ch.chain, manager);
    return { chain: ch.chain, address: universalManager };
}

async function deploySolana<N extends Network, C extends SolanaChains>(
    pwd: string,
    version: string | null,
    mode: Ntt.Mode,
    ch: ChainContext<N, C>,
    token: string,
    payer: string,
    initialize: boolean,
    managerKeyPath?: string,
    binaryPath?: string,
    priorityFee?: number
): Promise<ChainAddress<C>> {
    ensureNttRoot(pwd);

    // TODO: if the binary is provided, we should not check addresses in the source tree. (so we should move around the control flow a bit)
    // TODO: factor out some of this into separate functions to help readability of this function (maybe even move to a different file)

    const wormhole = ch.config.contracts.coreBridge;
    if (!wormhole) {
        console.error("Core bridge not found");
        process.exit(1);
    }

    // grep example_native_token_transfers = ".*"
    // in solana/Anchor.toml
    // TODO: what if they rename the program?
    const existingProgramId = fs.readFileSync(`${pwd}/solana/Anchor.toml`).toString().match(/example_native_token_transfers = "(.*)"/)?.[1];
    if (!existingProgramId) {
        console.error("Program ID not found in Anchor.toml (looked for example_native_token_transfers = \"(.*)\")");
        process.exit(1);
    }

    let programKeypairPath;
    let programKeypair;

    if (managerKeyPath) {
        if (!fs.existsSync(managerKeyPath)) {
            console.error(`Program keypair not found: ${managerKeyPath}`);
            process.exit(1);
        }
        programKeypairPath = managerKeyPath;
        programKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(managerKeyPath).toString())));
    } else {
        const programKeyJson = `${existingProgramId}.json`;
        if (!fs.existsSync(programKeyJson)) {
            console.error(`Program keypair not found: ${programKeyJson}`);
            console.error("Run `solana-keygen` to create a new keypair (either with 'new', or with 'grind'), and pass it to this command with --program-key");
            console.error("For example: solana-keygen grind --starts-with ntt:1 --ignore-case")
            process.exit(1);
        }
        programKeypairPath = programKeyJson;
        programKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(programKeyJson).toString())));
        if (existingProgramId !== programKeypair.publicKey.toBase58()) {
            console.error(`The private key in ${programKeyJson} does not match the existing program ID: ${existingProgramId}`);
            process.exit(1);
        }
    }

    // see if the program key matches the existing program ID. if not, we need
    // to update the latter in the Anchor.toml file and the lib.rs file(s)
    const providedProgramId = programKeypair.publicKey.toBase58();
    if (providedProgramId !== existingProgramId) {
        // only ask for confirmation if the current directory is ".". if it's
        // something else (a worktree) then it's a fresh checkout and we just
        // override the address anyway.
        if (pwd === ".") {
            console.error(`Program keypair does not match the existing program ID: ${existingProgramId}`);
            await askForConfirmation(`Do you want to update the program ID in the Anchor.toml file and the lib.rs file to ${providedProgramId}?`);
        }

        const anchorTomlPath = `${pwd}/solana/Anchor.toml`;
        const libRsPath = `${pwd}/solana/programs/example-native-token-transfers/src/lib.rs`;

        const anchorToml = fs.readFileSync(anchorTomlPath).toString();
        const newAnchorToml = anchorToml.replace(existingProgramId, providedProgramId);
        fs.writeFileSync(anchorTomlPath, newAnchorToml);
        const libRs = fs.readFileSync(libRsPath).toString();
        const newLibRs = libRs.replace(existingProgramId, providedProgramId);
        fs.writeFileSync(libRsPath, newLibRs);
    }


    // First we check that the provided mint's mint authority is the program's token authority PDA when in burning mode.
    // This is checked in the program initialiser anyway, but we can save some
    // time by checking it here and failing early (not to mention better
    // diagnostics).

    const emitter = NTT.transceiverPdas(providedProgramId).emitterAccount().toBase58();
    const payerKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(payer).toString())));

    // this is not super pretty... I want to initialise the 'ntt' object, but
    // because it's not deployed yet, fetching the version will fail, and thus default to whatever the default version is.
    // We want to use the correct version (because the sdk's behaviour depends on it), so we first create a dummy ntt instance,
    // let that fill in all the necessary fields, and then create a new instance with the correct version.
    // It should be possible to avoid this dummy object and just instantiate 'SolanaNtt' directly, but I wasn't
    // sure where the various pieces are plugged together and this seemed easier.
    // TODO: refactor this to avoid the dummy object
    const dummy: SolanaNtt<N, C> = await ch.getProtocol("Ntt", {
        ntt: {
            manager: providedProgramId,
            token: token,
            transceiver: { wormhole: emitter },
        }
    }) as SolanaNtt<N, C>;

    const ntt: SolanaNtt<N, C> = new SolanaNtt(
        dummy.network,
        dummy.chain,
        dummy.connection,
        dummy.contracts,
        version ?? undefined
    );

    // get the mint authority of 'token'
    const tokenMint = new PublicKey(token);
    // const tokenInfo = await ch.connection.getTokenInfo(tokenMint);
    const connection: Connection = await ch.getRpc();
    const mintInfo = await connection.getAccountInfo(tokenMint)
    if (!mintInfo) {
        console.error(`Mint ${token} not found on ${ch.chain} ${ch.network}`);
        process.exit(1);
    }
    const mint = spl.unpackMint(tokenMint, mintInfo, mintInfo.owner);

    if (mode === "burning") {
        const expectedMintAuthority = ntt.pdas.tokenAuthority().toBase58();
        const actualMintAuthority: string | null = mint.mintAuthority?.toBase58() ?? null;
        if (actualMintAuthority !== expectedMintAuthority) {
            console.error(`Mint authority mismatch for ${token}`);
            console.error(`Expected: ${expectedMintAuthority}`);
            console.error(`Actual: ${actualMintAuthority}`);
            console.error(`Set the mint authority to the program's token authority PDA with e.g.:`);
            console.error(`spl-token authorize ${token} mint ${expectedMintAuthority}`);
            process.exit(1);
        }
    }

    let binary: string;

    const skipDeploy = false;

    if (!skipDeploy) {
        if (binaryPath) {
            binary = binaryPath;
        } else {
            // build the program
            // TODO: build with docker
            checkAnchorVersion();
            const proc = Bun.spawn(
                ["anchor",
                    "build",
                    "-p", "example_native_token_transfers",
                    "--", "--no-default-features", "--features", cargoNetworkFeature(ch.network)
                ], {
                    cwd: `${pwd}/solana`
                });

            // const _out = await new Response(proc.stdout).text();

            await proc.exited;
            if (proc.exitCode !== 0) {
                process.exit(proc.exitCode ?? 1);
            }

            binary = `${pwd}/solana/target/deploy/example_native_token_transfers.so`;
        }


        await checkSolanaBinary(binary, wormhole, providedProgramId, version ?? undefined)

        // if buffer.json doesn't exist, create it
        if (!fs.existsSync(`buffer.json`)) {
            execSync(`solana-keygen new -o buffer.json --no-bip39-passphrase`);
        } else {
            console.info("buffer.json already exists.")
            askForConfirmation("Do you want continue an exiting deployment? If not, delete the buffer.json file and run the command again.");
        }

        const deployCommand = [
            "solana",
            "program",
            "deploy",
            "--program-id", programKeypairPath,
            "--buffer", `buffer.json`,
            binary,
            "--keypair", payer,
            "-u", ch.config.rpc,
            "--commitment", "finalized"
        ];

        if (priorityFee !== undefined) {
            deployCommand.push("--with-compute-unit-price", priorityFee.toString());
        }

        const deployProc = Bun.spawn(deployCommand);

        const out = await new Response(deployProc.stdout).text();

        await deployProc.exited;

        if (deployProc.exitCode !== 0) {
            process.exit(deployProc.exitCode ?? 1);
        }

        // success. remove buffer.json
        fs.unlinkSync("buffer.json");

        console.log(out);
    }

    if (initialize) {
        // wait 3 seconds
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const tx = ntt.initialize(
            toUniversal(ch.chain, payerKeypair.publicKey.toBase58()),
            {
                mint: new PublicKey(token),
                mode,
                outboundLimit: 100000000n,
            });

        const signer = await getSigner(ch, "privateKey", encoding.b58.encode(payerKeypair.secretKey));

        try {
            await signSendWait(ch, tx, signer.signer);
        } catch (e: any) {
            console.error(e.logs);
        }
    }

    return { chain: ch.chain, address: toUniversal(ch.chain, providedProgramId) };
}

async function missingConfigs(
    deps: Partial<{ [C in Chain]: Deployment<Chain> }>,
    verbose: boolean,
): Promise<Partial<{ [C in Chain]: MissingImplicitConfig }>> {
    const missingConfigs: Partial<{ [C in Chain]: MissingImplicitConfig }> = {};

    for (const [fromChain, from] of Object.entries(deps)) {
        let count = 0;
        assertChain(fromChain);

        let missing: MissingImplicitConfig = {
            managerPeers: [],
            transceiverPeers: [],
            evmChains: [],
            standardRelaying: [],
            specialRelaying: [],
            solanaWormholeTransceiver: false,
            solanaUpdateLUT: false,
        };

        if (chainToPlatform(fromChain) === "Solana") {
            const solanaNtt = from.ntt as SolanaNtt<Network, SolanaChains>;
            const selfWormholeTransceiver = solanaNtt.pdas.registeredTransceiver(new PublicKey(solanaNtt.contracts.ntt!.manager)).toBase58();
            const registeredSelfTransceiver = await retryWithExponentialBackoff(() => solanaNtt.connection.getAccountInfo(new PublicKey(selfWormholeTransceiver)), 5, 5000);
            if (registeredSelfTransceiver === null) {
                count++;
                missing.solanaWormholeTransceiver = true;
            }

            // here we just check if the LUT update function returns an instruction.
            // if it does, it means the LUT is missing or outdated.  notice that
            // we're not actually updating the LUT here, just checking if it's
            // missing, so it's ok to use the 0 pubkey as the payer.
            const updateLUT = solanaNtt.initializeOrUpdateLUT({ payer: new PublicKey(0) });
            // check if async generator is non-empty
            if (!(await updateLUT.next()).done) {
                count++;
                missing.solanaUpdateLUT = true;
            }
        }

        for (const [toChain, to] of Object.entries(deps)) {
            assertChain(toChain);
            if (fromChain === toChain) {
                continue;
            }
            if (verbose) {
                process.stdout.write(`Verifying registration for ${fromChain} -> ${toChain}......\n`);
            }
            const peer = await retryWithExponentialBackoff(() => from.ntt.getPeer(toChain), 5, 5000);
            if (peer === null) {
                const configLimit = from.config.local?.limits?.inbound?.[toChain]?.replace(".", "");
                count++;
                missing.managerPeers.push({
                    address: to.manager,
                    tokenDecimals: to.decimals,
                    inboundLimit: BigInt(configLimit ?? 0),
                });
            } else {
                // @ts-ignore TODO
                if (!Buffer.from(peer.address.address.address).equals(Buffer.from(to.manager.address.address))) {
                    console.error(`Peer address mismatch for ${fromChain} -> ${toChain}`);
                }
                if (peer.tokenDecimals !== to.decimals) {
                    console.error(`Peer decimals mismatch for ${fromChain} -> ${toChain}`);
                }
            }

            if (chainToPlatform(fromChain) === "Evm") {
                const toIsEvm = chainToPlatform(toChain) === "Evm";
                const toIsSolana = chainToPlatform(toChain) === "Solana";
                const whTransceiver = await from.ntt.getTransceiver(0) as EvmNttWormholeTranceiver<Network, EvmChains>;

                if (toIsEvm) {
                    const remoteToEvm = await whTransceiver.isEvmChain(toChain);
                    if (!remoteToEvm) {
                        count++;
                        missing.evmChains.push(toChain);
                    }

                    const standardRelaying = await whTransceiver.isWormholeRelayingEnabled(toChain);
                    if (!standardRelaying) {
                        count++;
                        missing.standardRelaying.push(toChain);
                    }
                } else if (toIsSolana) {
                    const specialRelaying = await whTransceiver.isSpecialRelayingEnabled(toChain);
                    if (!specialRelaying) {
                        count++;
                        missing.specialRelaying.push(toChain);
                    }
                }
            }

            const transceiverPeer = await retryWithExponentialBackoff(() => from.whTransceiver.getPeer(toChain), 5, 5000);
            if (transceiverPeer === null) {
                count++;
                missing.transceiverPeers.push(to.whTransceiver.getAddress());
            } else {
                // @ts-ignore TODO
                if (!Buffer.from(transceiverPeer.address.address).equals(Buffer.from(to.whTransceiver.getAddress().address.address))) {
                    console.error(`Transceiver peer address mismatch for ${fromChain} -> ${toChain}`);
                }
            }

        }
        if (count > 0) {
            missingConfigs[fromChain] = missing;
        }
    }
    return missingConfigs;
}

async function pushDeployment<C extends Chain>(deployment: Deployment<C>,
    signSendWaitFunc: ReturnType<typeof newSignSendWaiter>,
    signerType: SignerType, evmVerify: boolean, yes: boolean, filePath?: string): Promise<void> {
    const diff = diffObjects(deployment.config.local!, deployment.config.remote!);
    if (Object.keys(diff).length === 0) {
        return;
    }

    const canonical = canonicalAddress(deployment.manager);
    console.log(`Pushing changes to ${deployment.manager.chain} (${canonical})`)

    console.log(chalk.reset(colorizeDiff(diff)));
    if (!yes) {
        await askForConfirmation();
    }

    const ctx = deployment.ctx;

    const signer = await getSigner(ctx, signerType, undefined, filePath);

    let txs = [];
    // we perform this last to make sure we don't accidentally lock ourselves out
    let updateOwner: ReturnType<typeof deployment.ntt.setOwner> | undefined = undefined;
    let managerUpgrade: { from: string, to: string } | undefined;
    for (const k of Object.keys(diff)) {
        if (k === "version") {
            // TODO: check against existing version, and make sure no major version changes
            managerUpgrade = { from: diff[k]!.pull!, to: diff[k]!.push! };
        } else if (k === "owner") {
            const address: AccountAddress<C> = toUniversal(deployment.manager.chain, diff[k]?.push!);
            updateOwner = deployment.ntt.setOwner(address, signer.address.address);
        } else if (k === "pauser") {
            const address: AccountAddress<C> = toUniversal(deployment.manager.chain, diff[k]?.push!);
            txs.push(deployment.ntt.setPauser(address, signer.address.address));
        } else if (k === "paused") {
            if (diff[k]?.push === true) {
                txs.push(deployment.ntt.pause(signer.address.address));
            } else {
                txs.push(deployment.ntt.unpause(signer.address.address));
            }
        } else if (k === "limits") {
            const newOutbound = diff[k]?.outbound?.push;
            if (newOutbound) {
                // TODO: verify amount has correct number of decimals?
                // remove "." from string and convert to bigint
                const newOutboundBigint = BigInt(newOutbound.replace(".", ""));
                txs.push(deployment.ntt.setOutboundLimit(newOutboundBigint, signer.address.address));
            }
            const inbound = diff[k]?.inbound;
            if (inbound) {
                for (const chain of Object.keys(inbound)) {
                    assertChain(chain);
                    const newInbound = inbound[chain]?.push;
                    if (newInbound) {
                        // TODO: verify amount has correct number of decimals?
                        const newInboundBigint = BigInt(newInbound.replace(".", ""));
                        txs.push(deployment.ntt.setInboundLimit(chain, newInboundBigint, signer.address.address));
                    }
                }
            }
        } else if (k === "transceivers") {
            // TODO: refactor this nested loop stuff into separate functions at least
            // alternatively we could first recursively collect all the things
            // to do into a flattened list (with entries like
            // transceivers.wormhole.pauser), and have a top-level mapping of
            // these entries to how they should be handled
            for (const j of Object.keys(diff[k] as object)) {
                if (j === "wormhole") {
                    for (const l of Object.keys(diff[k]![j] as object)) {
                        if (l === "pauser") {
                            const newTransceiverPauser = toUniversal(deployment.manager.chain, diff[k]![j]![l]!.push!);
                            txs.push(deployment.whTransceiver.setPauser(newTransceiverPauser, signer.address.address));
                        } else {
                            console.error(`Unsupported field: ${k}.${j}.${l}`);
                            process.exit(1);
                        }
                    }
                } else {
                    console.error(`Unsupported field: ${k}.${j}`);
                    process.exit(1);

                }
            }
        } else {
            console.error(`Unsupported field: ${k}`);
            process.exit(1);
        }
    }
    if (managerUpgrade) {
        await upgrade(managerUpgrade.from, managerUpgrade.to, deployment.ntt, ctx, signerType, evmVerify);
    }
    for (const tx of txs) {
        await signSendWaitFunc(ctx, tx, signer.signer)
    }
    if (updateOwner) {
        await signSendWaitFunc(ctx, updateOwner, signer.signer)
    }
}

async function pullDeployments(deployments: Config, network: Network, verbose: boolean): Promise<Partial<{ [C in Chain]: Deployment<Chain> }>> {
    let deps: Partial<{ [C in Chain]: Deployment<Chain> }> = {};

    for (const [chain, deployment] of Object.entries(deployments.chains)) {
        if (verbose) {
            process.stdout.write(`Fetching config for ${chain}......\n`);
        }
        assertChain(chain);
        const managerAddress: string | undefined = deployment.manager;
        if (managerAddress === undefined) {
            console.error(`manager field not found for chain ${chain}`);
            // process.exit(1);
            continue;
        }
        const [remote, ctx, ntt, decimals] = await pullChainConfig(
            network,
            { chain, address: toUniversal(chain, managerAddress) },
            overrides
        );
        const local = deployments.chains[chain];

        // TODO: what if it's not index 0...
        // we should check that the address of this transceiver matches the
        // address in the config. currently we just assume that ix 0 is the wormhole one
        const whTransceiver = await ntt.getTransceiver(0);
        if (whTransceiver === null) {
            console.error(`Wormhole transceiver not found for ${chain}`);
            process.exit(1);
        }

        deps[chain] = {
            ctx,
            ntt,
            decimals,
            manager: { chain, address: toUniversal(chain, managerAddress) },
            whTransceiver,
            config: {
                remote,
                local,
            }
        };
    }

    const config = Object.fromEntries(Object.entries(deps).map(([k, v]) => [k, v.config.remote]));
    const ntts = Object.fromEntries(Object.entries(deps).map(([k, v]) => [k, v.ntt]));
    await pullInboundLimits(ntts, config, verbose);
    return deps;
}

async function pullChainConfig<N extends Network, C extends Chain>(
    network: N,
    manager: ChainAddress<C>,
    overrides?: WormholeConfigOverrides<N>
): Promise<[ChainConfig, ChainContext<typeof network, C>, Ntt<typeof network, C>, number]> {
    const wh = new Wormhole(network, [solana.Platform, evm.Platform], overrides);
    const ch = wh.getChain(manager.chain);

    const nativeManagerAddress = canonicalAddress(manager);

    const { ntt, addresses }: { ntt: Ntt<N, C>; addresses: Partial<Ntt.Contracts>; } =
    await nttFromManager<N, C>(ch, nativeManagerAddress);

    const mode = await ntt.getMode();
    const outboundLimit = await ntt.getOutboundLimit();
    const threshold = await ntt.getThreshold();

    const decimals = await ntt.getTokenDecimals();
    // insert decimal point into number
    const outboundLimitDecimals = formatNumber(outboundLimit, decimals);

    const paused = await ntt.isPaused();
    const owner = await ntt.getOwner();
    const pauser = await ntt.getPauser();

    const version = getVersion(manager.chain, ntt);

    const transceiverPauser = await ntt.getTransceiver(0).then((t) => t?.getPauser() ?? null);

    const config: ChainConfig = {
        version,
        mode,
        paused,
        owner: owner.toString(),
        manager: nativeManagerAddress,
        token: addresses.token!,
        transceivers: {
            threshold,
            wormhole: { address: addresses.transceiver!.wormhole! },
        },
        limits: {
            outbound: outboundLimitDecimals,
            inbound: {},
        },
    };
    if (transceiverPauser) {
        config.transceivers.wormhole.pauser = transceiverPauser.toString();
    }
    if (pauser) {
        config.pauser = pauser.toString();
    }
    return [config, ch, ntt, decimals];
}

async function getImmutables<N extends Network, C extends Chain>(chain: C, ntt: Ntt<N, C>) {
    const platform = chainToPlatform(chain);
    if (platform !== "Evm") {
        return null;
    }
    const evmNtt = ntt as EvmNtt<N, EvmChains>;
    const transceiver = await evmNtt.getTransceiver(0) as EvmNttWormholeTranceiver<N, EvmChains>;
    const consistencyLevel = await transceiver.transceiver.consistencyLevel();
    const wormholeRelayer = await transceiver.transceiver.wormholeRelayer();
    const specialRelayer = await transceiver.transceiver.specialRelayer();
    const gasLimit = await transceiver.transceiver.gasLimit();

    const token = await evmNtt.manager.token();
    const tokenDecimals = await evmNtt.manager.tokenDecimals();

    const whTransceiverImmutables = {
        consistencyLevel,
        wormholeRelayer,
        specialRelayer,
        gasLimit,
    };
    return {
        manager: {
            token,
            tokenDecimals,
        },
        wormholeTransceiver: whTransceiverImmutables,
    };
}

async function getPdas<N extends Network, C extends Chain>(chain: C, ntt: Ntt<N, C>) {
    const platform = chainToPlatform(chain);
    if (platform !== "Solana") {
        return null;
    }
    const solanaNtt = ntt as SolanaNtt<N, SolanaChains>;
    const config = solanaNtt.pdas.configAccount();
    const emitter = NTT.transceiverPdas(solanaNtt.program.programId).emitterAccount();
    const outboxRateLimit = solanaNtt.pdas.outboxRateLimitAccount();
    const tokenAuthority = solanaNtt.pdas.tokenAuthority();
    const lutAccount = solanaNtt.pdas.lutAccount();
    const lutAuthority = solanaNtt.pdas.lutAuthority();

    return {
        config,
        emitter,
        outboxRateLimit,
        tokenAuthority,
        lutAccount,
        lutAuthority,
    };
}

function getVersion<N extends Network, C extends Chain>(chain: C, ntt: Ntt<N, C>): string {
    const platform = chainToPlatform(chain);
    switch (platform) {
        case "Evm":
            return (ntt as EvmNtt<N, EvmChains>).version
        case "Solana":
            return (ntt as SolanaNtt<N, SolanaChains>).version
        default:
            throw new Error("Unsupported platform");
    }
}

// TODO: there should be a more elegant way to do this, than creating a
// "dummy" NTT, then calling verifyAddresses to get the contract diff, then
// finally reconstructing the "real" NTT object from that
async function nttFromManager<N extends Network, C extends Chain>(
    ch: ChainContext<N, C>,
    nativeManagerAddress: string
): Promise<{ ntt: Ntt<N, C>; addresses: Partial<Ntt.Contracts> }> {
    const onlyManager = await ch.getProtocol("Ntt", {
        ntt: {
            manager: nativeManagerAddress,
            token: null,
            transceiver: {},
        }
    });
    const diff = await onlyManager.verifyAddresses();

    const addresses: Partial<Ntt.Contracts> = { manager: nativeManagerAddress, ...diff };

    const ntt = await ch.getProtocol("Ntt", {
        ntt: addresses
    });
    return { ntt, addresses };
}

function formatNumber(num: bigint, decimals: number) {
    if (num === 0n) {
        return "0." + "0".repeat(decimals);
    }
    const str = num.toString();
    const formatted = str.slice(0, -decimals) + "." + str.slice(-decimals);
    if (formatted.startsWith(".")) {
        return "0" + formatted;
    }
    return formatted;
}

function checkNumberFormatting(formatted: string, decimals: number): boolean {
    // check that the string has the correct number of decimals
    const parts = formatted.split(".");
    if (parts.length !== 2) {
        return false;
    }
    if (parts[1].length !== decimals) {
        return false;
    }
    return true;
}

function cargoNetworkFeature(network: Network): string {
    switch (network) {
        case "Mainnet":
            return "mainnet";
        case "Testnet":
            return "solana-devnet";
        case "Devnet":
            return "tilt-devnet";
        default:
            throw new Error("Unsupported network");
    }
}


async function askForConfirmation(prompt: string = "Do you want to continue?"): Promise<void> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    const answer = await new Promise<string>((resolve) => {
        rl.question(`${prompt} [y/n]`, resolve);
    });
    rl.close();

    if (answer !== "y") {
        console.log("Aborting");
        process.exit(0);
    }
}

// NOTE: modifies the config object in place
// TODO: maybe introduce typestate for having pulled inbound limits?
async function pullInboundLimits(ntts: Partial<{ [C in Chain]: Ntt<Network, C> }>, config: Config["chains"], verbose: boolean) {
    for (const [c1, ntt1] of Object.entries(ntts)) {
        assertChain(c1);
        const chainConf = config[c1];
        if (!chainConf) {
            console.error(`Chain ${c1} not found in deployment`);
            process.exit(1);
        }
        const decimals = await ntt1.getTokenDecimals();
        for (const [c2, ntt2] of Object.entries(ntts)) {
            assertChain(c2);
            if (ntt1 === ntt2) {
                continue;
            }
            if (verbose) {
                process.stdout.write(`Fetching inbound limit for ${c1} -> ${c2}.......\n`);
            }
            const peer = await retryWithExponentialBackoff(() => ntt1.getPeer(c2), 5, 5000);
            if (chainConf.limits?.inbound === undefined) {
                chainConf.limits.inbound = {};
            }

            const limit = peer?.inboundLimit ?? 0n;

            chainConf.limits.inbound[c2] = formatNumber(limit, decimals)

        }
    }
}

async function checkSolanaBinary(binary: string, wormhole: string, providedProgramId: string, version?: string) {
    // ensure binary path exists
    if (!fs.existsSync(binary)) {
        console.error(`.so file not found: ${binary}`);
        process.exit(1);
    }
    // console.log(`Checking binary ${binary} for wormhole and provided program ID`);

    // convert wormhole and providedProgramId from base58 to hex
    const wormholeHex = new PublicKey(wormhole).toBuffer().toString("hex");
    const providedProgramIdHex = new PublicKey(providedProgramId).toBuffer().toString("hex");
    const versionHex = version ? Buffer.from(version).toString("hex") : undefined;

    if (!searchHexInBinary(binary, wormholeHex)) {
        console.error(`Wormhole address not found in binary: ${wormhole}`);
        process.exit(1);
    }
    if (!searchHexInBinary(binary, providedProgramIdHex)) {
        console.error(`Provided program ID not found in binary: ${providedProgramId}`);
        process.exit(1);
    }
    if (versionHex && !searchHexInBinary(binary, versionHex)) {
        // TODO: figure out how to search for the version string in the binary
        // console.error(`Version string not found in binary: ${version}`);
        // process.exit(1);
    }
}

// not the most efficient, but at least it's definitely portable
function searchHexInBinary(binaryPath: string, searchHex: string) {
    const buffer = fs.readFileSync(binaryPath);
    const hexString = buffer.toString('hex');
    const found = hexString.includes(searchHex);

    return found;
}

export function ensureNttRoot(pwd: string = ".") {
    if (!fs.existsSync(`${pwd}/evm/foundry.toml`) || !fs.existsSync(`${pwd}/solana/Anchor.toml`)) {
        console.error("Run this command from the root of an NTT project.");
        process.exit(1);
    }
}

function checkAnchorVersion() {
    const expected = "0.29.0";
    try {
        execSync("which anchor");
    } catch {
        console.error("Anchor CLI is not installed.\nSee https://www.anchor-lang.com/docs/installation")
        process.exit(1);
    }
    const version = execSync("anchor --version").toString().trim();
    // version looks like "anchor-cli 0.14.0"
    const [_, v] = version.split(" ");
    if (v !== expected) {
        console.error(`Anchor CLI version must be ${expected} but is ${v}`);
        process.exit(1);
    }
}
function loadConfig(path: string): Config {
    if (!fs.existsSync(path)) {
        console.error(`File not found: ${path}`);
        console.error(`Create with 'ntt init' or specify another file with --path`);
        process.exit(1);
    }
    const deployments: Config = JSON.parse(fs.readFileSync(path).toString());
    return deployments;
}

function resolveVersion(latest: boolean, ver: string | undefined, local: boolean, platform: Platform): string | null {
    if ((latest ? 1 : 0) + (ver ? 1 : 0) + (local ? 1 : 0) !== 1) {
        console.error("Specify exactly one of --latest, --ver, or --local");
        const available = getAvailableVersions(platform);
        console.error(`Available versions for ${platform}:\n${available.join("\n")}`);
        process.exit(1);
    }
    if (latest) {
        const available = getAvailableVersions(platform);
        return available.sort().reverse()[0];
    } else if (ver) {
        return ver;
    } else {
        // local version
        return null;
    }
}

function warnLocalDeployment(yes: boolean): Promise<void> {
    if (!yes) {
        console.warn(chalk.yellow("WARNING: You are deploying from your local working directory."));
        console.warn(chalk.yellow("This bypasses version control and may deploy untested changes."));
        console.warn(chalk.yellow("Ensure your local changes are thoroughly tested and compatible."));
        return askForConfirmation("Are you sure you want to continue with the local deployment?");
    }
    return Promise.resolve();
}

function validateChain<N extends Network, C extends Chain>(network: N, chain: C) {
    if (network === "Testnet") {
        if (chain === "Ethereum") {
            console.error("Ethereum is deprecated on Testnet. Use EthereumSepolia instead.");
            process.exit(1);
        }
        // if on testnet, and the chain has a *Sepolia counterpart, use that instead
        if (chains.find((c) => c === `${c}Sepolia`)) {
            console.error(`Chain ${chain} is deprecated. Use ${chain}Sepolia instead.`);
            process.exit(1);
        }
    }
}

function retryWithExponentialBackoff<T>(
    fn: () => Promise<T>,
    maxRetries: number,
    delay: number,
): Promise<T> {
    const backoff = (retry: number) => Math.min(2 ** retry * delay, 10000) + Math.random() * 1000;
    const attempt = async (retry: number): Promise<T> => {
        try {
            return await fn();
        } catch (e) {
            if (retry >= maxRetries) {
                throw e;
            }
            const time = backoff(retry);
            await new Promise((resolve) => setTimeout(resolve, backoff(time)));
            return await attempt(retry + 1);
        }
    };
    return attempt(0);
}

function nttVersion(): { version: string, commit: string, path: string, remote: string } | null {
    const nttDir = `${process.env.HOME}/.ntt-cli`;
    try {
        const versionFile = fs.readFileSync(`${nttDir}/version`).toString().trim();
        const [commit, installPath, version, remote] = versionFile.split("\n");
        return { version, commit, path: installPath, remote };
    } catch {
        return null;
    }
}
