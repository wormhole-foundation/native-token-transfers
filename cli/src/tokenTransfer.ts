// NOTE: We rely on the Wormhole TypeScript SDK for cross-chain execution logic:
// https://github.com/wormhole-foundation/wormhole-sdk-ts

import chalk from "chalk";
import type { Argv, CommandModule } from "yargs";
import {
  Wormhole,
  amount,
  assertChain,
  canonicalAddress,
  chainToPlatform,
  chains,
  isNetwork,
  networks,
  routes,
} from "@wormhole-foundation/sdk";
import type {
  Chain,
  ChainContext,
  Network,
  Platform,
  TokenId,
  TransactionId,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk";
import type { QuoteWarning } from "@wormhole-foundation/sdk-connect";
import evm from "@wormhole-foundation/sdk/platforms/evm";
import solana from "@wormhole-foundation/sdk/platforms/solana";
import sui from "@wormhole-foundation/sdk/platforms/sui";
import { getSigner, type SignerStuff } from "./getSigner";
import { handleRpcError } from "./error";
import {
  NttExecutorRoute,
  NttRoute,
  nttExecutorRoute,
} from "@wormhole-foundation/sdk-route-ntt";
import type { Ntt, NttWithExecutor } from "@wormhole-foundation/sdk-definitions-ntt";
import "@wormhole-foundation/sdk-evm-ntt";
import "@wormhole-foundation/sdk-solana-ntt";
import "@wormhole-foundation/sdk-sui-ntt";
import { loadConfig, type ChainConfig, type Config } from "./deployments";
import fs from "fs";

type TokenTransferArgs = {
  network: string;
  "source-chain": Chain;
  "destination-chain": Chain;
  token?: string;
  amount: string;
  "source-key"?: string;
  "destination-key"?: string;
  "deployment-path"?: string;
  timeout?: number;
  rpc?: string[];
};

/**
 * Platforms that currently have stable token bridge support through the CLI.
 */
const SUPPORTED_PLATFORMS: ReadonlySet<Platform> = new Set([
  "Evm",
  "Solana",
  "Sui",
]);

const DEFAULT_SOLANA_MSG_VALUE = 11_500_000n; // lamports

/**
 * Registers the `token-transfer` command and all associated validation / execution logic.
 */
export function createTokenTransferCommand(
  overrides: WormholeConfigOverrides<Network>
): CommandModule<Record<string, unknown>, TokenTransferArgs> {
  return {
    command: "token-transfer",
    describe:
      "Transfer tokens between chains using the Native Token Transfers (NTT) protocol",
    builder: (yargs): Argv<TokenTransferArgs> =>
      yargs
        .option("network", {
          alias: "n",
          describe: "Network to use",
          choices: networks,
          demandOption: true,
        })
        .option("source-chain", {
          describe: "Source chain",
          choices: chains,
          demandOption: true,
        })
        .option("destination-chain", {
          describe: "Destination chain",
          choices: chains,
          demandOption: true,
        })
        .option("token", {
          describe:
            "Optional token address on the source chain (validated against the deployment file)",
          type: "string",
          demandOption: false,
        })
        .option("amount", {
          describe: "Human-readable token amount to transfer",
          type: "string",
          demandOption: true,
        })
        .option("source-key", {
          describe:
            "Private key or path to key file for the source chain (otherwise env vars are used)",
          type: "string",
        })
        .option("destination-key", {
          describe:
            "Private key or path to key file for the destination chain (otherwise env vars are used)",
          type: "string",
        })
        .option("deployment-path", {
          alias: "p",
          describe: "Path to the deployment file produced by the CLI",
          type: "string",
          demandOption: true,
        })
        .option("destination-msg-value", {
          describe:
            "Override msgValue (native units) for the destination chain. Required when destination is Solana/SVM to cover executor rent.",
          type: "string",
        })
        .option("rpc", {
          describe:
            "Override RPC endpoints (format: Chain=URL). Repeat --rpc for multiple chains.",
          type: "string",
          array: true,
        })
        .option("timeout", {
          describe: "Attestation wait timeout in seconds",
          type: "number",
        })
        .check((argv) => {
          if (argv["source-chain"] === argv["destination-chain"]) {
            throw new Error(
              "source-chain and destination-chain must be different"
            );
          }
          return true;
        })
        .example(
          "$0 token-transfer --network Testnet --source-chain Sepolia --destination-chain Solana --amount 1.25 --deployment-path ./deployment.json",
          "Transfer 1.25 tokens between Sepolia and Solana using the deployments listed in deployment.json"
        )
        .example(
          "$0 token-transfer -n Testnet --source-chain Solana --destination-chain Sepolia --amount 0.1 --deployment-path ./deployment.json",
          "Transfer 0.1 tokens from Solana to Sepolia with deployments described in deployment.json"
        )
        .example(
          "$0 token-transfer --network Testnet --source-chain Solana --destination-chain Sepolia --token 4zMMC9... --amount 0.1 --deployment-path ./deployment.json --rpc Solana=https://api.devnet.solana.com",
          "Override the Solana RPC endpoint for this run"
        )
        .strict() as Argv<TokenTransferArgs>,
    handler: async (argv) => {
      const networkInput = argv.network;
      if (!isNetwork(networkInput)) {
        console.error(chalk.red(`Invalid network: ${networkInput}`));
        process.exit(1);
      }
      const network = networkInput;

      const sourceChainInput = argv["source-chain"];
      assertChain(sourceChainInput);
      const destinationChainInput = argv["destination-chain"];
      assertChain(destinationChainInput);

      ensurePlatformSupported(sourceChainInput);
      ensurePlatformSupported(destinationChainInput);

      const amountInput = argv.amount.trim();
      if (!amountInput) {
        console.error(chalk.red("Amount must not be empty"));
        process.exit(1);
      }
      const tokenInput = argv.token?.trim();
      const destinationMsgValueArg = argv["destination-msg-value"];
      let destinationMsgValueOverride: bigint | undefined;
      if (destinationMsgValueArg !== undefined) {
        if (Array.isArray(destinationMsgValueArg)) {
          console.error(
            chalk.red("--destination-msg-value may only be specified once")
          );
          process.exit(1);
        }
        if (destinationMsgValueArg === null) {
          console.error(
            chalk.red("--destination-msg-value must be a positive integer")
          );
          process.exit(1);
        }
        if (typeof destinationMsgValueArg !== "string") {
          console.error(
            chalk.red("--destination-msg-value must be provided as a string")
          );
          process.exit(1);
        }
        const trimmed = destinationMsgValueArg.trim();
        if (trimmed.length === 0) {
          console.error(
            chalk.red("--destination-msg-value must be a positive integer")
          );
          process.exit(1);
        }
        try {
          destinationMsgValueOverride = BigInt(trimmed);
        } catch {
          console.error(
            chalk.red(
              "--destination-msg-value must be a valid integer (lamports / native units)"
            )
          );
          process.exit(1);
        }
        if (destinationMsgValueOverride <= 0n) {
          console.error(
            chalk.red("--destination-msg-value must be greater than zero")
          );
          process.exit(1);
        }
      }

      const sourceKey = argv["source-key"]?.trim();
      const destinationKey = argv["destination-key"]?.trim();
      const rpcRaw = argv["rpc"];
      const rpcArgs = Array.isArray(rpcRaw)
        ? rpcRaw
        : rpcRaw
          ? [rpcRaw]
          : undefined;

      // Reject empty override slots such as `--rpc` or `--rpc ""`
      if (
        rpcArgs &&
        (rpcArgs.length === 0 ||
          rpcArgs.some(
            (value) => typeof value !== "string" || value.trim().length === 0
          ))
      ) {
        console.error(
          chalk.red(
            "--rpc expects values in the form Chain=URL. Remove the flag or provide a valid endpoint."
          )
        );
        process.exit(1);
      }

      // Users sometimes repeat flags; yargs returns an array in that case. Treat it as invalid.
      if (
        Object.prototype.hasOwnProperty.call(argv, "timeout") &&
        (argv.timeout === undefined ||
          argv.timeout === null ||
          Array.isArray(argv.timeout))
      ) {
        console.error(
          chalk.red(
            "--timeout expects a numeric value in seconds. Remove the flag or provide a valid number."
          )
        );
        process.exit(1);
      }

      if (
        typeof argv.timeout === "number" &&
        (Number.isNaN(argv.timeout) || argv.timeout <= 0)
      ) {
        console.error(
          chalk.red("--timeout must be a positive number of seconds.")
        );
        process.exit(1);
      }

      const timeoutSeconds = argv.timeout ?? 1200;
      const timeoutMs = Math.max(1, Math.floor(timeoutSeconds)) * 1000;

      const deploymentPathArg = argv["deployment-path"];
      if (
        typeof deploymentPathArg !== "string" ||
        deploymentPathArg.trim().length === 0
      ) {
        console.error(
          chalk.red("--deployment-path must point to a deployment file.")
        );
        process.exit(1);
      }
      const deploymentPath = deploymentPathArg.trim();

      const deployments = loadConfig(deploymentPath);
      const configuredChainEntries = Object.entries(deployments.chains).filter(
        (entry): entry is [string, ChainConfig] => entry[1] !== undefined
      );
      const configuredChains = configuredChainEntries.map(([chain]) => chain as Chain);

      if (configuredChains.length === 0) {
        console.error(
          chalk.red(
            `Deployment file ${deploymentPath} does not contain any configured chains.`
          )
        );
        process.exit(1);
      }

      if (deployments.network !== network) {
        console.error(
          chalk.red(
            `Deployment file ${deploymentPath} targets ${deployments.network}, but --network was set to ${network}.`
          )
        );
        process.exit(1);
      }

      const sourceDeployment = deployments.chains[sourceChainInput];
      if (!sourceDeployment) {
        console.error(
          chalk.red(
            `Chain ${sourceChainInput} is not present in ${deploymentPath}. Available chains: ${configuredChains.join(", ")}`
          )
        );
        process.exit(1);
      }

      const destinationDeployment = deployments.chains[destinationChainInput];
      if (!destinationDeployment) {
        console.error(
          chalk.red(
            `Chain ${destinationChainInput} is not present in ${deploymentPath}. Available chains: ${configuredChains.join(", ")}`
          )
        );
        process.exit(1);
      }

      if (
        tokenInput &&
        !tokenAddressesMatch(tokenInput, sourceDeployment.token, sourceChainInput)
      ) {
        console.error(
          chalk.red(
            `Token ${tokenInput} does not match the deployment token ${sourceDeployment.token} for ${sourceChainInput}.`
          )
        );
        process.exit(1);
      }

      let tokenId: TokenId;
      let destinationTokenId: TokenId;
      try {
        tokenId = Wormhole.tokenId(sourceChainInput, sourceDeployment.token);
        destinationTokenId = Wormhole.tokenId(
          destinationChainInput,
          destinationDeployment.token
        );
      } catch (error) {
        fail("Failed to parse token identifiers from deployment file", error);
      }

      const involvedChains = new Set<Chain>([
        sourceChainInput,
        destinationChainInput,
      ]);
      const runtimeOverrides = applyRpcOverrides(
        overrides,
        rpcArgs as string[] | undefined,
        involvedChains
      );

      const wh = new Wormhole(
        network,
        [evm.Platform, solana.Platform, sui.Platform],
        runtimeOverrides
      );

      ensureChainSupported(wh, sourceChainInput, "source");
      ensureChainSupported(wh, destinationChainInput, "destination");

      let sourceCtx: ChainContext<Network, Chain>;
      let destinationCtx: ChainContext<Network, Chain>;
      try {
        sourceCtx = wh.getChain(sourceChainInput);
      } catch (error) {
        fail(
          `Failed to load configuration for source chain ${sourceChainInput}`,
          error
        );
      }
      try {
        destinationCtx = wh.getChain(destinationChainInput);
      } catch (error) {
        fail(
          `Failed to load configuration for destination chain ${destinationChainInput}`,
          error
        );
      }

      const { key: normalizedSourceKey, file: normalizedSourceFile } =
        resolveSignerInput(sourceCtx.chain, sourceKey);
      const { key: normalizedDestinationKey, file: normalizedDestinationFile } =
        resolveSignerInput(destinationCtx.chain, destinationKey);

      const sourceSigner = await getSignerSafe(
        sourceCtx,
        normalizedSourceKey,
        normalizedSourceFile
      );
      const destinationSigner = await getSignerSafe(
        destinationCtx,
        normalizedDestinationKey,
        normalizedDestinationFile
      );

      const decimals = await resolveTokenDecimals(
        wh,
        tokenId,
        sourceCtx,
        network
      );

      let transferAmount: bigint;
      try {
        transferAmount = amount.units(amount.parse(amountInput, decimals));
      } catch (error) {
        fail(
          `Invalid amount "${amountInput}" for token with ${decimals} decimals`,
          error
        );
      }

      if (transferAmount <= 0n) {
        console.error(
          chalk.red("Amount must be greater than zero after conversion")
        );
        process.exit(1);
      }

      let sourceBalanceRaw: bigint | null;
      try {
        sourceBalanceRaw = await sourceCtx.getBalance(
          sourceSigner.signer.address(),
          tokenId.address
        );
      } catch (error) {
        fail(
          `Failed to fetch balance on ${sourceChainInput}`,
          error,
          sourceCtx,
          network
        );
      }

      if (sourceBalanceRaw === null) {
        console.error(
          chalk.red(`Unable to fetch balance on ${sourceChainInput}`)
        );
        process.exit(1);
      }

      const sourceBalance = sourceBalanceRaw;

      if (sourceBalance < transferAmount) {
        const available = formatAmount(sourceBalance, decimals);
        const required = formatAmount(transferAmount, decimals);
        console.error(
          chalk.red(
            `Insufficient balance on ${sourceChainInput}. Required ${required}, available ${available}`
          )
        );
        process.exit(1);
      }

      let contractsByChain: Map<Chain, Ntt.Contracts>;
      try {
        contractsByChain = buildContractsByChain(deployments.chains, deploymentPath);
      } catch (error) {
        fail(
          error instanceof Error ? error.message : String(error),
          error
        );
      }

      getContractsForChain(contractsByChain, sourceChainInput, deploymentPath);
      getContractsForChain(contractsByChain, destinationChainInput, deploymentPath);

      const executorConfig = buildExecutorRouteConfig(contractsByChain);
      const destinationPlatform = chainToPlatform(destinationChainInput);
      if (destinationPlatform === "Solana") {
        const msgValueToUse =
          destinationMsgValueOverride ?? DEFAULT_SOLANA_MSG_VALUE;
        applyMsgValueOverride(executorConfig, destinationTokenId, msgValueToUse);
        if (destinationMsgValueOverride === undefined) {
          console.warn(
            chalk.yellow(
              `Destination ${destinationChainInput} requires msgValue funding for the Wormhole Executor. Using default ${msgValueToUse.toString()} lamports. Pass --destination-msg-value to override.`
            )
          );
        } else {
          console.log(
            `Using custom msgValue ${destinationMsgValueOverride.toString()} for ${destinationChainInput}.`
          );
        }
      } else if (destinationMsgValueOverride !== undefined) {
        console.warn(
          chalk.yellow(
            `--destination-msg-value is only required for SVM destinations. Ignoring override for ${destinationChainInput}.`
          )
        );
      }
      const ExecutorRoute = nttExecutorRoute(executorConfig);
      const routeInstance = new ExecutorRoute(wh);

      const transferRequest = await routes.RouteTransferRequest.create(wh, {
        source: tokenId,
        destination: destinationTokenId,
      });

      const validation = await routeInstance.validate(transferRequest, {
        amount: amountInput,
      });
      if (!validation.valid) {
        const reason =
          validation.error instanceof Error
            ? validation.error.message
            : "Unknown validation error";
        console.error(chalk.red(`Transfer validation failed: ${reason}`));
        process.exit(1);
      }
      const validatedParams =
        validation.params as NttExecutorRoute.ValidatedParams;

      let quoteResult;
      try {
        quoteResult = await routeInstance.quote(
          transferRequest,
          validatedParams
        );
      } catch (error) {
        fail(
          `Failed to fetch execution quote between ${sourceChainInput} and ${destinationChainInput}`,
          error,
          sourceCtx,
          network
        );
      }

      if (!quoteResult.success) {
        fail(
          `Failed to fetch execution quote between ${sourceChainInput} and ${destinationChainInput}`,
          quoteResult.error,
          sourceCtx,
          network
        );
      }

      const executorQuote = quoteResult.details as NttWithExecutor.Quote | undefined;
      if (!executorQuote) {
        fail(
          "Executor quote did not include relay details",
          new Error("Missing executor quote details")
        );
      }

      if (quoteResult.warnings?.length) {
        for (const warning of quoteResult.warnings) {
          console.warn(chalk.yellow(formatQuoteWarning(warning)));
        }
      }

      const estimatedDestinationAmount = amount.display(
        quoteResult.destinationToken.amount
      );
      console.log(
        `Transferring ${formatAmount(transferAmount, decimals)} tokens from ${sourceChainInput} to ${destinationChainInput} (${network})`
      );
      console.log(
        `Source address: ${chalk.cyan(sourceSigner.address.address.toString())}`
      );
      console.log(
        `Destination address: ${chalk.cyan(
          destinationSigner.address.address.toString()
        )}`
      );
      console.log(
        `Source token: ${chalk.cyan(
          sourceDeployment.token
        )} (decimals: ${decimals.toString()})`
      );
      console.log(
        `Destination token: ${chalk.cyan(destinationDeployment.token)}`
      );
      console.log(
        `Estimated destination amount: ${estimatedDestinationAmount}`
      );
      if (quoteResult.relayFee) {
        console.log(
          `Estimated relay fee (${quoteResult.relayFee.token.chain} native): ${amount.display(
            quoteResult.relayFee.amount
          )}`
        );
      }
      if (quoteResult.destinationNativeGas) {
        console.log(
          `Estimated destination native gas drop-off: ${amount.display(
            quoteResult.destinationNativeGas
          )}`
        );
      }
      console.log(
        `Executor referrer fee: ${formatAmount(
          executorQuote.referrerFee,
          decimals
        )} (${executorQuote.referrerFeeDbps.toString()} dBps)`
      );
      console.log(
        `Estimated execution cost (${sourceChainInput} native): ${formatAmount(
          executorQuote.estimatedCost,
          sourceCtx.config.nativeTokenDecimals
        )}`
      );
      if (executorQuote.gasDropOff > 0n) {
        console.log(
          `Destination gas drop-off (${destinationChainInput} native): ${formatAmount(
            executorQuote.gasDropOff,
            destinationCtx.config.nativeTokenDecimals
          )}`
        );
      }
      const expiresAt = quoteResult.expires ?? executorQuote.expires;
      if (expiresAt) {
        console.log(`Quote expires at ${expiresAt.toISOString()}`);
      }
      if (quoteResult.provider) {
        console.log(`Route provider: ${quoteResult.provider}`);
      }
      if (quoteResult.eta) {
        console.log(`Estimated relay ETA: ${quoteResult.eta} seconds`);
      }

      console.log(`Submitting transfer on ${sourceChainInput}...`);
      let receipt: NttExecutorRoute.TransferReceipt;
      try {
        receipt = (await routeInstance.initiate(
          transferRequest,
          sourceSigner.signer,
          quoteResult,
          destinationSigner.address
        )) as NttExecutorRoute.TransferReceipt;
      } catch (error) {
        fail(
          `Failed to submit transfer transaction on ${sourceChainInput}`,
          error,
          sourceCtx,
          network
        );
      }

      const originTxs =
        "originTxs" in receipt && Array.isArray(receipt.originTxs)
          ? (receipt.originTxs as TransactionId[])
          : [];
      if (originTxs.length > 0) {
        originTxs.forEach((tx: TransactionId, index: number) => {
          const label =
            index === 0
              ? "Source transaction"
              : `Source transaction #${index + 1}`;
          console.log(`${label}: ${chalk.cyan(tx.txid.toString())}`);
        });
      }

      const sourceTxId = originTxs.at(-1)?.txid;
      if (sourceTxId) {
        console.log(
          `Waiting for attestation (timeout ${Math.floor(timeoutMs / 1000)} seconds)...`
        );
        try {
        const vaa = await withRetryStatus(
          /Retrying Wormholescan/i,
          async () =>
            wh.getVaa(sourceTxId, "Ntt:WormholeTransfer", timeoutMs)
        );
          if (vaa) {
            console.log(
              `Attestation sequence: ${chalk.cyan(vaa.sequence.toString())}`
            );
          }
        } catch (error) {
          if (isLikelyRpcError(error)) {
            console.error(
              chalk.red(
                `Failed while waiting for attestation. Verify Wormhole RPC endpoints are reachable.`
              )
            );
            console.error(stringifyError(error));
            process.exit(1);
          }
          fail("Failed while waiting for attestation", error);
        }
        const wormholeScanUrl = `https://wormholescan.io/#/tx/${sourceTxId}?network=${network}`;
        console.log(`WormholeScan URL: ${wormholeScanUrl}`);
      }

      console.log(
        chalk.green(
          "Transfer submitted. The Wormhole Executor will relay the transfer automatically once finalized."
        )
      );
      console.log(
        "Track progress via Wormholescan or by rerunning this command to fetch status."
      );

    },
  };
}

function buildContractsByChain(
  chainsConfig: Config["chains"],
  deploymentPath: string
): Map<Chain, Ntt.Contracts> {
  const contracts = new Map<Chain, Ntt.Contracts>();
  for (const [chainName, cfg] of Object.entries(chainsConfig)) {
    if (!cfg) {
      continue;
    }
    let chain: Chain;
    try {
      assertChain(chainName as Chain);
      chain = chainName as Chain;
    } catch {
      continue;
    }
    const wormholeTransceiver = cfg.transceivers?.wormhole?.address;
    if (!wormholeTransceiver) {
      throw new Error(
        `Deployment file ${deploymentPath} is missing the wormhole transceiver address for ${chain}.`
      );
    }
    contracts.set(chain, {
      token: cfg.token,
      manager: cfg.manager,
      transceiver: {
        wormhole: wormholeTransceiver,
      },
    });
  }
  if (contracts.size === 0) {
    throw new Error(
      `Deployment file ${deploymentPath} does not define any chains with Wormhole transceivers.`
    );
  }
  return contracts;
}

function getContractsForChain(
  map: Map<Chain, Ntt.Contracts>,
  chain: Chain,
  deploymentPath: string
): Ntt.Contracts {
  const entry = map.get(chain);
  if (!entry) {
    throw new Error(
      `Chain ${chain} is not configured with Wormhole transceiver data in ${deploymentPath}.`
    );
  }
  return entry;
}

function buildExecutorRouteConfig(
  contracts: Map<Chain, Ntt.Contracts>
): NttExecutorRoute.Config {
  const tokenEntries = Array.from(contracts.entries()).map(
    ([chain, contract]) => ({
      chain,
      token: contract.token,
      manager: contract.manager,
      transceiver: Object.entries(contract.transceiver).map(
        ([type, address]) => ({
          type: type as NttRoute.TransceiverType,
          address,
        })
      ),
    })
  );
  if (tokenEntries.length === 0) {
    throw new Error("Unable to build executor config without token entries.");
  }
  const tokenGroupKey = "ntt-deployment-token";
  return {
    ntt: {
      tokens: {
        [tokenGroupKey]: tokenEntries,
      },
    },
  };
}

type ReferrerFeeConfig = NonNullable<NttExecutorRoute.Config["referrerFee"]>;
type PerTokenOverrides = NonNullable<
  NonNullable<ReferrerFeeConfig["perTokenOverrides"]>[Chain]
>;

function applyMsgValueOverride(
  config: NttExecutorRoute.Config,
  token: TokenId,
  msgValue: bigint
): void {
  if (!config.referrerFee) {
    config.referrerFee = { feeDbps: 0n, perTokenOverrides: {} };
  } else if (!config.referrerFee.perTokenOverrides) {
    config.referrerFee.perTokenOverrides = {};
  }
  const perTokenOverrides =
    (config.referrerFee.perTokenOverrides ??=
      {} as NonNullable<ReferrerFeeConfig["perTokenOverrides"]>);
  const canonicalToken = canonicalAddress(token);
  const chainOverrides = (perTokenOverrides[token.chain] ??=
    {} as PerTokenOverrides);
  const tokenOverride = (chainOverrides[canonicalToken] ??= {});
  tokenOverride.msgValue = msgValue;
}

function tokenAddressesMatch(input: string, actual: string, chain: Chain): boolean {
  const platform = chainToPlatform(chain);
  if (platform === "Evm" || platform === "Sui") {
    return input.toLowerCase() === actual.toLowerCase();
  }
  return input === actual;
}

function formatQuoteWarning(warning: QuoteWarning): string {
  switch (warning.type) {
    case "DestinationCapacityWarning":
      if (warning.delayDurationSec) {
        return `Destination is capacity constrained; expected delay ${warning.delayDurationSec} seconds.`;
      }
      return "Destination is currently capacity constrained; transfer may be delayed.";
    case "GovernorLimitWarning":
      return `Transfer may violate governor limits (${warning.reason}).`;
    default:
      return "Transfer warning received.";
  }
}

/**
 * Validate the CLI supports the platform hosting the given chain.
 * Exits early with a helpful message if not.
 */
function ensurePlatformSupported(chain: Chain): void {
  const platform = chainToPlatform(chain);
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    console.error(
      chalk.red(
        `Chain ${chain} (platform ${platform}) is not supported by token-transfer`
      )
    );
    process.exit(1);
  }
}

/**
 * Determine the decimals for the token we are about to move.
 */
async function resolveTokenDecimals(
  wh: Wormhole<Network>,
  token: TokenId,
  ctx: ChainContext<Network, Chain>,
  network: Network
): Promise<number> {
  try {
    if (token.address === "native") {
      return ctx.config.nativeTokenDecimals;
    }
    const decimals = await wh.getDecimals(token.chain, token.address);
    return Number(decimals);
  } catch (error) {
    fail(
      `Failed to fetch token decimals for ${token.address} on ${token.chain}`,
      error,
      ctx,
      network
    );
  }
}

async function getSignerSafe<N extends Network, C extends Chain>(
  ctx: ChainContext<N, C>,
  source?: string,
  filePath?: string
): Promise<SignerStuff<N, C>> {
  try {
    return await getSigner(ctx, "privateKey", source, filePath);
  } catch (error) {
    if (isLikelyRpcError(error)) {
      console.error(
        chalk.red(
          `Unable to reach RPC endpoint for ${ctx.chain}. Ensure the RPC is reachable or override it with --rpc ${ctx.chain}=<url>.`
        )
      );
      console.error(stringifyError(error));
      process.exit(1);
    }

    const guidance = buildSignerGuidance(ctx.chain);
    fail(
      [
        `Failed to load signer for ${ctx.chain}. Ensure the correct private key is provided.`,
        guidance,
      ].join("\n"),
      error
    );
  }
}

/** Format a bigint amount into a human friendly string. */
function formatAmount(value: bigint, decimals: number): string {
  return amount.display(
    amount.fromBaseUnits(value, decimals),
    Math.min(decimals, 8)
  );
}

/** Coerce unknown errors into printable strings. */
function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Shared exit helper that prints a message and terminates the process.
 */
function fail(
  prefix: string,
  error: unknown,
  ctx?: ChainContext<Network, Chain>,
  network?: Network
): never {
  if (ctx && network && isLikelyRpcError(error)) {
    handleRpcError(error, ctx.chain, network, ctx.config.rpc);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red(prefix));
  console.error(message);
  process.exit(1);
}

/**
 * Best-effort detection of transport-level RPC issues.
 */
function isLikelyRpcError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as any).message)
        : "";
  const stack =
    error instanceof Error
      ? (error.stack ?? "")
      : typeof error === "object" && error !== null && "stack" in error
        ? String((error as any).stack)
        : "";
  const haystack = `${message} ${stack}`.toLowerCase();
  return (
    haystack.includes("jsonrpc") ||
    haystack.includes("network error") ||
    haystack.includes("rpc") ||
    haystack.includes("connection") ||
    haystack.includes("unable to connect") ||
    haystack.includes("404 not found") ||
    haystack.includes("status code: 404") ||
    haystack.includes("status code") ||
    haystack.includes("not found") ||
    haystack.includes("could not connect") ||
    haystack.includes("failed to fetch") ||
    haystack.includes("connect to")
  );
}

/** Provide user facing guidance for resolving signer input issues. */
function buildSignerGuidance(chain: Chain): string {
  const platform = chainToPlatform(chain);
  switch (platform) {
    case "Evm":
      return [
        "Provide an EVM private key using one of:",
        "  • Export ETH_PRIVATE_KEY in your environment",
        "  • Pass --source-key / --destination-key with the hex-encoded key or a path to a file containing it",
      ].join("\n");
    case "Solana":
      return [
        "Provide a Solana signer using one of:",
        "  • Export SOLANA_PRIVATE_KEY (base58) in your environment",
        "  • Pass --source-key / --destination-key with the base58 secret or a path to the keypair JSON",
      ].join("\n");
    case "Sui":
      return [
        "Provide a Sui private key using one of:",
        "  • Export SUI_PRIVATE_KEY in your environment",
        "  • Pass --source-key / --destination-key with the Base64-encoded key or a path to a file containing it",
      ].join("\n");
    default:
      return "Provide the appropriate private key for this platform.";
  }
}

/**
 * Normalize CLI signer inputs, supporting either inline secrets or paths.
 */
function resolveSignerInput(
  chain: Chain,
  raw?: string
): { key?: string; file?: string } {
  if (!raw) {
    return { key: undefined, file: undefined };
  }

  const platform = chainToPlatform(chain);
  if (fs.existsSync(raw)) {
    if (platform === "Solana") {
      return { file: raw };
    }
    const keyFromFile = fs.readFileSync(raw, "utf8").trim();
    return { key: keyFromFile };
  }

  if (platform === "Solana") {
    const base58Pattern = /^[1-9A-HJ-NP-Za-km-z]{32,}$/;
    if (base58Pattern.test(raw)) {
      return { key: raw };
    }
  }

  return { key: raw };
}

function applyRpcOverrides<N extends Network>(
  base: WormholeConfigOverrides<N>,
  rpcArgs: string[] | undefined,
  allowedChains: Set<Chain>
): WormholeConfigOverrides<N> {
  if (!rpcArgs || rpcArgs.length === 0) {
    return base;
  }

  const cloned = JSON.parse(
    JSON.stringify(base ?? {})
  ) as WormholeConfigOverrides<N>;
  const chainsOverrides = (cloned.chains ?? {}) as NonNullable<
    typeof cloned.chains
  >;
  cloned.chains = chainsOverrides;

  for (const arg of rpcArgs) {
    if (typeof arg !== "string") {
      continue;
    }
    const [chainRaw, ...rest] = arg.split("=");
    const chainName = chainRaw?.trim();
    const rpc = rest.join("=").trim();
    if (!chainName || !rpc) {
      console.error(
        chalk.red(`Invalid --rpc value "${arg}". Expected format Chain=URL.`)
      );
      process.exit(1);
    }
    try {
      assertChain(chainName as Chain);
    } catch {
      console.error(
        chalk.red(`Invalid chain name "${chainName}" provided to --rpc.`)
      );
      process.exit(1);
    }
    const chain = chainName as Chain;
    if (!allowedChains.has(chain)) {
      console.warn(
        chalk.yellow(
          `Warning: RPC override provided for ${chain}, which is not part of this transfer.`
        )
      );
    }
    if (!chainsOverrides[chain]) {
      (chainsOverrides as any)[chain] = {};
    }
    (chainsOverrides as any)[chain].rpc = rpc;
  }

  return cloned;
}

async function withRetryStatus<T>(
  needle: string | RegExp,
  fn: () => Promise<T>
): Promise<T> {
  const originalLog = console.log;
  let lastMessageLength = 0;
  let lastMessage = "";
  let sawNeedle = false;
  const spinnerFrames = [". ", ": ", ":.", "::"];
  let spinnerIndex = 0;

  const matchesNeedle = (message: string): boolean => {
    if (typeof needle === "string") {
      return message.includes(needle);
    }
    const regex = needle;
    const result = regex.test(message);
    if (regex.global) {
      regex.lastIndex = 0;
    }
    return result;
  };

  console.log = (...args: any[]) => {
    const message = args.map(String).join(" ");
    if (matchesNeedle(message)) {
      sawNeedle = true;
      const spinner =
        "[" +
        spinnerFrames[spinnerIndex++ % spinnerFrames.length].padEnd(2, " ") +
        "]";
      const display = `${spinner} ${message}`;
      if (process.stdout.isTTY) {
        const padded =
          display +
          (lastMessageLength > display.length
            ? " ".repeat(lastMessageLength - display.length)
            : "");
        process.stdout.write(`\r${padded}`);
        lastMessageLength = display.length;
      } else {
        lastMessage = display;
      }
      return;
    }
    originalLog(...args);
  };

  try {
    const result = await fn();
    if (sawNeedle && process.stdout.isTTY) {
      process.stdout.write("\n");
    } else if (sawNeedle && lastMessage && !process.stdout.isTTY) {
      originalLog(lastMessage);
    }
    return result;
  } finally {
    console.log = originalLog;
  }
}

function ensureChainSupported<N extends Network>(
  wh: Wormhole<N>,
  chain: Chain,
  role: "source" | "destination"
): void {
  const entry = wh.config.chains?.[chain];
  if (entry && entry.rpc) {
    return;
  }
  console.error(
    chalk.red(
      `Chain ${chain} is not available on ${wh.network}. Ensure you select a network that supports this ${role} chain.`
    )
  );
  process.exit(1);
}
