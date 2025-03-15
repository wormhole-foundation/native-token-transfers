import { assertChain, chains, type Chain } from "@wormhole-foundation/sdk";
import * as yargs from "yargs";
import fs from "fs";
import { ensureNttRoot } from ".";
import chalk from "chalk";

// We support project-local and global configuration.
// The configuration is stored in JSON files in $HOME/.ntt-cli/config.json (global) and .ntt-cli/config.json (local).
// These can further be overridden by environment variables of the form CHAIN_KEY=value.
type Scope = "global" | "local";

type Config = {
    chains: Partial<{
        [C in Chain]: ChainConfig;
    }>
}

type ChainConfig = Partial<typeof configTemplate>;

// TODO: per-network configuration? (i.e. mainnet, testnet, etc)
const configTemplate = {
    scan_api_key: "",
};

function assertChainConfigKey(key: string): asserts key is keyof ChainConfig {
    const validKeys = Object.keys(configTemplate);
    if (!validKeys.includes(key)) {
        throw new Error(`Invalid key: ${key}`);
    }
}

const options = {
    chain: {
        describe: "Chain",
        type: "string",
        choices: chains,
        demandOption: true,
    },
    key: {
        describe: "Key",
        type: "string",
        choices: Object.keys(configTemplate),
        demandOption: true,
    },
    value: {
        describe: "Value",
        type: "string",
        demandOption: true,
    },
    local: {
        describe: "Use local configuration",
        type: "boolean",
        default: false,
    },
    global: {
        describe: "Use global configuration",
        type: "boolean",
        default: true,
    }
} as const;
export const command = (args: yargs.Argv<{}>) => args
    .command("set-chain <chain> <key> <value>",
        "set a configuration value for a chain",
        (yargs) => yargs
            .positional("chain", options.chain)
            .positional("key", options.key)
            .positional("value", options.value)
            .option("local", options.local)
            .option("global", options.global),
        (argv) => {
            const scope = resolveScope(argv.local, argv.global);
            assertChain(argv.chain);
            assertChainConfigKey(argv.key);
            setChainConfig(scope, argv.chain, argv.key, argv.value);
        })
    .command("unset-chain <chain> <key>",
        "unset a configuration value for a chain",
        (yargs) => yargs
            .positional("chain", options.chain)
            .positional("key", options.key)
            .option("local", options.local)
            .option("global", options.global),
        (argv) => {
            const scope = resolveScope(argv.local, argv.global);
            assertChainConfigKey(argv.key);
            assertChain(argv.chain);
            setChainConfig(scope, argv.chain, argv.key, undefined);
        })
    .command("get-chain <chain> <key>",
        "get a configuration value",
        (yargs) => yargs
            .positional("chain", options.chain)
            .positional("key", options.key)
            .option("local", options.local)
            .option("global", options.global),
        (argv) => {
            const scope = resolveScope(argv.local, argv.global);
            assertChainConfigKey(argv.key);
            assertChain(argv.chain);
            const val = getChainConfig(argv.scope as Scope, argv.chain, argv.key);
            if (!val) {
                console.error("undefined");
            } else {
                console.log(val);
            }
        })
    .demandCommand()

function findOrCreateConfigFile(scope: Scope): string {
    // if scope is global, touch $HOME/.ntt-cli/config.json
    // if scope is local, touch .ntt-cli/config.json. In the latter case, make sure we're in an ntt project (call ensureNttRoot())

    // if the file doesn't exist, write an empty object
    let configDir;

    switch (scope) {
        case "global":
            if (!process.env.HOME) {
                throw new Error("Could not determine home directory");
            }
            configDir = `${process.env.HOME}/.ntt-cli`;
            break;
        case "local":
            ensureNttRoot();
            configDir = ".ntt-cli";
            break;
    }

    const emptyConfig: Config = {
        chains: {},
    };

    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir);
    }
    const configFile = `${configDir}/config.json`;
    if (!fs.existsSync(configFile)) {
        fs.writeFileSync(configFile, JSON.stringify(emptyConfig, null, 2));
    }
    return configFile;
}

function setChainConfig(scope: Scope, chain: Chain, key: keyof ChainConfig, value: string | undefined) {
    const configFile = findOrCreateConfigFile(scope);
    const config = JSON.parse(fs.readFileSync(configFile, "utf-8")) as Config;
    if (!config.chains[chain]) {
        config.chains[chain] = {};
    }
    config.chains[chain]![key] = value;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}

function getChainConfig(scope: Scope, chain: Chain, key: keyof ChainConfig): string | undefined {
    const configFile = findOrCreateConfigFile(scope);
    const config = JSON.parse(fs.readFileSync(configFile, "utf-8")) as Config;
    return config.chains[chain]?.[key];
}

function envVarName(chain: Chain, key: keyof ChainConfig): string {
    return `${chain.toUpperCase()}_${key.toUpperCase()}`;
}

export function get(
    chain: Chain,
    key: keyof ChainConfig,
    { reportError = false }
): string | undefined {
    const varName = envVarName(chain, key);
    const env = process.env[varName];
    if (env) {
        console.info(chalk.yellow(`Using ${varName} for ${chain} ${key}`));
        return env;
    }
    const local = getChainConfig("local", chain, key);
    if (local) {
        console.info(chalk.yellow(`Using local configuration for ${chain} ${key} (in .ntt-cli/config.json)`));
        return local;
    }
    const global = getChainConfig("global", chain, key);
    if (global) {
        console.info(chalk.yellow(`Using global configuration for ${chain} ${key} (in $HOME/.ntt-cli/config.json)`));
        return global;
    }
    if (reportError) {
        console.error(`Could not find configuration for ${chain} ${key}`);
        console.error(`Please set it using 'ntt config set-chain ${chain} ${key} <value>' or by setting the environment variable ${varName}`);
    }
}
function resolveScope(local: boolean, global: boolean) {
    if (local && global) {
        throw new Error("Cannot specify both --local and --global");
    }
    if (local) {
        return "local";
    }
    if (global) {
        return "global";
    }
    throw new Error("Must specify either --local or --global");
}
