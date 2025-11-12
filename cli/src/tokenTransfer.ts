// NOTE: We rely on the Wormhole TypeScript SDK for cross-chain execution logic:
// https://github.com/wormhole-foundation/wormhole-sdk-ts

import chalk from "chalk";
import ora, { type Ora } from "ora";
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
  ChainAddress,
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
import { logRpcError } from "./error";
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
import readline from "readline";

type TokenTransferArgs = {
  network: string;
  "source-chain": Chain;
  "destination-chain": Chain;
  amount: string;
  "destination-address": string;
  "destination-msg-value"?: string;
  payer?: string;
  "deployment-path"?: string;
  timeout?: number;
  rpc?: string[];
};

class TokenTransferError extends Error {
  override cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "TokenTransferError";
    this.cause = options?.cause;
  }
}

/**
 * Platforms that currently have stable NTT support through the CLI.
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
        .option("destination-address", {
          describe:
            "Destination wallet address in canonical format.",
          type: "string",
          demandOption: true,
        })
        .option("amount", {
          describe: "Human-readable token amount to transfer",
          type: "string",
          demandOption: true,
        })
        .option("payer", {
          describe:
            "Path to the Solana payer keypair JSON (required when Solana is the source unless SOLANA_PRIVATE_KEY is set).",
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
          "$0 token-transfer --network Testnet --source-chain Sepolia --destination-chain Solana --amount 1.25 --destination-address Ez6j... --p ./deployment.json",
          "Transfer 1.25 tokens between Sepolia and Solana using the deployments listed in deployment.json"
        )
        .example(
          "$0 token-transfer -n Testnet --source-chain Solana --destination-chain Sepolia --amount 0.1 --destination-address 0xabc... --p ./deployment.json",
          "Transfer 0.1 tokens from Solana to Sepolia with deployments described in deployment.json"
        )
        .example(
          "$0 token-transfer --network Testnet --source-chain Solana --destination-chain Sepolia --amount 0.1 --destination-address 0xabc... --p ./deployment.json --rpc Solana=https://api.devnet.solana.com",
          "Override the Solana RPC endpoint for this run"
        )
        .strict() as Argv<TokenTransferArgs>,
    handler: async (argv) => {
      try {
        await executeTokenTransfer(argv, overrides);
      } catch (error) {
        reportTokenTransferError(error);
        process.exit(1);
      }
    },
  };
}

/**
 * Runs the full token transfer flow from argument validation through relay submission.
 */
async function executeTokenTransfer(
  argv: TokenTransferArgs,
  overrides: WormholeConfigOverrides<Network>
): Promise<void> {
  const networkInput = argv.network;
  if (!isNetwork(networkInput)) {
    throw new TokenTransferError(`Invalid network: ${networkInput}`);
  }
  const network = networkInput;

  const sourceChainInput = argv["source-chain"];
  assertChain(sourceChainInput);
  const destinationChainInput = argv["destination-chain"];
  assertChain(destinationChainInput);

  ensurePlatformSupported(sourceChainInput);
  ensurePlatformSupported(destinationChainInput);
  const sourcePlatform = chainToPlatform(sourceChainInput);
  const destinationPlatform = chainToPlatform(destinationChainInput);

  const amountInput = argv.amount.trim();
  if (!amountInput) {
    throw new TokenTransferError("Amount must not be empty");
  }
  const destinationMsgValueArg = argv["destination-msg-value"];
  let destinationMsgValueOverride: bigint | undefined;
  if (destinationMsgValueArg !== undefined) {
    if (Array.isArray(destinationMsgValueArg)) {
      throw new TokenTransferError(
        "--destination-msg-value may only be specified once"
      );
    }
    if (destinationMsgValueArg === null) {
      throw new TokenTransferError(
        "--destination-msg-value must be a positive integer"
      );
    }
    if (typeof destinationMsgValueArg !== "string") {
      throw new TokenTransferError(
        "--destination-msg-value must be provided as a string"
      );
    }
    const trimmed = destinationMsgValueArg.trim();
    if (trimmed.length === 0) {
      throw new TokenTransferError(
        "--destination-msg-value must be a positive integer"
      );
    }
    try {
      destinationMsgValueOverride = BigInt(trimmed);
    } catch {
      throw new TokenTransferError(
        "--destination-msg-value must be a valid integer (lamports / native units)"
      );
    }
    if (destinationMsgValueOverride <= 0n) {
      throw new TokenTransferError(
        "--destination-msg-value must be greater than zero"
      );
    }
  }

  const payerRaw = argv["payer"];
  if (Array.isArray(payerRaw)) {
    throw new TokenTransferError("--payer may only be specified once");
  }
  const payerPath = typeof payerRaw === "string" ? payerRaw.trim() : undefined;
  if (payerRaw !== undefined && (!payerPath || payerPath.length === 0)) {
    throw new TokenTransferError(
      "--payer must be a path to a Solana keypair JSON file"
    );
  }

  const destinationAddressRaw = argv["destination-address"];
  if (Array.isArray(destinationAddressRaw)) {
    throw new TokenTransferError(
      "--destination-address may only be specified once"
    );
  }

  const destinationAddressInput =
    typeof destinationAddressRaw === "string"
      ? destinationAddressRaw.trim()
      : undefined;

  if (
    destinationAddressRaw === undefined ||
    destinationAddressInput === undefined ||
    destinationAddressInput.length === 0
  ) {
    throw new TokenTransferError(
      "--destination-address must include a non-empty canonical address string"
    );
  }

  if (payerPath && chainToPlatform(sourceChainInput) !== "Solana") {
    console.warn(
      chalk.yellow(
        "--payer is only used when the source chain is Solana. Ignoring provided path."
      )
    );
  }

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
    throw new TokenTransferError(
      "--rpc expects values in the form Chain=URL. Remove the flag or provide a valid endpoint."
    );
  }

  // Users sometimes repeat flags; yargs returns an array in that case. Treat it as invalid.
  if (
    Object.prototype.hasOwnProperty.call(argv, "timeout") &&
    (argv.timeout === undefined ||
      argv.timeout === null ||
      Array.isArray(argv.timeout))
  ) {
    throw new TokenTransferError(
      "--timeout expects a numeric value in seconds. Remove the flag or provide a valid number."
    );
  }

  if (
    typeof argv.timeout === "number" &&
    (Number.isNaN(argv.timeout) || argv.timeout <= 0)
  ) {
    throw new TokenTransferError("--timeout must be a positive number of seconds.");
  }

  const timeoutSeconds = argv.timeout ?? 1200;
  const timeoutMs = Math.max(1, Math.floor(timeoutSeconds)) * 1000;

  const deploymentPathArg = argv["deployment-path"];
  if (
    typeof deploymentPathArg !== "string" ||
    deploymentPathArg.trim().length === 0
  ) {
    throw new TokenTransferError(
      "--deployment-path must point to a deployment file."
    );
  }
  const deploymentPath = deploymentPathArg.trim();

  const deployments = loadConfig(deploymentPath);
  const configuredChainEntries = Object.entries(deployments.chains).filter(
    (entry): entry is [string, ChainConfig] => entry[1] !== undefined
  );
  const configuredChains = configuredChainEntries.map(([chain]) => chain as Chain);

  if (configuredChains.length === 0) {
    throw new TokenTransferError(
      `Deployment file ${deploymentPath} does not contain any configured chains.`
    );
  }

  if (deployments.network !== network) {
    throw new TokenTransferError(
      `Deployment file ${deploymentPath} targets ${deployments.network}, but --network was set to ${network}.`
    );
  }

  const sourceDeployment = deployments.chains[sourceChainInput];
  if (!sourceDeployment) {
    throw new TokenTransferError(
      `Chain ${sourceChainInput} is not present in ${deploymentPath}. Available chains: ${configuredChains.join(", ")}`
    );
  }

  const destinationDeployment = deployments.chains[destinationChainInput];
  if (!destinationDeployment) {
    throw new TokenTransferError(
      `Chain ${destinationChainInput} is not present in ${deploymentPath}. Available chains: ${configuredChains.join(", ")}`
    );
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

  const sourceSignerOverride =
    sourcePlatform === "Solana" ? payerPath : undefined;
  const { key: normalizedSourceKey, file: normalizedSourceFile } =
    resolveSignerInput(sourceCtx.chain, sourceSignerOverride);
  const sourceSigner = await getSignerSafe(
    sourceCtx,
    normalizedSourceKey,
    normalizedSourceFile
  );

  const destinationAddress = parseDestinationAddress(
    destinationChainInput,
    destinationAddressInput
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
    throw new TokenTransferError(
      "Amount must be greater than zero after conversion"
    );
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
    throw new TokenTransferError(
      `Unable to fetch balance on ${sourceChainInput}`
    );
  }

  const sourceBalance = sourceBalanceRaw;

  if (sourceBalance < transferAmount) {
    const available = formatAmount(sourceBalance, decimals);
    const required = formatAmount(transferAmount, decimals);
    throw new TokenTransferError(
      `Insufficient balance on ${sourceChainInput}. Required ${required}, available ${available}`
    );
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
    throw new TokenTransferError(`Transfer validation failed: ${reason}`);
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

  const executorQuoteDetails = quoteResult.details;
  if (!isExecutorQuote(executorQuoteDetails)) {
    fail(
      "Executor quote did not include relay details",
      new Error("Missing executor quote details")
    );
  }
  const executorQuote = executorQuoteDetails;

  if (quoteResult.warnings?.length) {
    for (const warning of quoteResult.warnings) {
      console.warn(chalk.yellow(formatQuoteWarning(warning)));
    }
  }

  const estimatedDestinationAmount = amount.display(
    quoteResult.destinationToken.amount
  );
  const formattedTransferAmount = formatAmount(transferAmount, decimals);
  console.log(
    `Transferring ${formattedTransferAmount} tokens from ${sourceChainInput} to ${destinationChainInput} (${network})`
  );
  console.log(
    `Source address: ${chalk.cyan(sourceSigner.address.address.toString())}`
  );
  const destinationAddressDisplay = Wormhole.canonicalAddress(
    destinationAddress
  );
  console.log(
    `Destination address: ${chalk.cyan(destinationAddressDisplay)}`
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

  if (network === "Mainnet") {
    const confirmed = await confirmMainnetTransfer(
      formattedTransferAmount,
      sourceChainInput,
      destinationChainInput,
      sourcePlatform
    );
    if (!confirmed) {
      console.log("Transfer cancelled. Re-run the command when you are ready.");
      return;
    }
  }

  console.log(`Submitting transfer on ${sourceChainInput}...`);
  let receipt: NttExecutorRoute.TransferReceipt;
  try {
    receipt = (await routeInstance.initiate(
      transferRequest,
      sourceSigner.signer,
      quoteResult,
      destinationAddress
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
        throw new TokenTransferError(
          "Failed while waiting for attestation. Verify Wormhole RPC endpoints are reachable.",
          { cause: error }
        );
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
}

/**
 * Extract Wormhole NTT contract addresses per configured chain from the deployment file.
 */
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
    const tokenAddress = cfg.token;
    const managerAddress = cfg.manager;
    if (!tokenAddress) {
      throw new Error(
        `Deployment file ${deploymentPath} is missing the token address for ${chain}.`
      );
    }
    if (!managerAddress) {
      throw new Error(
        `Deployment file ${deploymentPath} is missing the manager address for ${chain}.`
      );
    }
    if (!wormholeTransceiver) {
      throw new Error(
        `Deployment file ${deploymentPath} is missing the wormhole transceiver address for ${chain}.`
      );
    }
    contracts.set(chain, {
      token: tokenAddress,
      manager: managerAddress,
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

/**
 * Fetch contract metadata for a specific chain, erroring if the deployment lacks it.
 */
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

/**
 * Convert deployment contracts into the executor route config understood by the SDK.
 */
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

/**
 * Attach a msgValue override so the executor funds rent/gas for a given destination token.
 */
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

/**
 * Prompt the operator to confirm they entered a human-readable amount before Mainnet submissions.
 */
async function confirmMainnetTransfer(
  formattedAmount: string,
  sourceChain: Chain,
  destinationChain: Chain,
  platform: Platform
): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const unitDescriptor =
    platform === "Solana" ? "lamports" : "base units";
  const prompt = [
    "",
    chalk.yellow(
      `You are about to submit a Mainnet transfer of ${formattedAmount} tokens from ${sourceChain} to ${destinationChain}.`
    ),
    chalk.yellow(
      `Confirm this amount is expressed in human-readable units (not ${unitDescriptor}).`
    ),
    "Type \"yes\" (or \"y\") to continue: ",
  ].join("\n");
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    rl.once("SIGINT", () => {
      console.log("\nTransfer cancelled.");
      settle(false);
      rl.close();
    });

    rl.once("close", () => {
      if (!settled) {
        settle(false);
      }
    });

    rl.question(prompt, (answer) => {
      const normalized = answer.trim().toLowerCase();
      settle(normalized === "yes" || normalized === "y");
      rl.close();
    });
  });
}

/** Render human-friendly descriptions for route quote warnings. */
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
 * Runtime type guard ensuring quote details include executor fee fields.
 */
function isExecutorQuote(
  value: unknown
): value is NttWithExecutor.Quote {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<NttWithExecutor.Quote>;
  const hasValidExpiry =
    candidate.expires === undefined || candidate.expires instanceof Date;
  return (
    typeof candidate.referrerFee === "bigint" &&
    typeof candidate.referrerFeeDbps === "bigint" &&
    typeof candidate.estimatedCost === "bigint" &&
    typeof candidate.gasDropOff === "bigint" &&
    hasValidExpiry
  );
}

/**
 * Validate the CLI supports the platform hosting the given chain.
 * Exits early with a helpful message if not.
 */
function ensurePlatformSupported(chain: Chain): void {
  const platform = chainToPlatform(chain);
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new TokenTransferError(
      `Chain ${chain} (platform ${platform}) is not supported by token-transfer`
    );
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

/**
 * Wrapper around getSigner that annotates RPC issues and provides platform guidance.
 */
async function getSignerSafe<N extends Network, C extends Chain>(
  ctx: ChainContext<N, C>,
  source?: string,
  filePath?: string
): Promise<SignerStuff<N, C>> {
  try {
    return await getSigner(ctx, "privateKey", source, filePath);
  } catch (error) {
    if (isLikelyRpcError(error)) {
      throw new TokenTransferError(
        `Unable to reach RPC endpoint for ${ctx.chain}. Ensure the RPC is reachable or override it with --rpc ${ctx.chain}=<url>.`,
        { cause: error }
      );
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
 * Present TokenTransferError details consistently before exiting the CLI.
 */
function reportTokenTransferError(error: unknown): void {
  if (error instanceof TokenTransferError) {
    console.error(chalk.red(error.message));
    if (error.cause) {
      console.error(stringifyError(error.cause));
    }
    return;
  }
  console.error(chalk.red("Unexpected token-transfer error"));
  console.error(stringifyError(error));
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
    logRpcError(error, ctx.chain, network, ctx.config.rpc);
  }
  throw new TokenTransferError(prefix, {
    cause: error instanceof Error ? error : new Error(String(error)),
  });
}

/**
 * Best-effort detection of transport-level RPC issues.
 */
function isLikelyRpcError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : "";
  const stack =
    error instanceof Error
      ? (error.stack ?? "")
      : typeof error === "object" && error !== null && "stack" in error
        ? String((error as { stack: unknown }).stack)
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
        "Provide an EVM private key by exporting ETH_PRIVATE_KEY in your environment.",
        "Ensure the variable contains a 0x-prefixed hex string for the signer you intend to use.",
      ].join("\n");
    case "Solana":
      return [
        "Provide a Solana signer using one of:",
        "  • Export SOLANA_PRIVATE_KEY (base58) in your environment",
        "  • Pass --payer with the path to the keypair JSON file",
      ].join("\n");
    case "Sui":
      return [
        "Provide a Sui private key using one of:",
        "  • Export SUI_PRIVATE_KEY in your environment",
        "  • Provide a Base64-encoded key via configuration",
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
    try {
      const keyFromFile = fs.readFileSync(raw, "utf8").trim();
      if (!keyFromFile) {
        throw new TokenTransferError(
          `Key file ${raw} is empty. Provide a private key or remove --payer/inline key.`
        );
      }
      return { key: keyFromFile };
    } catch (error) {
      throw new TokenTransferError(
        `Failed to read key material from ${raw}. Ensure the file exists and is readable.`,
        { cause: error }
      );
    }
  }

  if (platform === "Solana") {
    const base58Pattern = /^[1-9A-HJ-NP-Za-km-z]{32,}$/;
    if (base58Pattern.test(raw)) {
      return { key: raw };
    }
  }

  return { key: raw };
}

/**
 * Normalize the destination address into the canonical ChainAddress wrapper.
 */
function parseDestinationAddress(
  chain: Chain,
  address: string
): ChainAddress<Chain> {
  try {
    return Wormhole.chainAddress(chain, address);
  } catch (error) {
    fail(
      `Invalid destination address for ${chain}. Ensure the address is in the canonical format expected by Wormhole.`,
      error
    );
  }
}

/**
 * Merge `--rpc Chain=URL` overrides into the Wormhole configuration for this run.
 */
function applyRpcOverrides<N extends Network>(
  base: WormholeConfigOverrides<N>,
  rpcArgs: string[] | undefined,
  allowedChains: Set<Chain>
): WormholeConfigOverrides<N> {
  if (!rpcArgs || rpcArgs.length === 0) {
    return base;
  }

  const cloned: WormholeConfigOverrides<N> = {
    ...(base ?? {}),
    chains: {
      ...(base?.chains ?? {}),
    },
  };
  type ChainOverrideEntry = Record<string, unknown> & { rpc?: string };
  const chainsOverrides =
    (cloned.chains ?? (cloned.chains = {})) as Record<Chain, ChainOverrideEntry>;

  for (const arg of rpcArgs) {
    if (typeof arg !== "string") {
      continue;
    }
    const [chainRaw, ...rest] = arg.split("=");
    const chainName = chainRaw?.trim();
    const rpc = rest.join("=").trim();
    if (!chainName || !rpc) {
      throw new TokenTransferError(
        `Invalid --rpc value "${arg}". Expected format Chain=URL.`
      );
    }
    try {
      assertChain(chainName as Chain);
    } catch {
      throw new TokenTransferError(
        `Invalid chain name "${chainName}" provided to --rpc.`
      );
    }
    const chain = chainName as Chain;
    if (!allowedChains.has(chain)) {
      console.warn(
        chalk.yellow(
          `Warning: RPC override provided for ${chain}, which is not part of this transfer.`
        )
      );
    }
    const currentOverrides = chainsOverrides[chain];
    const clonedOverride: ChainOverrideEntry = {
      ...(currentOverrides ?? {}),
    };
    clonedOverride.rpc = rpc;
    chainsOverrides[chain] = clonedOverride;
  }

  return cloned;
}

/**
 * Intercepts console output to show a spinner when a retriable log message appears.
 */
async function withRetryStatus<T>(
  needle: string | RegExp,
  fn: () => Promise<T>
): Promise<T> {
  const originalLog = console.log;
  let sawNeedle = false;
  let spinner: Ora | null = null;

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

  const stopSpinner = (): void => {
    if (!spinner) {
      return;
    }
    spinner.stop();
    spinner = null;
  };

  console.log = (...args: Parameters<typeof console.log>) => {
    const message = args.map(String).join(" ");
    if (matchesNeedle(message)) {
      sawNeedle = true;
      if (!spinner) {
        spinner = ora({ text: message }).start();
      } else {
        spinner.text = message;
      }
      return;
    }
    stopSpinner();
    originalLog(...args);
  };

  try {
    return await fn();
  } finally {
    stopSpinner();
    if (sawNeedle && process.stdout.isTTY) {
      process.stdout.write("\n");
    }
    console.log = originalLog;
  }
}

/**
 * Verify the selected Wormhole network exposes RPC config for the requested chain.
 */
function ensureChainSupported<N extends Network>(
  wh: Wormhole<N>,
  chain: Chain,
  role: "source" | "destination"
): void {
  const entry = wh.config.chains?.[chain];
  if (entry && entry.rpc) {
    return;
  }
  throw new TokenTransferError(
    `Chain ${chain} is not available on ${wh.network}. Ensure you select a network that supports this ${role} chain.`
  );
}
