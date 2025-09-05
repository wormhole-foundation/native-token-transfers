#!/usr/bin/env bun
import "./side-effects"; // doesn't quite work for silencing the bigint error message. why?
import evm from "@wormhole-foundation/sdk/platforms/evm";
import solana from "@wormhole-foundation/sdk/platforms/solana";
import sui from "@wormhole-foundation/sdk/platforms/sui";
import { encoding, type RpcConnection, type UnsignedTransaction, type WormholeConfigOverrides } from '@wormhole-foundation/sdk-connect';
import { execSync } from "child_process";
import * as myEvmSigner from "./evmsigner.js";

import evmDeployFile from "../../evm/script/DeployWormholeNtt.s.sol" with { type: "file" };
import evmDeployFileHelper from "../../evm/script/helpers/DeployWormholeNttBase.sol" with { type: "file" };

import chalk from "chalk";
import yargs from "yargs";
import { $ } from "bun";
import { hideBin } from "yargs/helpers";
import { AddressLookupTableAccount, Connection, Keypair, PublicKey, SendTransactionError, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import * as spl from "@solana/spl-token";
import fs from "fs";
import path from "path";
import readline from "readline";
import { ChainContext, UniversalAddress, Wormhole, assertChain, canonicalAddress, chainToPlatform, chains, isNetwork, networks, platforms, signSendWait, toUniversal, type AccountAddress, type Chain, type ChainAddress, type Network, type Platform } from "@wormhole-foundation/sdk";
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import "@wormhole-foundation/sdk-evm-ntt";
import "@wormhole-foundation/sdk-solana-ntt";
import "@wormhole-foundation/sdk-sui-ntt";
import "@wormhole-foundation/sdk-definitions-ntt";
import type { Ntt, NttTransceiver } from "@wormhole-foundation/sdk-definitions-ntt";

import { type SolanaChains, SolanaAddress } from "@wormhole-foundation/sdk-solana";
import { type SuiChains } from "@wormhole-foundation/sdk-sui";

import { colorizeDiff, diffObjects } from "./diff";
import { forgeSignerArgs, getSigner, type SignerType } from "./getSigner";

// Configuration fields that should be excluded from diff operations
// These are local-only configurations that don't have on-chain representations
const EXCLUDED_DIFF_PATHS = [
    "transceivers.wormhole.executor"
];

// Helper functions for nested object access
function getNestedValue(obj: any, path: string[]): any {
    return path.reduce((current, key) => current?.[key], obj);
}

function setNestedValue(obj: any, path: string[], value: any): void {
    const lastKey = path.pop()!;
    const target = path.reduce((current, key) => {
        if (!current[key]) current[key] = {};
        return current[key];
    }, obj);
    target[lastKey] = value;
}

import { NTT, SolanaNtt } from "@wormhole-foundation/sdk-solana-ntt";
import type { EvmNtt, EvmNttWormholeTranceiver } from "@wormhole-foundation/sdk-evm-ntt";
import { SuiNtt } from "@wormhole-foundation/sdk-sui-ntt";
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

// Setup Sui environment for consistent CLI usage with automatic cleanup
async function withSuiEnv<N extends Network, C extends Chain, T>(
    pwd: string,
    ch: ChainContext<N, C>,
    fn: () => Promise<T>
): Promise<T> {
    console.log("Setting up Sui environment...");

    // Store original environment variable
    const originalSuiConfigDir = process.env.SUI_CONFIG_DIR;

    // Create .sui directory in project root
    const suiConfigDir = path.resolve(path.join(pwd, ".sui"));
    fs.rmSync(suiConfigDir, { recursive: true, force: true });
    fs.mkdirSync(suiConfigDir, { recursive: true });

    try {
        // Set SUI_CONFIG_DIR environment variable
        process.env.SUI_CONFIG_DIR = suiConfigDir;

        console.log(`Using SUI_CONFIG_DIR: ${suiConfigDir}`);

        // Create client.yaml configuration file
        const clientYamlContent = `keystore:
  File: "${suiConfigDir}/sui.keystore"
envs:
  - alias: local
    rpc: "http://127.0.0.1:9000"
    ws: ~
active_env: local
active_address: ~
`;
        fs.writeFileSync(path.join(suiConfigDir, "client.yaml"), clientYamlContent);

        // Create empty keystore file
        fs.writeFileSync(path.join(suiConfigDir, "sui.keystore"), "[]");

        console.log("Created Sui configuration files");

        // Import private key if SUI_PRIVATE_KEY environment variable is set
        const privateKey = process.env.SUI_PRIVATE_KEY;
        if (privateKey) {
            console.log("Importing private key from SUI_PRIVATE_KEY...");
            try {
                execSync(`sui keytool import "${privateKey}" ed25519 --alias default`, {
                    stdio: undefined,
                    env: process.env
                });
                console.log("Private key imported successfully");
            } catch (error) {
                console.error("Failed to import private key:", error);
                throw error;
            }
        }

        // Get RPC URL from chain context
        const rpcUrl = ch.config.rpc;
        console.error(rpcUrl)

        // Determine network environment based on RPC URL
        let envAlias: string;
        if (rpcUrl.includes("mainnet")) {
            envAlias = "mainnet";
        } else if (rpcUrl.includes("testnet")) {
            envAlias = "testnet";
        } else {
            envAlias = "devnet";
        }

        // Create or update the environment
        console.log(`Setting up ${envAlias} environment with RPC: ${rpcUrl}`);
        try {
            execSync(`sui client new-env --alias ${envAlias} --rpc ${rpcUrl}`, {
                stdio: "inherit",
                env: process.env
            });
        } catch (error) {
            // Environment might already exist, try to switch to it
            console.log(`Environment ${envAlias} may already exist, switching to it...`);
        }

        // Switch to the environment
        try {
            execSync(`sui client switch --env ${envAlias}`, {
                stdio: "inherit",
                env: process.env
            });
            console.log(`Switched to ${envAlias} environment`);
        } catch (error) {
            console.error(`Failed to switch to ${envAlias} environment:`, error);
            throw error;
        }

        // Execute the provided function
        return await fn();

    } finally {
        // remove directory
        // fs.rmSync(suiConfigDir, { recursive: true, force: true });
        // Cleanup: restore original environment variable
        if (originalSuiConfigDir !== undefined) {
            process.env.SUI_CONFIG_DIR = originalSuiConfigDir;
        } else {
            delete process.env.SUI_CONFIG_DIR;
        }

        console.log("Sui environment cleaned up");
    }
}

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

// Extended ChainAddress type for Sui deployments that includes additional metadata
export type SuiDeploymentResult<C extends Chain> = ChainAddress<C> & {
    adminCaps?: {
        wormholeTransceiver?: string
    },
    transceiverStateIds?: {
        wormhole?: string
    },
    packageIds?: {
        ntt?: string,
        nttCommon?: string,
        wormholeTransceiver?: string
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
        wormhole: { address: string, pauser?: string, executor?: boolean },
    },
    limits: {
        outbound: string,
        inbound: Partial<{ [C in Chain]: string }>,
    },
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
                const installScript = "https://raw.githubusercontent.com/wormhole-foundation/native-token-transfers/main/cli/install.sh";
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
            await $`git clone -b main https://github.com/wormhole-foundation/native-token-transfers.git ${path}`;
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
            .option("sui-gas-budget", {
                describe: "Gas budget for Sui deployment",
                type: "number",
                default: 500000000,
            })
            .option("sui-package-path", {
                describe: "Path to Sui Move package directory (relative to project root)",
                type: "string",
                default: "sui",
            })
            .option("sui-wormhole-state", {
                describe: "Wormhole state object ID for Sui (optional, will lookup from SDK if not provided)",
                type: "string",
            })
            .option("sui-treasury-cap", {
                describe: "Treasury cap object ID for Sui burning mode deployment",
                type: "string",
            })
            .option("signer-type", options.signerType)
            .option("skip-verify", options.skipVerify)
            .option("ver", options.version)
            .option("latest", options.latest)
            .option("local", options.local)
            .option("path", options.deploymentPath)
            .option("yes", options.yes)
            .option("executor", {
                describe: "Use executor mode",
                type: "boolean",
                default: true,
            })
            .example("$0 add-chain Ethereum --token 0x1234... --mode burning --latest", "Add Ethereum chain with the latest contract version in burning mode")
            .example("$0 add-chain Solana --token Sol1234... --mode locking --ver 1.0.0", "Add Solana chain with a specific contract version in locking mode")
            .example("$0 add-chain Avalanche --token 0xabcd... --mode burning --local", "Add Avalanche chain using the local contract version")
            .example("$0 add-chain Base --token 0xdef... --mode burning --executor", "Add Base chain with executor mode enabled")
            .example("$0 add-chain Sui --token 0x123::mycoin::MYCOIN --mode burning --sui-treasury-cap 0xabc123... --latest", "Add Sui chain in burning mode with treasury cap"),
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

            // HyperEVM confirmation
            if (chain === "HyperEVM" && !argv["yes"]) {
                console.log(chalk.yellow("⚠️  HyperEVM Deployment Requirements:"));
                console.log(chalk.yellow("Before proceeding with the HyperEVM deployment, please ensure:"));
                console.log(chalk.yellow("1. You have created a verified account by depositing into Hyperliquid from the deployer wallet"));
                console.log(chalk.white("Hyperliquid app: https://app.hyperliquid.xyz/"));
                console.log(chalk.yellow("2. You have enabled larger blocks to be used for the deployment"));
                console.log(chalk.white("Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/dual-block-architecture"));
                console.log(chalk.yellow(""));
                
                await askForConfirmation("Did you make sure to do steps 1 & 2 mentioned above?");
            }

            // let's deploy

            // TODO: factor out to function to get chain context
            const wh = new Wormhole(network, [solana.Platform, evm.Platform, sui.Platform], overrides);
            const ch = wh.getChain(chain);

            // TODO: make manager configurable
            const deployedManager = await deploy(version, mode, ch, token, signerType, !argv["skip-verify"], argv["yes"], argv["executor"], argv["payer"], argv["program-key"], argv["binary"], argv["solana-priority-fee"], argv["sui-gas-budget"], argv["sui-package-path"], argv["sui-wormhole-state"], argv["sui-treasury-cap"]);

            const [config, _ctx, _ntt, decimals] =
                await pullChainConfig(network, deployedManager, overrides);

            console.log("token decimals:", chalk.yellow(decimals));

            config.transceivers.wormhole.executor = argv["executor"];

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

            const wh = new Wormhole(network, [solana.Platform, evm.Platform, sui.Platform], overrides);
            const ch = wh.getChain(chain);

            const [_, ctx, ntt] = await pullChainConfig(
                network,
                { chain, address: toUniversal(chain, chainConfig.manager) },
                overrides,
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
                try {
                    const [peerConfig, _ctx, peerNtt] = await pullChainConfig(network, { chain: c, address }, overrides);
                    ntts[c] = peerNtt as any;
                    configs[c] = peerConfig;
                } catch (e) {
                    console.error(`Failed to pull config for ${c}:`, e);
                    continue;
                }
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
                const diff = diffObjects(deployments.chains[chain]!, deployment.config.remote!, EXCLUDED_DIFF_PATHS);
                if (Object.keys(diff).length !== 0) {
                    console.error(chalk.reset(colorizeDiff({ [chain]: diff })));
                    changed = true;
                    // Preserve excluded fields from local config when pulling
                    const preservedConfig = { ...deployment.config.remote! };
                    for (const excludedPath of EXCLUDED_DIFF_PATHS) {
                        const pathParts = excludedPath.split('.');
                        const localValue = getNestedValue(deployments.chains[chain]!, pathParts);
                        if (localValue !== undefined) {
                            setNestedValue(preservedConfig, pathParts, localValue);
                        }
                    }
                    deployments.chains[chain] = preservedConfig;
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
                for (const [relayingTarget, value] of missingConfig.standardRelaying) {
                    const tx = (await ntt.getTransceiver(0) as EvmNttWormholeTranceiver<Network, EvmChains>).setIsWormholeRelayingEnabled(relayingTarget, value)
                    await signSendWaitFunc(ctx, tx, signer.signer)
                }
                for (const [relayingTarget, value] of missingConfig.specialRelaying) {
                    const tx = (await ntt.getTransceiver(0) as EvmNttWormholeTranceiver<Network, EvmChains>).setIsSpecialRelayingEnabled(relayingTarget, value)
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
                    const payer = new SolanaAddress(signer.address.address).unwrap();
                    const tx = solanaNtt.initializeOrUpdateLUT({ payer, owner: payer })
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

                const diff = diffObjects(local!, remote!, EXCLUDED_DIFF_PATHS);
                if (Object.keys(diff).length !== 0) {
                    console.error(chalk.reset(colorizeDiff({ [chain]: diff })));
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
                for (const [relayingTarget, shouldBeSet] of missingConfig.standardRelaying) {
                    if (shouldBeSet) {
                        console.warn(chalk.yellow(`  Standard relaying not configured for ${relayingTarget}`));
                    } else {
                        console.warn(chalk.yellow(`  Standard relaying configured for ${relayingTarget}, but should not be`));
                    }
                }
                for (const [relayingTarget, shouldBeSet] of missingConfig.specialRelaying) {
                    if (shouldBeSet) {
                        console.warn(chalk.yellow(`  Special relaying not configured for ${relayingTarget}`));
                    } else {
                        console.warn(chalk.yellow(`  Special relaying configured for ${relayingTarget}, but should not be`));
                    }
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
    .command("set-mint-authority",
        "set token mint authority to token authority (or valid SPL Multisig if --multisig flag is provided)",
        (yargs) => yargs
            .option("chain", options.chain)
            .option("manager", {
                describe: "Manager address",
                type: "string",
            })
            .option("token", {
                describe: "Token address",
                type: "string",
            })
            .option("path", options.deploymentPath)
            .option("yes", options.yes)
            .option("payer", { ...options.payer, demandOption: true })
            .option("multisig", {
                describe: "valid SPL Multisig address",
                type: "string",
            })
            .example(
                "$0 set-mint-authority --chain Solana --token Sol1234... --manager Sol3456... --payer <SOLANA_KEYPAIR_PATH>",
                "Set token mint authority to be the token authority address for undeployed program"
            )
            .example(
                "$0 set-mint-authority --chain Fogo --multisig <VALID_SPL_MULTISIG> --payer <SOLANA_KEYPAIR_PATH>",
                "Set token mint authority to be a valid SPL Multisig for deployed program"
            ),
        async (argv) => {
            const path = argv["path"];
            const deployments: Config = loadConfig(path);
            const chain: Chain = argv["chain"] as Chain;
            const manager = argv["manager"];
            const token = argv["token"];
            const network = deployments.network as Network;

            // Check that the platform is SVM (Solana)
            const platform = chainToPlatform(chain);
            if (platform !== "Solana") {
                console.error(`set-mint-authority is only supported for SVM chains. Got platform: ${platform}`);
                process.exit(1);
            }

            if (!fs.existsSync(argv["payer"])) {
                console.error("Payer not found. Specify with --payer");
                process.exit(1);
            }
            const payerKeypair = Keypair.fromSecretKey(
                new Uint8Array(
                    JSON.parse(fs.readFileSync(argv["payer"]).toString())
                )
            );

            if (!token !== !manager) {
                console.error(
                    "Please provide both --token and --manager for an undeployed program"
                );
                process.exit(1);
            }

            let solanaNtt: SolanaNtt<typeof network, SolanaChains> | undefined;
            let tokenMint: PublicKey;
            let managerKey: PublicKey;
            let major: number;

            // program deployed so fetch token and manager addresses from deployment
            if (!token && !manager) {
                if (!(chain in deployments.chains)) {
                    console.error(`Either provide --token and --manager flags, or ensure ${path} contains a valid ${chain} configuration`);
                    process.exit(1);
                }
                const chainConfig = deployments.chains[chain]!;
                const [, , ntt] = await pullChainConfig(
                    network,
                    { chain, address: toUniversal(chain, chainConfig.manager) },
                    overrides
                );
                solanaNtt = ntt as SolanaNtt<typeof network, SolanaChains>;
                tokenMint = (await solanaNtt.getConfig()).mint;
                managerKey = new PublicKey(chainConfig.manager);
                major = Number(solanaNtt.version.split(".")[0]);
            }
            // default values as undeployed program
            else {
                solanaNtt = undefined;
                tokenMint = new PublicKey(token!);
                managerKey = new PublicKey(manager!);
                major = -1;
            }

            const wh = new Wormhole(
                network,
                [solana.Platform, evm.Platform],
                overrides
            );
            const ch = wh.getChain(chain);
            const connection: Connection = await ch.getRpc();

            const tokenAuthority = NTT.pdas(managerKey).tokenAuthority();

            // verify current mint authority is not token authority
            const mintInfo = await connection.getAccountInfo(tokenMint);
            if (!mintInfo) {
                console.error(
                    `Mint ${token} not found on ${ch.chain} ${ch.network}`
                );
                process.exit(1);
            }
            const mint = spl.unpackMint(tokenMint, mintInfo, mintInfo.owner);
            if (!mint.mintAuthority) {
                console.error(
                    "Token has fixed supply and no further tokens may be minted"
                );
                process.exit(1);
            }
            if (mint.mintAuthority.equals(tokenAuthority)) {
                console.error(
                    "Please use https://github.com/wormhole-foundation/demo-ntt-token-mint-authority-transfer to transfer the token mint authority out of the NTT manager"
                );
                process.exit(1);
            }

            // verify current mint authority is not valid SPL Multisig
            const isMultisigTokenAuthority = await checkSvmValidSplMultisig(
                connection,
                mint.mintAuthority,
                mintInfo.owner,
                tokenAuthority
            );
            if (isMultisigTokenAuthority) {
                console.error(
                    "Please use https://github.com/wormhole-foundation/demo-ntt-token-mint-authority-transfer to transfer the token mint authority out of the NTT manager"
                );
                process.exit(1);
            }

            // verify current mint authority is payer
            if (!mint.mintAuthority.equals(payerKeypair.publicKey)) {
                console.error(
                    `Current mint authority (${mint.mintAuthority.toBase58()}) does not match payer (${payerKeypair.publicKey.toBase58()}). Retry with current authority`
                );
                process.exit(1);
            }

            const multisigTokenAuthority = argv["multisig"]
                ? new PublicKey(argv["multisig"])
                : undefined;
            // check if SPL-Multisig is supported for manager version
            if (multisigTokenAuthority) {
                // undeployed -- assume version compatible via warning
                if (major === -1) {
                    if (!argv["yes"]) {
                        console.warn(
                            chalk.yellow(
                                "SPL Multisig token mint authority is only supported for versions >= 3.x.x"
                            )
                        );
                        console.warn(
                            chalk.yellow(
                                "Ensure the program version you wish to deploy supports SPL Multisig token mint authority"
                            )
                        );
                        await askForConfirmation();
                    }
                }
                // unsupported version
                else if (major < 3) {
                    console.error(
                        "SPL Multisig token mint authority is only supported for versions >= 3.x.x"
                    );
                    console.error(
                        "Use 'ntt upgrade' to upgrade the NTT contract to a specific version."
                    );
                    process.exit(1);
                }
            }

            // verify new authority address is valid
            if (multisigTokenAuthority?.equals(tokenAuthority)) {
                console.error(
                    `New authority matches token authority (${multisigTokenAuthority.toBase58()}). To set mint authority as token authority, retry without --multisig`
                );
                process.exit(1);
            }

            // verify manager is paused if already deployed
            if (solanaNtt && !(await solanaNtt.isPaused())) {
                console.error(
                    `Not paused. Set \`paused\` for ${chain} to \`true\` in ${path} and run \`ntt push\` to sync the changes on-chain. Then retry this command.`
                );
                process.exit(1);
            }

            // program deployed
            if (solanaNtt) {
                // manager versions < 3.x.x have to call spl setAuthority instruction directly
                if (major < 3) {
                    try {
                        await spl.setAuthority(
                            connection,
                            payerKeypair,
                            tokenMint,
                            payerKeypair.publicKey,
                            spl.AuthorityType.MintTokens,
                            tokenAuthority,
                            [],
                            { commitment: "finalized" },
                            mintInfo.owner
                        );
                        console.log(
                            `Token mint authority successfully updated to ${tokenAuthority.toBase58()}`
                        );
                        process.exit(0);
                    } catch (error) {
                        if (error instanceof Error) {
                            console.error(error.message);
                        } else if (error instanceof SendTransactionError) {
                            console.error(error.logs);
                        }
                        process.exit(1);
                    }
                }

                // use lut if configured
                const luts: AddressLookupTableAccount[] = [];
                try {
                    luts.push(await solanaNtt.getAddressLookupTable());
                } catch {}

                // send versioned transaction
                try {
                    const latestBlockHash = await connection.getLatestBlockhash();
                    const messageV0 = new TransactionMessage({
                        payerKey: payerKeypair.publicKey,
                        instructions: [
                            await NTT.createAcceptTokenAuthorityInstruction(
                                solanaNtt.program,
                                await solanaNtt.getConfig(),
                                {
                                    currentAuthority: payerKeypair.publicKey,
                                    multisigTokenAuthority,
                                }
                            ),
                        ],
                        recentBlockhash: latestBlockHash.blockhash,
                    }).compileToV0Message(luts);
                    const vtx = new VersionedTransaction(messageV0);
                    vtx.sign([payerKeypair]);
                    const signature = await connection.sendTransaction(vtx, {});
                    await connection.confirmTransaction(
                        {
                            ...latestBlockHash,
                            signature,
                        },
                        "finalized"
                    );
                    console.log(
                        `Token mint authority successfully updated to ${(
                            multisigTokenAuthority ?? tokenAuthority
                        ).toBase58()}`
                    );
                } catch (error) {
                    if (error instanceof Error) {
                        console.error(error.message);
                    } else if (error instanceof SendTransactionError) {
                        console.error(error.logs);
                    }
                }
            }
            // undeployed case
            else {
                // verify new authority is valid SPL Multisig
                if (multisigTokenAuthority) {
                    // NOTE: the `acceptTokenAuthority` instruction would have done this check normally.
                    // However, since the program is not yet deployed, we do this check here.
                    const isMultisigTokenAuthority =
                        await checkSvmValidSplMultisig(
                            connection,
                            multisigTokenAuthority,
                            mintInfo.owner,
                            tokenAuthority
                        );
                    if (isMultisigTokenAuthority) {
                        console.error(
                            "Invalid SPL Multisig provided. Use 'ntt solana create-spl-multisig' to create valid SPL Multisig first"
                        );
                        process.exit(1);
                    }
                }

                // call spl setAuthority instruction directly as program is not yet deployed
                try {
                    await spl.setAuthority(
                        connection,
                        payerKeypair,
                        tokenMint,
                        payerKeypair.publicKey,
                        spl.AuthorityType.MintTokens,
                        multisigTokenAuthority ?? tokenAuthority,
                        [],
                        { commitment: "finalized" },
                        mintInfo.owner
                    );
                    console.log(
                        `Token mint authority successfully updated to ${(
                            multisigTokenAuthority ?? tokenAuthority
                        ).toBase58()}`
                    );
                    process.exit(0);
                } catch (error) {
                    if (error instanceof Error) {
                        console.error(error.message);
                    } else if (error instanceof SendTransactionError) {
                        console.error(error.logs);
                    }
                    process.exit(1);
                }
            }
        })
            .command("transfer-ownership <chain>",
            "transfer NTT manager ownership to a new wallet (EVM chains only)",
            (yargs) => yargs
                .positional("chain", options.chain)
                .option("destination", {
                    describe: "New owner wallet address",
                    type: "string",
                    demandOption: true,
                })
                .option("path", options.deploymentPath)
                .option("yes", options.yes)
                .example(
                    "$0 transfer-ownership Ethereum --destination 0x1234...",
                    "Transfer NTT manager ownership on Ethereum to a new wallet"
                )
                .example(
                    "$0 transfer-ownership Bsc --destination 0xabcd... --path ./my-deployment.json",
                    "Transfer NTT manager ownership on BSC to a new wallet using custom deployment file"
                ),
            async (argv) => {
                const path = argv["path"];
                const deployments: Config = loadConfig(path);
                const chain: Chain = argv["chain"];
                const destination = argv["destination"];
                const network = deployments.network as Network;

                // Check that the platform is EVM
                const platform = chainToPlatform(chain);
                if (platform !== "Evm") {
                    console.error(`transfer-ownership is only supported for EVM chains. Got platform: ${platform}`);
                    process.exit(1);
                }

                if (!(chain in deployments.chains)) {
                    console.error(`Chain ${chain} not found in deployment configuration`);
                    process.exit(1);
                }

                const chainConfig = deployments.chains[chain]!;
                console.log(`Transferring ownership on ${chain} (${network})`);
                console.log(`Manager address: ${chainConfig.manager}`);
                console.log(`New owner: ${destination}`);

                // Validate destination address
                if (!ethers.isAddress(destination)) {
                    console.error("Invalid destination address");
                    process.exit(1);
                }

                // Get NTT instance
                const [, , ntt] = await pullChainConfig(
                    network,
                    { chain, address: toUniversal(chain, chainConfig.manager) },
                    overrides
                );

                // Get current owner
                const currentOwner = await ntt.getOwner();
                console.log(`Current owner: ${currentOwner}`);

                // Get signer using the same pattern as other commands
                const wh = new Wormhole(network, [evm.Platform], overrides);
                const ch = wh.getChain(chain);
                const signer = await getSigner(ch, "privateKey");
                
                // Verify the wallet is the current owner
                if (currentOwner.toString().toLowerCase() !== signer.address.address.toString().toLowerCase()) {
                    console.error(`❌ Wallet ${signer.address.address} is not the current owner. Current owner is ${currentOwner}`);
                    process.exit(1);
                }

                if (!argv["yes"]) {
                    console.log("\n⚠️  ⚠️  ⚠️  CRITICAL WARNING ⚠️  ⚠️  ⚠️");
                    console.log("This ownership transfer is IRREVERSIBLE!");
                    console.log("Please TRIPLE-CHECK that the destination address is correct:");
                    console.log(`   ${destination}`);
                    console.log("");
                    await askForConfirmation(`Are you absolutely certain you want to transfer ownership to ${destination}?`);
                }

                try {
                    // Cast to EVM NTT and call transferOwnership
                    const evmNtt = ntt as EvmNtt<typeof network, EvmChains>;
                    
                    // Get the native ethers signer from the EvmNativeSigner
                    const nativeSigner = (signer.signer as any)._signer;
                    if (!nativeSigner || !nativeSigner.provider) {
                        throw new Error("Failed to get native ethers signer");
                    }
                    
                            const contract = evmNtt.manager.connect(nativeSigner);
                            const tx = await contract.transferOwnership(destination);
                            console.log(`Transaction hash: ${tx.hash}`);
                            console.log(`Waiting for 1 confirmation...`);
                            
                            // 1 confirmation, 5 minute timeout
                            await tx.wait(1, 300000);
                            
                            console.log(`Verifying ownership transfer...`);
                            const newOwnerFromContract = await evmNtt.manager.owner();
                            if (newOwnerFromContract.toLowerCase() === destination.toLowerCase()) {
                                console.log(`✅ Ownership transferred successfully to ${destination}`);
                            } else {
                                console.error(`❌ Ownership transfer verification failed`);
                                console.error(`   New owner:        ${newOwnerFromContract}`);
                                process.exit(1);
                            }
                    
                } catch (error: any) {
                    console.error("❌ Failed to transfer ownership:", error.message);
                    if (error.transaction) {
                        console.error("Transaction details:", error.transaction);
                    }
                    process.exit(1);
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
                .command("create-spl-multisig <multisigMemberPubkey...>",
                    "create a valid SPL Multisig (see https://github.com/wormhole-foundation/native-token-transfers/tree/main/solana#spl-multisig-support for more info)",
                    (yargs) => yargs
                        .positional("multisigMemberPubkey", {
                            describe: "public keys of the members that can independently mint",
                            type: "string",
                            demandOption: true,
                        })
                        .option("manager", {
                            describe: "Manager address",
                            type: "string",
                        })
                        .option("token", {
                            describe: "Token address",
                            type: "string",
                        })
                        .option("path", options.deploymentPath)
                        .option("yes", options.yes)
                        .option("payer", { ...options.payer, demandOption: true })
                        .example(
                            "$0 solana create-spl-multisig Sol1234... --token Sol3456... --manager Sol5678... --payer <SOLANA_KEYPAIR_PATH>",
                            "Create multisig with Sol1234... having independent mint privilege alongside NTT token-authority for undeployed program"
                        )
                        .example(
                            "$0 solana create-spl-multisig Sol1234... Sol3456... Sol5678... --payer <SOLANA_KEYPAIR_PATH>",
                            "Create multisig with Sol1234..., Sol3456..., and Sol5678... having mint privileges alongside NTT token-authority for deployed program"
                        ),
                    async (argv) => {
                        const path = argv["path"];
                        const deployments: Config = loadConfig(path);
                        const chain: Chain = "Solana";
                        const manager = argv["manager"];
                        const token = argv["token"];
                        const network = deployments.network as Network;

                        if (!fs.existsSync(argv["payer"])) {
                            console.error("Payer not found. Specify with --payer");
                            process.exit(1);
                        }
                        const payerKeypair = Keypair.fromSecretKey(
                            new Uint8Array(
                                JSON.parse(fs.readFileSync(argv["payer"]).toString())
                            )
                        );

                        if (!token !== !manager) {
                            console.error(
                                "Please provide both --token and --manager for an undeployed program"
                            );
                            process.exit(1);
                        }

                        const wh = new Wormhole(
                            network,
                            [solana.Platform, evm.Platform],
                            overrides
                        );
                        const ch = wh.getChain(chain);
                        const connection: Connection = await ch.getRpc();

                        let solanaNtt: SolanaNtt<typeof network, SolanaChains> | undefined;
                        let managerKey: PublicKey;
                        let major: number;
                        let tokenProgram: PublicKey;

                        // program deployed so fetch token and manager addresses from deployment
                        if (!token && !manager) {
                            if (!(chain in deployments.chains)) {
                                console.error(`Either provide --token and --manager flags, or ensure ${path} contains a valid ${chain} configuration`);
                                process.exit(1);
                            }
                            const chainConfig = deployments.chains[chain]!;
                            const [, , ntt] = await pullChainConfig(
                                network,
                                { chain, address: toUniversal(chain, chainConfig.manager) },
                                overrides
                            );
                            solanaNtt = ntt as SolanaNtt<typeof network, SolanaChains>;
                            managerKey = new PublicKey(chainConfig.manager);
                            major = Number(solanaNtt.version.split(".")[0]);
                            tokenProgram = (await solanaNtt.getConfig()).tokenProgram;
                        }
                        // default values as undeployed program
                        else {
                            // ensure mint is valid
                            const tokenMint = new PublicKey(token!);
                            const mintInfo = await connection.getAccountInfo(tokenMint);
                            if (!mintInfo) {
                                console.error(
                                    `Mint ${token} not found on ${ch.chain} ${ch.network}`
                                );
                                process.exit(1);
                            }
                            spl.unpackMint(tokenMint, mintInfo, mintInfo.owner);

                            solanaNtt = undefined;
                            managerKey = new PublicKey(manager!);
                            major = -1;
                            tokenProgram = mintInfo.owner;
                        }

                        const tokenAuthority = NTT.pdas(managerKey).tokenAuthority();

                        // check if SPL-Multisig is supported for manager version
                        // undeployed -- assume version compatible via warning
                        if (major === -1 && !argv["yes"]) {
                            console.warn(
                                chalk.yellow(
                                    "SPL Multisig token mint authority is only supported for versions >= 3.x.x"
                                )
                            );
                            console.warn(
                                chalk.yellow(
                                    "Ensure the program version you wish to deploy supports SPL Multisig token mint authority"
                                )
                            );
                            await askForConfirmation();
                        }
                        // unsupported version
                        else if (major < 3) {
                            console.error(
                                "SPL Multisig token mint authority is only supported for versions >= 3.x.x"
                            );
                            console.error(
                                "Use 'ntt upgrade' to upgrade the NTT contract to a specific version."
                            );
                            process.exit(1);
                        }

                        try {
                            // use same tokenProgram as token to create multisig
                            const additionalMemberPubkeys = (argv["multisigMemberPubkey"] as any).map(
                                (key: string) => new PublicKey(key)
                            );
                            const multisig = await spl.createMultisig(
                                connection,
                                payerKeypair,
                                [
                                    tokenAuthority,
                                    ...additionalMemberPubkeys,
                                ],
                                1,
                                undefined,
                                { commitment: "finalized" },
                                tokenProgram
                            );
                            console.log(`Valid SPL Multisig created: ${multisig.toBase58()}`);
                        } catch (error) {
                            if (error instanceof Error) {
                                console.error(error.message);
                            } else if (error instanceof SendTransactionError) {
                                console.error(error.logs);
                            }
                        }
                    })
                .demandCommand()
        }
    )
    .command("manual",
        "Manual NTT operations",
        (yargs) => {
            yargs
                .command("set-peer <peer-chain> <peer-address>",
                    "Manually set a peer relationship between NTT deployments",
                    (yargs) => yargs
                        .positional("peer-chain", {
                            describe: "Target chain to set as peer",
                            type: "string",
                            choices: chains,
                            demandOption: true,
                        })
                        .positional("peer-address", {
                            describe: "Universal address of the peer NTT manager",
                            type: "string",
                            demandOption: true,
                        })
                        .option("chain", {
                            describe: "Source chain where the peer will be set",
                            type: "string",
                            choices: chains,
                            demandOption: true,
                        })
                        .option("token-decimals", {
                            describe: "Token decimals for the peer chain",
                            type: "number",
                            demandOption: true,
                        })
                        .option("inbound-limit", {
                            describe: "Inbound rate limit for transfers from this peer",
                            type: "string",
                            demandOption: true,
                        })
                        .option("path", options.deploymentPath)
                        .option("network", options.network)
                        .option("signer-type", options.signerType)
                        .example("$0 manual set-peer Ethereum 0x742d35Cc6634C0532925a3b8D0C85e3c4e5cBB8D --chain Sui --token-decimals 18 --inbound-limit 1000000000000000000", "Set Ethereum as peer for Sui NTT"),
                    async (argv) => {
                        const path = argv["path"];
                        const deployments: Config = loadConfig(path);
                        const sourceChain: Chain = argv["chain"];
                        const peerChain: Chain = argv["peer-chain"];
                        const peerAddress = argv["peer-address"];
                        const tokenDecimals = argv["token-decimals"];
                        const inboundLimit = BigInt(argv["inbound-limit"]);
                        const network = argv["network"];
                        const signerType = argv["signer-type"] as SignerType;

                        // Validate network
                        if (!isNetwork(network)) {
                            console.error("Invalid network");
                            process.exit(1);
                        }

                        // Validate source chain exists in deployment
                        const sourceConfig = deployments.chains[sourceChain];
                        if (!sourceConfig) {
                            console.error(`Source chain ${sourceChain} not found in deployment configuration`);
                            process.exit(1);
                        }

                        console.log(chalk.blue("🔗 Manual setPeer Operation"));
                        console.log(`Source Chain: ${chalk.yellow(sourceChain)}`);
                        console.log(`Peer Chain: ${chalk.yellow(peerChain)}`);
                        console.log(`Peer Address: ${chalk.yellow(peerAddress)}`);
                        console.log(`Token Decimals: ${chalk.yellow(tokenDecimals)}`);
                        console.log(`Inbound Limit: ${chalk.yellow(inboundLimit.toString())}`);

                        try {
                            // Load source chain NTT configuration
                            const sourceManager = {
                                chain: sourceChain,
                                address: toUniversal(sourceChain, sourceConfig.manager)
                            };
                            const [config, ctx, ntt] = await pullChainConfig(
                                network,
                                sourceManager,
                                overrides
                            );

                            console.log(`\nSource NTT Manager: ${chalk.yellow(sourceConfig.manager)}`);

                            // Create peer address object
                            const peerChainAddress = {
                                chain: peerChain,
                                address: toUniversal(peerChain, peerAddress)
                            };

                            // Get signer for the source chain
                            const signer = await getSigner(ctx, signerType);

                            console.log(`Signer Address: ${chalk.yellow(signer.address.address.toString())}`);
                            console.log("\n" + chalk.blue("Executing setPeer transaction..."));

                            // Call setPeer on the NTT instance (it returns an AsyncGenerator)
                            const setPeerTxs = ntt.setPeer(peerChainAddress, tokenDecimals, inboundLimit);

                            // Create sign-send-wait function (no special owner for manual operations)
                            const signSendWaitFunc = newSignSendWaiter(undefined);

                            // Execute the transaction(s)

                            try {
                                const results = await signSendWaitFunc(ctx, setPeerTxs, signer.signer);

                                // Display transaction results
                                console.log(`Transaction Hash: ${chalk.green(results[0]?.txid || results[0] || "Transaction completed")}`);

                            } catch (signSendError) {
                                console.error("DEBUG: Error occurred in signSendWaitFunc:");
                                console.error("DEBUG: signSendError type:", typeof signSendError);
                                console.error("DEBUG: signSendError constructor:", signSendError?.constructor?.name);
                                console.error("DEBUG: signSendError message:", signSendError instanceof Error ? signSendError.message : String(signSendError));

                                if (signSendError instanceof Error) {
                                    console.error("DEBUG: signSendError stack:");
                                    console.error(signSendError.stack);
                                }

                                // Try to extract specific information about bytes.length error
                                const errorString = String(signSendError);
                                if (errorString.includes('bytes.length')) {
                                    console.error("DEBUG: *** FOUND bytes.length ERROR! ***");
                                    console.error("DEBUG: Full error string:", errorString);
                                }

                                throw signSendError;
                            }

                            console.log(chalk.green("\n✅ setPeer operation completed successfully!"));
                            console.log(`Peer relationship established: ${sourceChain} ↔ ${peerChain}`);

                        } catch (error) {
                            console.error(chalk.red("\n❌ setPeer operation failed:"));
                            console.error("ERROR: Main error message:", error instanceof Error ? error.message : String(error));

                            // Enhanced error logging for debugging
                            if (error instanceof Error) {
                                console.error("ERROR: Error name:", error.name);
                                console.error("ERROR: Error stack trace:");
                                console.error(error.stack || "No stack trace available");

                                // Check for nested errors or cause
                                if ('cause' in error && error.cause) {
                                    console.error("ERROR: Caused by:", error.cause);
                                }
                            }

                            // Log the error type and constructor
                            console.error("ERROR: Error type:", typeof error);
                            console.error("ERROR: Error constructor:", error?.constructor?.name);

                            // If it's a string or has toString, log that too
                            if (typeof error === 'object' && error !== null) {
                                try {
                                    console.error("ERROR: Error as JSON:", JSON.stringify(error, null, 2));
                                } catch (jsonError) {
                                    console.error("ERROR: Could not stringify error object:", jsonError);
                                }
                            }

                            process.exit(1);
                        }
                    })
                .command("transfer <destination-chain> <destination-address> <amount>",
                    "Transfer tokens via NTT to another chain",
                    (yargs) => yargs
                        .positional("destination-chain", {
                            describe: "Target chain to transfer to",
                            type: "string",
                            choices: chains,
                            demandOption: true,
                        })
                        .positional("destination-address", {
                            describe: "Recipient address on the destination chain",
                            type: "string",
                            demandOption: true,
                        })
                        .positional("amount", {
                            describe: "Amount to transfer (in token base units)",
                            type: "string",
                            demandOption: true,
                        })
                        .option("chain", {
                            describe: "Source chain to transfer from",
                            type: "string",
                            choices: chains,
                            demandOption: true,
                        })
                        .option("queue", {
                            describe: "Queue the transfer if rate limit is exceeded",
                            type: "boolean",
                            default: false,
                        })
                        .option("path", options.deploymentPath)
                        .option("network", options.network)
                        .option("signer-type", options.signerType)
                        .example("$0 manual transfer Ethereum 0x742d35Cc6634C0532925a3b8D0C85e3c4e5cBB8D 1000000000 --chain Sui", "Transfer 1 SUI to Ethereum"),
                    async (argv) => {
                        const path = argv["path"];
                        const deployments: Config = loadConfig(path);
                        const sourceChain: Chain = argv["chain"];
                        const destinationChain: Chain = argv["destination-chain"];
                        const destinationAddress = argv["destination-address"];
                        const amount = BigInt(argv["amount"]);
                        const queue = argv["queue"];
                        const network = argv["network"];
                        const signerType = argv["signer-type"] as SignerType;

                        // Validate network
                        if (!isNetwork(network)) {
                            console.error("Invalid network");
                            process.exit(1);
                        }

                        // Validate source chain exists in deployment
                        const sourceConfig = deployments.chains[sourceChain];
                        if (!sourceConfig) {
                            console.error(`Source chain ${sourceChain} not found in deployment configuration`);
                            process.exit(1);
                        }

                        console.log(chalk.blue("💰 Manual Transfer Operation"));
                        console.log(`Source Chain: ${chalk.yellow(sourceChain)}`);
                        console.log(`Destination Chain: ${chalk.yellow(destinationChain)}`);
                        console.log(`Destination Address: ${chalk.yellow(destinationAddress)}`);
                        console.log(`Amount: ${chalk.yellow(amount.toString())}`);
                        console.log(`Queue if rate limited: ${chalk.yellow(queue.toString())}`);

                        try {
                            // Load source chain NTT configuration
                            const sourceManager = {
                                chain: sourceChain,
                                address: toUniversal(sourceChain, sourceConfig.manager)
                            };
                            const [config, ctx, ntt] = await pullChainConfig(
                                network,
                                sourceManager,
                                overrides
                            );

                            console.log(`\nSource NTT Manager: ${chalk.yellow(sourceConfig.manager)}`);

                            // Create destination address object
                            const destinationChainAddress = {
                                chain: destinationChain,
                                address: toUniversal(destinationChain, destinationAddress)
                            };

                            // Get signer for the source chain
                            const signer = await getSigner(ctx, signerType);

                            console.log(`Signer Address: ${chalk.yellow(signer.address.address.toString())}`);
                            console.log("\n" + chalk.blue("Executing transfer transaction..."));

                            // Call transfer on the NTT instance (it returns an AsyncGenerator)
                            const transferTxs = ntt.transfer(
                                signer.address.address,
                                amount,
                                destinationChainAddress,
                                { queue }
                            );

                            // Create sign-send-wait function (no special owner for manual operations)
                            const signSendWaitFunc = newSignSendWaiter(undefined);

                            // Execute the transaction(s)

                            try {
                                const results = await signSendWaitFunc(ctx, transferTxs, signer.signer);

                                // Display transaction results
                                console.log(`Transaction Hash: ${chalk.green(results[0]?.txid || results[0] || "Transaction completed")}`);

                            } catch (transferError) {
                                console.error("DEBUG: Error occurred in transfer:");
                                console.error("DEBUG: transferError:", transferError instanceof Error ? transferError.message : String(transferError));

                                if (transferError instanceof Error) {
                                    console.error("DEBUG: transferError stack:");
                                    console.error(transferError.stack);
                                }

                                throw transferError;
                            }

                            console.log(chalk.green("\n✅ Transfer operation completed successfully!"));
                            console.log(`Transfer sent: ${sourceChain} → ${destinationChain}`);
                            console.log(`Amount: ${amount.toString()} tokens`);

                        } catch (error) {
                            console.error(chalk.red("\n❌ Transfer operation failed:"));
                            console.error("ERROR: Main error message:", error instanceof Error ? error.message : String(error));

                            if (error instanceof Error && error.stack) {
                                console.error("ERROR: Error stack trace:");
                                console.error(error.stack);
                            }

                            process.exit(1);
                        }
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
    standardRelaying: [Chain, boolean][];
    specialRelaying: [Chain, boolean][];
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
        case "Sui":
            const suiNtt = ntt as SuiNtt<N, SuiChains>;
            const suiCtx = ctx as ChainContext<N, SuiChains>;
            return upgradeSui(worktree, toVersion, suiNtt, suiCtx, signerType);
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
        const verifyArgsArray = buildVerifierArgs(ctx.chain);
        verifyArgs = verifyArgsArray.join(' ');
    }

    console.log("Upgrading manager...");
    const slowFlag = getSlowFlag(ctx.chain);
    await withCustomEvmDeployerScript(pwd, async () => {
        execSync(
            `forge script --via-ir script/DeployWormholeNtt.s.sol \
--rpc-url ${ctx.config.rpc} \
--sig "upgrade(address)" \
${ntt.managerAddress} \
${signerArgs} \
--broadcast ${slowFlag} \
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

async function upgradeSui<N extends Network, C extends SuiChains>(
    pwd: string,
    version: string | null,
    ntt: SuiNtt<N, C>,
    ctx: ChainContext<N, C>,
    signerType: SignerType
): Promise<void> {
    ensureNttRoot(pwd);

    console.log("Upgrading Sui chain", ctx.chain);

    // Setup Sui environment and execute upgrade
    await withSuiEnv(pwd, ctx, async () => {
        // Build the updated packages
        console.log("Building updated packages...");
        const packagesToBuild = ["ntt_common", "ntt", "wormhole_transceiver"];

        for (const packageName of packagesToBuild) {
            const packagePath = `${pwd}/sui/packages/${packageName}`;
            console.log(`Building package: ${packageName}`);

            try {
                execSync(`sui move build`, {
                    cwd: packagePath,
                    stdio: "inherit",
                    env: process.env
                });
            } catch (error) {
                console.error(`Failed to build package ${packageName}:`, error);
                throw error;
            }
        }

    // Get the current NTT manager address and retrieve upgrade capabilities
    const managerAddress = ntt.contracts.ntt?.manager;
    if (!managerAddress) {
        throw new Error("NTT manager address not found");
    }

    console.log("Retrieving upgrade capabilities...");

    // Get the upgrade cap ID from the NTT state
    let upgradeCapId: string;
    try {
        upgradeCapId = await ntt.getUpgradeCapId();
        console.log(`Found upgrade cap ID: ${upgradeCapId}`);
    } catch (error) {
        console.error("Failed to retrieve upgrade cap ID:", error);
        throw error;
    }

    // Only upgrade the NTT package (other packages don't have upgrade logic)
    const packagesToUpgrade = [
        { name: "Ntt", path: "sui/packages/ntt" }
    ];

    console.log("Upgrading packages using pure JavaScript...");

    // Get signer for transactions
    const signer = await getSigner(ctx, signerType);

    for (const pkg of packagesToUpgrade) {
        console.log(`Upgrading package: ${pkg.name}`);

        try {
            // Build the package first
            const packagePath = `${pwd}/${pkg.path}`;
            console.log(`Building package at: ${packagePath}`);

            execSync(`sui move build`, {
                cwd: packagePath,
                stdio: "pipe",
                env: process.env
            });

            // Perform all upgrade steps in a single PTB
            console.log(`Performing upgrade for ${pkg.name}...`);
            const upgradeTxs = (async function* () {
                const upgradeTx = await performPackageUpgradeInPTB(
                    ctx,
                    packagePath,
                    upgradeCapId,
                    ntt
                );
                yield upgradeTx;
            })();
            await signSendWait(ctx, upgradeTxs, signer.signer);

            console.log(`Successfully upgraded ${pkg.name}`);

        } catch (error) {
            console.error(`Failed to upgrade package ${pkg.name}:`, error);
            throw error;
        }
    }

        console.log("Upgrade process completed for Sui chain", ctx.chain);
    });
}

// Helper function to perform complete package upgrade in a single PTB
async function performPackageUpgradeInPTB<N extends Network, C extends SuiChains>(
    ctx: ChainContext<N, C>,
    packagePath: string,
    upgradeCapId: string,
    ntt: SuiNtt<N, C>
): Promise<any> {
    // Get the package name from the path
    const packageName = packagePath.split('/').pop();
    let buildPackageName: string;

    // Map directory names to build package names
    switch (packageName) {
        case "ntt_common":
            buildPackageName = "NttCommon";
            break;
        case "ntt":
            buildPackageName = "Ntt";
            break;
        case "wormhole_transceiver":
            buildPackageName = "WormholeTransceiver";
            break;
        default:
            throw new Error(`Unknown package: ${packageName}`);
    }

    // Get build output with dependencies using the correct sui command
    console.log(`Running sui move build --dump-bytecode-as-base64 for ${packagePath}...`);

    const buildOutput = execSync(`sui move build --dump-bytecode-as-base64 --path ${packagePath}`, {
        encoding: 'utf-8',
        env: process.env
    });

    const { modules, dependencies, digest } = JSON.parse(buildOutput);

    console.log(`Found ${modules.length} modules and ${dependencies.length} dependencies to upgrade`);
    console.log(`Build digest: ${digest}`);

    // Create a single PTB that performs all upgrade steps
    const tx = new Transaction();
    const packageId = await ntt.getPackageId();

    // Step 1: Authorize the upgrade - this returns an UpgradeTicket
    const upgradeTicket = tx.moveCall({
        target: `${packageId}::upgrades::authorize_upgrade`,
        arguments: [
            tx.object(upgradeCapId),
            tx.pure.vector("u8", Array.from(Buffer.from(digest, "hex")))
        ]
    });

    // Step 2: Perform the upgrade using the ticket
    const upgradeReceipt = tx.upgrade({
        modules,
        dependencies,
        package: packageId,
        ticket: upgradeTicket
    });

    // Step 3: Commit the upgrade
    tx.moveCall({
        target: `${packageId}::upgrades::commit_upgrade`,
        typeArguments: [ntt.contracts.ntt!["token"]], // Token type parameter
        arguments: [
            tx.object(upgradeCapId),
            tx.object(ntt.contracts.ntt!["manager"]), // state
            upgradeReceipt
        ]
    });

    // Set gas budget
    tx.setGasBudget(1000000000);

    // Return the unsigned transaction
    return {
        chainId: ctx.chain,
        transaction: tx,
        description: "Package Upgrade PTB"
    };
}

async function deploy<N extends Network, C extends Chain>(
    version: string | null,
    mode: Ntt.Mode,
    ch: ChainContext<N, C>,
    token: string,
    signerType: SignerType,
    evmVerify: boolean,
    yes: boolean,
    executor: boolean,
    solanaPayer?: string,
    solanaProgramKeyPath?: string,
    solanaBinaryPath?: string,
    solanaPriorityFee?: number,
    suiGasBudget?: number,
    suiPackagePath?: string,
    suiWormholeState?: string,
    suiTreasuryCap?: string
): Promise<ChainAddress<C> | SuiDeploymentResult<C>> {
    if (version === null) {
        await warnLocalDeployment(yes);
    }
    const platform = chainToPlatform(ch.chain);
    const worktree = version ? createWorkTree(platform, version) : ".";
    switch (platform) {
        case "Evm":
            return await deployEvm(worktree, mode, ch, token, signerType, evmVerify, executor);
        case "Solana":
            if (solanaPayer === undefined || !fs.existsSync(solanaPayer)) {
                console.error("Payer not found. Specify with --payer");
                process.exit(1);
            }
            const solanaCtx = ch as ChainContext<N, SolanaChains>;
            return await deploySolana(worktree, version, mode, solanaCtx, token, solanaPayer, true, solanaProgramKeyPath, solanaBinaryPath, solanaPriorityFee) as ChainAddress<C>;
        case "Sui":
            const suiCtx = ch as ChainContext<N, Chain>; // TODO: Use proper SuiChains type
            return await deploySui(worktree, version, mode, suiCtx, token, signerType, true, evmVerify, suiGasBudget, suiPackagePath, suiWormholeState, suiTreasuryCap) as any;
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
    executor: boolean,
): Promise<ChainAddress<C>> {
    ensureNttRoot(pwd);

    const wormhole = ch.config.contracts.coreBridge;
    if (!wormhole) {
        console.error("Core bridge not found");
        process.exit(1);
    }
    const relayer = ch.config.contracts.relayer;
    if (!relayer && !executor) {
        console.error("Standard Relayer not found. If you want to use the Executor, pass the --executor flag to add-chain");
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

    let verifyArgs: string[] = [];
    if (verify) {
        verifyArgs = buildVerifierArgs(ch.chain);
    }

    console.log("Installing forge dependencies...")
    execSync("forge install", {
        cwd: `${pwd}/evm`,
        stdio: "pipe"
    });

    console.log("Deploying manager...");
    const deploy = async (simulate: boolean): Promise<string> => {
        const simulateArg = simulate ? "" : "--skip-simulation";
        const slowFlag = getSlowFlag(ch.chain);
        const effectiveRelayer = relayer || "0x0000000000000000000000000000000000000000";
        await withCustomEvmDeployerScript(pwd, async () => {
            try {
                execSync(`
forge script --via-ir script/DeployWormholeNtt.s.sol \
--rpc-url ${rpc} \
${simulateArg} \
--sig "${sig}" ${wormhole} ${token} ${effectiveRelayer} ${specialRelayer} ${decimals} ${modeUint} \
--broadcast ${slowFlag} ${verifyArgs.join(' ')} ${signerArgs} 2>&1 | tee last-run.stdout`, {
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

    checkSolanaVersion(pwd);

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
    const connection: Connection = await ch.getRpc();
    const mintInfo = await connection.getAccountInfo(tokenMint);
    if (!mintInfo) {
        console.error(`Mint ${token} not found on ${ch.chain} ${ch.network}`);
        process.exit(1);
    }
    const mint = spl.unpackMint(tokenMint, mintInfo, mintInfo.owner);
    const tokenAuthority = ntt.pdas.tokenAuthority();

    if (mode === "burning") {
        // verify mint authority is token authority or valid SPL Multisig
        const actualMintAuthority: string | null = mint.mintAuthority?.toBase58() ?? null;
        if (actualMintAuthority !== tokenAuthority.toBase58()) {
            const isValidSplMultisig = actualMintAuthority && await checkSvmValidSplMultisig(
                connection,
                new PublicKey(actualMintAuthority),
                mintInfo.owner,
                tokenAuthority
            );
            if (!isValidSplMultisig) {
                console.error(`Mint authority mismatch for ${token}`);
                console.error(
                    `Expected: ${tokenAuthority.toBase58()} or valid SPL Multisig`
                );
                console.error(`Actual: ${actualMintAuthority}`);
                console.error(
                    `Set the mint authority to the program's token authority PDA with e.g.:`
                );
                console.error(
                    `ntt solana set-mint-authority --token ${token} --manager ${providedProgramId}`
                );
                process.exit(1);
            }
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
            checkAnchorVersion(pwd);
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


        const wh = new Wormhole(ch.network, [solana.Platform], overrides);
        const sol = wh.getChain("Solana");
        const solanaAddress = sol.config.contracts.coreBridge;
        if (!solanaAddress) {
            console.error("Core bridge address not found in Solana config");
            process.exit(1);
        }

        if (ch.chain !== "Solana") {
            await patchSolanaBinary(binary, wormhole, solanaAddress);
        }
        await checkSolanaBinary(binary, wormhole, providedProgramId, version ?? undefined);

        // if buffer.json doesn't exist, create it
        if (!fs.existsSync(`buffer.json`)) {
            execSync(`solana-keygen new -o buffer.json --no-bip39-passphrase`);
        } else {
            console.info("buffer.json already exists.")
            await askForConfirmation("Do you want continue an exiting deployment? If not, delete the buffer.json file and run the command again.");
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
                ...(mode === "burning" && !mint.mintAuthority!.equals(tokenAuthority) && {
                    multisigTokenAuthority: mint.mintAuthority!,
                }),
            }
        );

        const signer = await getSigner(ch, "privateKey", encoding.b58.encode(payerKeypair.secretKey));

        try {
            await signSendWait(ch, tx, signer.signer);
        } catch (e: any) {
            console.error(e.logs);
        }
    }

    return { chain: ch.chain, address: toUniversal(ch.chain, providedProgramId) };
}

// Helper function to update Move.toml files for network-specific dependencies
function updateMoveTomlForNetwork(packagesPath: string, networkType: Network): { restore: () => void } {
    const packages = ['ntt_common', 'ntt', 'wormhole_transceiver'];
    const backups: { [key: string]: string } = {};

    // Determine the correct revisions based on network (with environment variable overrides)
    const wormholeRev = process.env.WORMHOLE_REV ||
        (networkType === 'Mainnet' ? 'sui/mainnet' : 'sui/testnet');

    // localhost not supported for now, because the
    if (networkType === 'Devnet') {
        throw new Error("devnet not supported yet");
    }

    console.log(`Updating Move.toml files for ${networkType} network...`);
    console.log(`  Wormhole revision: ${wormholeRev}`);

    for (const packageName of packages) {
        const moveTomlPath = `${packagesPath}/${packageName}/Move.toml`;

        try {
            // Backup original content
            const originalContent = fs.readFileSync(moveTomlPath, 'utf8');
            backups[moveTomlPath] = originalContent;

            let content = originalContent;

            // Update Wormhole revision
            content = content.replace(
                /rev = "sui\/(testnet|mainnet)"/g,
                `rev = "${wormholeRev}"`
            );

            // Only write if content actually changed
            if (content !== originalContent) {
                fs.writeFileSync(moveTomlPath, content, 'utf8');
                console.log(`  Updated ${packageName}/Move.toml`);
            } else {
                console.log(`  No changes needed for ${packageName}/Move.toml`);
            }

        } catch (error) {
            console.warn(`  Warning: Could not update ${packageName}/Move.toml: ${error}`);
            // Don't throw error here to allow deployment to continue
        }
    }

    // Return restore function
    return {
        restore: () => {
            console.log("Restoring original Move.toml files...");
            for (const [filePath, content] of Object.entries(backups)) {
                try {
                    fs.writeFileSync(filePath, content, 'utf8');
                } catch (error) {
                    console.warn(`  Warning: Could not restore ${filePath}: ${error}`);
                }
            }
        }
    };
}

async function deploySui<N extends Network, C extends Chain>(
    pwd: string,
    version: string | null,
    mode: Ntt.Mode,
    ch: ChainContext<N, C>,
    token: string,
    signerType: SignerType,
    initialize: boolean,
    skipVerify?: boolean,
    gasBudget?: number,
    packagePath?: string,
    wormholeStateId?: string,
    treasuryCapId?: string
): Promise<SuiDeploymentResult<C>> {
    const finalPackagePath = packagePath || "sui";
    const finalGasBudget = gasBudget || 100000000;

    console.log(`Deploying Sui NTT contracts in ${mode} mode...`);
    console.log(`Package path: ${finalPackagePath}`);
    console.log(`Gas budget: ${finalGasBudget}`);
    console.log(`Target chain: ${ch.chain}`);
    console.log(`Token: ${token}`);

    // Setup Sui environment and execute deployment
    return await withSuiEnv(pwd, ch, async () => {
        const signer = await getSigner(ch, signerType);

        // Build the Move packages
        console.log("Building Move packages...");
        const packagesPath = `${pwd}/${finalPackagePath}/packages`;

        // Detect network type and update Move.toml files accordingly
        const networkType = ch.network;
        const { restore } = updateMoveTomlForNetwork(packagesPath, networkType);

        // Ensure we restore files if deployment fails
        try {

        // Build ntt_common first (dependency)
        try {
            console.log("Building ntt_common package...");
            execSync(`cd ${packagesPath}/ntt_common && sui move build`, {
                stdio: "inherit",
                env: process.env
            });
        } catch (e) {
            console.error("Failed to build ntt_common package");
            throw e;
        }

        // Build ntt package
        try {
            console.log("Building ntt package...");
            execSync(`cd ${packagesPath}/ntt && sui move build`, {
                stdio: "inherit",
                env: process.env
            });
        } catch (e) {
            console.error("Failed to build ntt package");
            throw e;
        }

        // Build wormhole_transceiver package
        try {
            console.log("Building wormhole_transceiver package...");
            execSync(`cd ${packagesPath}/wormhole_transceiver && sui move build`, {
                stdio: "inherit",
                env: process.env
            });
        } catch (e) {
            console.error("Failed to build wormhole_transceiver package");
            throw e;
        }

        // Deploy packages in order
        console.log("Deploying packages...");

        // 1. Deploy ntt_common
        console.log("Publishing ntt_common package...");
        const nttCommonResult = execSync(
            `cd ${packagesPath}/ntt_common && sui client publish --gas-budget ${finalGasBudget} --json`,
            {
                encoding: "utf8",
                env: process.env
            }
        );

        const nttCommonDeploy = JSON.parse(nttCommonResult);
        if (!nttCommonDeploy.objectChanges) {
            throw new Error("Failed to deploy ntt_common package");
        }

        const nttCommonPackageId = nttCommonDeploy.objectChanges.find(
            (change: any) => change.type === "published"
        )?.packageId;

        if (!nttCommonPackageId) {
            throw new Error("Could not find ntt_common package ID");
        }

        console.log(`ntt_common deployed at: ${nttCommonPackageId}`);

        // 2. Deploy ntt package
        console.log("Publishing ntt package...");
        const nttResult = execSync(
            `cd ${packagesPath}/ntt && sui client publish --gas-budget ${finalGasBudget} --json`,
            {
                encoding: "utf8",
                env: process.env
            }
        );

        const nttDeploy = JSON.parse(nttResult);
        if (!nttDeploy.objectChanges) {
            throw new Error("Failed to deploy ntt package");
        }

        const nttPackageId = nttDeploy.objectChanges.find(
            (change: any) => change.type === "published"
        )?.packageId;

        if (!nttPackageId) {
            throw new Error("Could not find ntt package ID");
        }

        console.log(`ntt deployed at: ${nttPackageId}`);

        // 3. Deploy wormhole_transceiver package
        console.log("Publishing wormhole_transceiver package...");
        const whTransceiverResult = execSync(
            `cd ${packagesPath}/wormhole_transceiver && sui client publish --gas-budget ${finalGasBudget} --json`,
            {
                encoding: "utf8",
                env: process.env
            }
        );

        const whTransceiverDeploy = JSON.parse(whTransceiverResult);
        if (!whTransceiverDeploy.objectChanges) {
            throw new Error("Failed to deploy wormhole_transceiver package");
        }

        const whTransceiverPackageId = whTransceiverDeploy.objectChanges.find(
            (change: any) => change.type === "published"
        )?.packageId;

        if (!whTransceiverPackageId) {
            throw new Error("Could not find wormhole_transceiver package ID");
        }

        console.log(`wormhole_transceiver deployed at: ${whTransceiverPackageId}`);

        // Initialize NTT manager
        console.log("Initializing NTT manager...");

        // 1. Get the deployer caps from deployment results
        const nttDeployerCapId = nttDeploy.objectChanges.find(
            (change: any) => change.type === "created" &&
                change.objectType?.includes("setup::DeployerCap")
        )?.objectId;

        if (!nttDeployerCapId) {
            throw new Error("Could not find NTT DeployerCap object ID");
        }

        const whTransceiverDeployerCapId = whTransceiverDeploy.objectChanges.find(
            (change: any) => change.type === "created" &&
                change.objectType?.includes("DeployerCap")
        )?.objectId;

        if (!whTransceiverDeployerCapId) {
            throw new Error("Could not find Wormhole Transceiver DeployerCap object ID");
        }


        // 2. Get the upgrade cap from NTT deployment
        const nttUpgradeCapId = nttDeploy.objectChanges.find(
            (change: any) => change.type === "created" &&
                change.objectType?.includes("UpgradeCap")
        )?.objectId;

        if (!nttUpgradeCapId) {
            throw new Error("Could not find NTT UpgradeCap object ID");
        }

        // 3. Get Wormhole core bridge state
        let wormholeStateObjectId: string | undefined;
        if (wormholeStateId) {
            wormholeStateObjectId = wormholeStateId;
            console.log(`Using provided Wormhole State ID: ${wormholeStateObjectId}`);
        } else {
            // Try to get the Wormhole state from the SDK configuration
            try {
                console.log("No wormhole state ID provided, looking up from SDK configuration...");
                const wormholeConfig = ch.config.contracts?.coreBridge;
                if (wormholeConfig) {
                    wormholeStateObjectId = wormholeConfig;
                    console.log(`Using Wormhole State ID from SDK: ${wormholeStateObjectId}`);
                } else {
                    console.log("No Wormhole core bridge contract found in SDK configuration, will skip wormhole transceiver setup");
                }
            } catch (error) {
                console.log("Failed to lookup Wormhole state from SDK, will skip wormhole transceiver setup");
                console.log("Error:", error instanceof Error ? error.message : String(error));
            }
        }

        // 4. Call setup::complete_burning or setup::complete_locking to initialize the NTT manager state
        const chainId = ch.config.chainId; // Get numeric chain ID from config
        const modeArg = mode === "locking" ? "Locking" : "Burning";

        console.log(`Completing NTT setup with mode: ${modeArg}, chain ID: ${chainId}`);

        // Build the transaction using Sui SDK
        const tx = new Transaction();

        if (mode === "burning") {
            // Call setup::complete_burning (which now requires treasury cap)
            console.log("Attempting to call setup::complete_burning...");
            console.log("Package ID:", nttPackageId);
            console.log("Function target:", `${nttPackageId}::setup::complete_burning`);
            console.log("Token type:", token);

            // For burning mode, we need a treasury cap
            if (!treasuryCapId) {
                throw new Error("Burning mode deployment requires a treasury cap. Please provide --sui-treasury-cap <TREASURY_CAP_ID>");
            }

            console.log("Treasury Cap ID:", treasuryCapId);

            const [adminCap, upgradeCapNtt] = tx.moveCall({
                target: `${nttPackageId}::setup::complete_burning`,
                typeArguments: [token],
                arguments: [
                    tx.object(nttDeployerCapId),
                    tx.object(nttUpgradeCapId),
                    tx.pure.u16(chainId),
                    tx.object(treasuryCapId)
                ],
            });

            // Transfer both capability objects to the transaction sender
            tx.transferObjects([adminCap, upgradeCapNtt], tx.pure.address(signer.address.address.toString()));
        } else {
            // Call setup::complete_locking
            console.log("Attempting to call setup::complete_locking...");
            console.log("Package ID:", nttPackageId);
            console.log("Function target:", `${nttPackageId}::setup::complete_locking`);
            console.log("Token type:", token);

            const [adminCap, upgradeCapNtt] = tx.moveCall({
                target: `${nttPackageId}::setup::complete_locking`,
                typeArguments: [token], // Use the original token format
                arguments: [
                    tx.object(nttDeployerCapId),
                    tx.object(nttUpgradeCapId),
                    tx.pure.u16(chainId)
                ],
            });

            // Transfer both capability objects to the transaction sender
            tx.transferObjects([adminCap, upgradeCapNtt], tx.pure.address(signer.address.address.toString()));
        }

        // Set gas budget
        tx.setGasBudget(finalGasBudget);

        // Execute the transaction using the signer's client
        // TODO: clean this up
        const suiSigner = signer.signer as any; // Cast to access internal client
        const setupResult = await suiSigner.client.signAndExecuteTransaction({
            signer: suiSigner._signer, // Access the underlying Ed25519Keypair
            transaction: tx,
            options: {
                showEffects: true,
                showObjectChanges: true,
            },
        });

        const setupDeploy = setupResult;
        if (!setupDeploy.objectChanges) {
            throw new Error("Failed to complete NTT setup");
        }

        // Log all object changes and effects to debug
        console.log("Transaction effects:", JSON.stringify(setupDeploy.effects, null, 2));
        console.log("Object changes:", JSON.stringify(setupDeploy.objectChanges, null, 2));

        // Find the shared State object
        const nttStateId = setupDeploy.objectChanges.find(
            (change: any) => change.type === "created" &&
                change.objectType?.includes("state::State") &&
                change.owner?.Shared
        )?.objectId;

        if (!nttStateId) {
            console.log("Looking for any shared objects...");
            const sharedObjects = setupDeploy.objectChanges.filter(
                (change: any) => change.owner === "Shared"
            );
            console.log("Shared objects:", JSON.stringify(sharedObjects, null, 2));
            throw new Error("Could not find NTT State object ID");
        }

        // Find the NTT AdminCap object ID for future reference
        const nttAdminCapId = setupDeploy.objectChanges.find(
            (change: any) => change.type === "created" &&
                change.objectType?.includes("state::AdminCap")
        )?.objectId;

        if (nttAdminCapId) {
            console.log(`NTT AdminCap created at: ${nttAdminCapId}`);
        }

        console.log(`NTT State created at: ${nttStateId}`);

        // 5. Complete wormhole transceiver setup
        let transceiverStateId: string | undefined;
        let whTransceiverAdminCapId: string | undefined;

        if (wormholeStateObjectId) {
            console.log("Completing Wormhole Transceiver setup...");

            // Build the transceiver setup transaction
            const transceiverTx = new Transaction();

            console.log(`  Package: ${whTransceiverPackageId}`);
            console.log(`  Module: wormhole_transceiver`);
            console.log(`  Function: complete`);
            console.log(`  Type args: ${nttPackageId}::auth::ManagerAuth`);
            console.log(`  Deployer cap: ${whTransceiverDeployerCapId}`);
            console.log(`  Wormhole state: ${wormholeStateObjectId}`);

            // Call wormhole_transceiver::complete and transfer the returned AdminCap
            const [adminCap] = transceiverTx.moveCall({
                target: `${whTransceiverPackageId}::wormhole_transceiver::complete`,
                typeArguments: [`${nttPackageId}::auth::ManagerAuth`],
                arguments: [
                    transceiverTx.object(whTransceiverDeployerCapId),
                    transceiverTx.object(wormholeStateObjectId),
                ],
            });

            // Transfer the AdminCap to the signer to avoid UnusedValueWithoutDrop
            transceiverTx.transferObjects([adminCap], signer.address.address.toString());

            transceiverTx.setGasBudget(finalGasBudget);

            // Execute the transceiver setup transaction using the same method as NTT setup
            try {
                // Wait a moment to allow the network to settle after NTT setup
                await new Promise(resolve => setTimeout(resolve, 1000));

                const suiSigner = signer.signer as any; // Cast to access internal client
                const transceiverSetupResult = await suiSigner.client.signAndExecuteTransaction({
                    signer: suiSigner._signer, // Access the underlying Ed25519Keypair
                    transaction: transceiverTx,
                    options: {
                        showEffects: true,
                        showObjectChanges: true,
                    },
                });

                const transceiverSetupDeploy = transceiverSetupResult;
                if (!transceiverSetupDeploy.objectChanges) {
                    throw new Error("Failed to complete Wormhole Transceiver setup");
                }

                console.log(JSON.stringify(transceiverSetupDeploy.objectChanges, null, 2));

                // Find the transceiver state - look for State object that is shared
                transceiverStateId = transceiverSetupDeploy.objectChanges.find(
                    (change: any) => change.type === "created" &&
                        change.objectType?.includes("::wormhole_transceiver::State") &&
                        change.owner?.Shared
                )?.objectId;

                if (!transceiverStateId) {
                    console.log("Looking for any State object (not just shared)...");
                    const stateObject = transceiverSetupDeploy.objectChanges.find(
                        (change: any) => change.type === "created" &&
                            change.objectType?.includes("State")
                    );
                    if (stateObject) {
                        console.log("Found State object:", JSON.stringify(stateObject, null, 2));
                    }
                    throw new Error("Could not find Wormhole Transceiver State object ID");
                }

                console.log(`Wormhole Transceiver State created at: ${transceiverStateId}`);

                // Find the AdminCap object ID for future reference
                whTransceiverAdminCapId = transceiverSetupDeploy.objectChanges.find(
                    (change: any) => change.type === "created" &&
                        change.objectType?.includes("::wormhole_transceiver::AdminCap")
                )?.objectId;

                if (whTransceiverAdminCapId) {
                    console.log(`Wormhole Transceiver AdminCap created at: ${whTransceiverAdminCapId}`);
                }

                // 6. Register the wormhole transceiver with the NTT manager
                if (nttAdminCapId && transceiverStateId) {
                    console.log("Registering wormhole transceiver with NTT manager...");

                    const registerTx = new Transaction();

                    console.log(`  NTT State: ${nttStateId}`);
                    console.log(`  NTT AdminCap: ${nttAdminCapId}`);
                    console.log(`  Transceiver Type: ${whTransceiverPackageId}::wormhole_transceiver::TransceiverAuth`);

                    // Call state::register_transceiver to register the wormhole transceiver
                    registerTx.moveCall({
                        target: `${nttPackageId}::state::register_transceiver`,
                        typeArguments: [
                            `${whTransceiverPackageId}::wormhole_transceiver::TransceiverAuth`, // Transceiver type
                            token // Token type
                        ],
                        arguments: [
                            registerTx.object(nttStateId), // NTT state (mutable)
                            registerTx.object(transceiverStateId),
                            registerTx.object(nttAdminCapId), // AdminCap for authorization
                        ],
                    });

                    registerTx.setGasBudget(finalGasBudget);

                    try {
                        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for network

                        const registerResult = await suiSigner.client.signAndExecuteTransaction({
                            signer: suiSigner._signer,
                            transaction: registerTx,
                            options: {
                                showEffects: true,
                                showObjectChanges: true,
                            },
                        });

                        if (registerResult.effects?.status?.status !== "success") {
                            throw new Error(`Registration failed: ${JSON.stringify(registerResult.effects?.status)}`);
                        }

                        console.log("✅ Wormhole transceiver successfully registered with NTT manager");
                    } catch (error) {
                        console.error("❌ Failed to register wormhole transceiver with NTT manager:", error);
                        // Don't throw here, let deployment continue, but warn the user
                        console.warn("⚠️  Deployment completed but transceiver registration failed. You may need to register it manually.");
                    }
                } else {
                    console.warn("⚠️  Skipping transceiver registration: missing NTT AdminCap or transceiver state ID");
                }

            } catch (error) {
                console.error("Wormhole Transceiver setup failed:", error);
                console.error("Error details:", JSON.stringify(error, null, 2));
                throw error;
            }
        } else {
            console.log("Skipping Wormhole Transceiver setup (no wormhole state available)...");
            console.log("Note: Wormhole state not found in SDK configuration. To manually specify, use --sui-wormhole-state parameter.");
        }

        console.log(chalk.green("Sui NTT deployment completed successfully!"));
        console.log(`NTT Package ID: ${nttPackageId}`);
        console.log(`NTT State ID: ${nttStateId}`);
        console.log(`Wormhole Transceiver Package ID: ${whTransceiverPackageId}`);
        console.log(`Wormhole Transceiver State ID: ${transceiverStateId || "Not deployed (skipped)"}`);

        // Restore original Move.toml files after successful deployment
        restore();

        // Return the deployment information including AdminCaps and package IDs
        return {
            chain: ch.chain,
            address: toUniversal(ch.chain, nttStateId),
            adminCaps: {
                wormholeTransceiver: whTransceiverAdminCapId
            },
            transceiverStateIds: {
                wormhole: transceiverStateId
            },
            packageIds: {
                ntt: nttPackageId,
                nttCommon: nttCommonPackageId,
                wormholeTransceiver: whTransceiverPackageId
            },
        };

        } catch (deploymentError) {
            // Restore original Move.toml files if deployment fails
            restore();
            throw deploymentError;
        }
    });
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
            const updateLUT = solanaNtt.initializeOrUpdateLUT({ payer: new PublicKey(0), owner: new PublicKey(0) });
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
                    const desiredStandardRelaying = !(from.config.local?.transceivers.wormhole.executor ?? false);
                    if (standardRelaying !== desiredStandardRelaying) {
                        count++;
                        missing.standardRelaying.push([toChain, desiredStandardRelaying]);
                    }
                } else if (toIsSolana) {
                    const specialRelaying = await whTransceiver.isSpecialRelayingEnabled(toChain);
                    const desiredSpecialRelaying = !(from.config.local?.transceivers.wormhole.executor ?? false);
                    if (specialRelaying !== desiredSpecialRelaying) {
                        count++;
                        missing.specialRelaying.push([toChain, desiredSpecialRelaying]);
                    }
                }
            }

            const transceiverPeer = await retryWithExponentialBackoff(() => from.whTransceiver.getPeer(toChain), 5, 5000);
            const transceiverAddress = await to.whTransceiver.getAddress();
            if (transceiverPeer === null) {
                count++;
                missing.transceiverPeers.push(transceiverAddress);
            } else {
                // @ts-ignore TODO
                if (!Buffer.from(transceiverPeer.address.address).equals(Buffer.from(transceiverAddress.address.address))) {
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
    const diff = diffObjects(deployment.config.local!, deployment.config.remote!, EXCLUDED_DIFF_PATHS);
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
                if (j === "threshold") {
                    const newThreshold = diff[k]![j]!.push;
                    if (newThreshold !== undefined) {
                        txs.push(deployment.ntt.setThreshold(newThreshold, signer.address.address));
                    }
                } else if (j === "wormhole") {
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
    overrides?: WormholeConfigOverrides<N>,
): Promise<[ChainConfig, ChainContext<typeof network, C>, Ntt<typeof network, C>, number]> {
    const wh = new Wormhole(network, [solana.Platform, evm.Platform, sui.Platform], overrides);
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
        case "Sui":
            // For Sui, return a default version since version property is not implemented yet
            return "dev";
        default:
            throw new Error("Unsupported platform");
    }
}


// TODO: there should be a more elegant way to do this, than creating a
// "dummy" NTT, then calling verifyAddresses to get the contract diff, then
// finally reconstructing the "real" NTT object from that
async function nttFromManager<N extends Network, C extends Chain>(
    ch: ChainContext<N, C>,
    nativeManagerAddress: string,
): Promise<{ ntt: Ntt<N, C>; addresses: Partial<Ntt.Contracts> }> {
    const onlyManager = await ch.getProtocol("Ntt", {
        ntt: {
            manager: nativeManagerAddress,
            transceiver: {},
        }
    });
    const diff = await onlyManager.verifyAddresses();

    const addresses: Partial<Ntt.Contracts> = {
        manager: nativeManagerAddress,
        ...diff
    };

    // For other chains, use the standard protocol creation
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
        rl.question(`${prompt} [y/N]`, resolve);
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

async function patchSolanaBinary(binary: string, wormhole: string, solanaAddress: string) {
    // Ensure binary path exists
    if (!fs.existsSync(binary)) {
        console.error(`.so file not found: ${binary}`);
        process.exit(1);
    }

    // Convert addresses from base58 to Buffer
    const wormholeBuffer = new PublicKey(wormhole).toBuffer();
    const solanaAddressBuffer = new PublicKey(solanaAddress).toBuffer();

    // Read the binary file
    let binaryData = fs.readFileSync(binary);

    // Find and count occurrences of core bridge address
    let occurrences = 0;
    let searchIndex = 0;

    // Replace all occurrences of core bridge with wormhole
    searchIndex = 0;
    while (true) {
        const index = binaryData.indexOf(solanaAddressBuffer, searchIndex);
        if (index === -1) break;
        occurrences++;

        // Replace the bytes at this position
        wormholeBuffer.copy(binaryData, index);
        searchIndex = index + solanaAddressBuffer.length;
    }

    // Write the patched binary back to file
    fs.writeFileSync(binary, binaryData);

    if (occurrences > 0) {
        console.log(`Patched binary, replacing ${solanaAddress} with ${wormhole} in ${occurrences} places.`);
    }
}

async function checkSolanaBinary(binary: string, wormhole: string, providedProgramId: string, version?: string) {
    // ensure binary path exists
    if (!fs.existsSync(binary)) {
        console.error(`.so file not found: ${binary}`);
        process.exit(1);
    }

    // convert addresses from base58 to Buffer
    const wormholeBuffer = new PublicKey(wormhole).toBuffer();
    const providedProgramIdBuffer = new PublicKey(providedProgramId).toBuffer();
    const versionBuffer = version ? Buffer.from(version, 'utf8') : undefined;

    if (!searchBufferInBinary(binary, wormholeBuffer)) {
        console.error(`Wormhole address not found in binary: ${wormhole}`);
        process.exit(1);
    }
    if (!searchBufferInBinary(binary, providedProgramIdBuffer)) {
        console.error(`Provided program ID not found in binary: ${providedProgramId}`);
        process.exit(1);
    }
    if (versionBuffer && !searchBufferInBinary(binary, versionBuffer)) {
        // TODO: figure out how to search for the version string in the binary
        // console.error(`Version string not found in binary: ${version}`);
        // process.exit(1);
    }
}

// Search for a buffer pattern within a binary file using direct buffer operations
function searchBufferInBinary(binaryPath: string, searchBuffer: Buffer): boolean {
    const binaryData = fs.readFileSync(binaryPath);
    return binaryData.indexOf(searchBuffer) !== -1;
}

function getSlowFlag(chain: Chain): string {
    return chain === "Mezo" || chain === "HyperEVM" || chain == "XRPLEVM" ? "--slow" : "";
}

export function ensureNttRoot(pwd: string = ".") {
    if (!fs.existsSync(`${pwd}/evm/foundry.toml`) || !fs.existsSync(`${pwd}/solana/Anchor.toml`)) {
        console.error("Run this command from the root of an NTT project.");
        process.exit(1);
    }
}

// Check Solana toolchain version against Anchor.toml requirements
function checkSolanaVersion(pwd: string): void {
    try {
        // Read required version from Anchor.toml
        const anchorToml = fs.readFileSync(`${pwd}/solana/Anchor.toml`, 'utf8');
        const versionMatch = anchorToml.match(/solana_version = "(.+)"/);

        if (!versionMatch) {
            console.warn(chalk.yellow("Warning: Could not find solana_version in Anchor.toml"));
            return;
        }

        const requiredVersion = versionMatch[1];

        // Get current Solana version and detect client type
        let currentVersion: string;
        let clientType: 'agave' | 'solanalabs';
        try {
            const output = execSync('solana --version', { encoding: 'utf8', stdio: 'pipe' });
            const versionMatch = output.match(/solana-cli (\d+\.\d+\.\d+)/);
            if (!versionMatch) {
                console.error(chalk.red("Error: Could not parse solana CLI version"));
                process.exit(1);
            }
            currentVersion = versionMatch[1];

            // Detect client type
            if (output.includes('Agave')) {
                clientType = 'agave';
            } else if (output.includes('SolanaLabs')) {
                clientType = 'solanalabs';
            } else {
                // Default to agave if we can't detect
                clientType = 'agave';
            }
        } catch (error) {
            console.error(chalk.red("Error: solana CLI not found. Please install the Solana toolchain."));
            console.error(chalk.yellow("Install with: sh -c \"$(curl -sSfL https://release.anza.xyz/stable/install)\""));
            process.exit(1);
        }

        if (currentVersion !== requiredVersion) {
            console.log(chalk.yellow(`Solana version mismatch detected:`));
            console.log(chalk.yellow(`  Required: ${requiredVersion} (from Anchor.toml)`));
            console.log(chalk.yellow(`  Current:  ${currentVersion}`));
            console.log(chalk.yellow(`\nSwitching to required version...`));

            // Run the appropriate version switch command
            const installCommand = clientType === 'agave'
                ? `agave-install init ${requiredVersion}`
                : `solana-install init ${requiredVersion}`;

            try {
                execSync(installCommand, { stdio: 'inherit' });
                console.log(chalk.green(`Successfully switched to Solana version ${requiredVersion}`));
            } catch (error) {
                console.error(chalk.red(`Failed to switch Solana version using ${installCommand}`));
                console.error(chalk.red(`Please run manually: ${installCommand}`));
                process.exit(1);
            }
        }
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            console.warn(chalk.yellow("Warning: Could not read Anchor.toml file"));
        } else {
            console.warn(chalk.yellow(`Warning: Failed to check Solana version: ${error instanceof Error ? error.message : error}`));
        }
    }
}

function checkAnchorVersion(pwd: string) {
    try {
        // Read required version from Anchor.toml
        const anchorToml = fs.readFileSync(`${pwd}/solana/Anchor.toml`, 'utf8');
        const versionMatch = anchorToml.match(/anchor_version = "(.+)"/);

        if (!versionMatch) {
            console.error(chalk.red("Error: Could not find anchor_version in Anchor.toml"));
            process.exit(1);
        }

        const expected = versionMatch[1];

        // Check if Anchor CLI is installed
        try {
            execSync("which anchor");
        } catch {
            console.error("Anchor CLI is not installed.\nSee https://www.anchor-lang.com/docs/installation")
            process.exit(1);
        }

        // Get current Anchor version
        const version = execSync("anchor --version").toString().trim();
        // version looks like "anchor-cli 0.14.0"
        const [_, v] = version.split(" ");
        if (v !== expected) {
            console.error(chalk.red(`Anchor CLI version mismatch!`));
            console.error(chalk.red(`  Required: ${expected} (from Anchor.toml)`));
            console.error(chalk.red(`  Current:  ${v}`));
            console.error(chalk.yellow(`\nTo fix this, install the correct version of Anchor`));
            console.error(chalk.gray("See https://www.anchor-lang.com/docs/installation"));
            process.exit(1);
        }
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            console.error(chalk.red("Error: Could not read Anchor.toml file"));
            console.error(chalk.yellow(`Expected file at: ${pwd}/solana/Anchor.toml`));
            process.exit(1);
        } else {
            throw error;
        }
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

function buildVerifierArgs(chain: Chain): string[] {
    const verifier = configuration.get(chain, "verifier", { reportError: true });
    const verifierType = verifier || "etherscan";

    if (verifierType === "blockscout") {
        const verifierUrl = configuration.get(chain, "verifier_url", { reportError: true });
        if (!verifierUrl) {
            console.error(`verifier_url is required when using blockscout verifier for ${chain}`);
            process.exit(1);
        }

        return ["--verify", "--verifier", "blockscout", "--verifier-url", verifierUrl];
    } else {
        const apiKey = configuration.get(chain, "scan_api_key", { reportError: true });
        if (!apiKey) {
            process.exit(1);
        }

        return ["--verify", "--etherscan-api-key", apiKey];
    }
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

async function checkSvmValidSplMultisig(
    connection: Connection,
    address: PublicKey,
    programId: PublicKey,
    tokenAuthority: PublicKey
): Promise<boolean> {
    let isMultisigTokenAuthority = false;
    try {
        const multisigInfo = await spl.getMultisig(
            connection,
            address,
            undefined,
            programId
        );
        if (multisigInfo.m === 1) {
            const n = multisigInfo.n;
            for (let i = 0; i < n; ++i) {
                // TODO: not sure if there's an easier way to loop through and check
                if (
                    (
                        multisigInfo[`signer${i + 1}` as keyof spl.Multisig] as PublicKey
                    ).equals(tokenAuthority)
                ) {
                    isMultisigTokenAuthority = true;
                    break;
                }
            }
        }
    } catch {}
    return isMultisigTokenAuthority;
}
