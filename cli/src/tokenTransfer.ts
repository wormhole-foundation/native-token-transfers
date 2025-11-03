import chalk from "chalk";
import type { Argv, CommandModule } from "yargs";
import {
  Wormhole,
  TokenTransfer,
  amount,
  assertChain,
  chainToPlatform,
  chains,
  isNetwork,
  networks,
} from "@wormhole-foundation/sdk";
import type {
  Chain,
  ChainContext,
  Network,
  Platform,
  TokenId,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/platforms/evm";
import solana from "@wormhole-foundation/sdk/platforms/solana";
import sui from "@wormhole-foundation/sdk/platforms/sui";
import { getSigner, type SignerStuff } from "./getSigner";
import { handleRpcError } from "./error";
import "@wormhole-foundation/sdk-evm-tokenbridge";
import "@wormhole-foundation/sdk-solana-tokenbridge";
import "@wormhole-foundation/sdk-sui-tokenbridge";
import fs from "fs";

type TokenTransferArgs = {
  network: string;
  "source-chain": Chain;
  "destination-chain": Chain;
  token: string;
  amount: string;
  "source-key"?: string;
  "destination-key"?: string;
  timeout?: number;
  rpc?: string[];
};

const SUPPORTED_PLATFORMS: ReadonlySet<Platform> = new Set([
  "Evm",
  "Solana",
  "Sui",
]);

export function createTokenTransferCommand(
  overrides: WormholeConfigOverrides<Network>
): CommandModule<Record<string, unknown>, TokenTransferArgs> {
  return {
    command: "token-transfer",
    describe: "Transfer tokens between chains using the TokenBridge protocol",
    builder: (yargs): Argv<TokenTransferArgs> =>
      (yargs
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
            "Token address on the source chain (use 'native' for native tokens where supported)",
          type: "string",
          demandOption: true,
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
          "$0 token-transfer --network Testnet --source-chain Sepolia --destination-chain Solana --token 0xToken... --amount 1.25",
          "Transfer 1.25 tokens from Sepolia to Solana on Testnet"
        )
        .example(
          "$0 token-transfer -n Testnet --source-chain Solana --destination-chain Sepolia --token 4zMMC9... --amount 0.1",
          "Transfer 0.1 tokens from Solana to Sepolia on Testnet"
        )
        .example(
          "$0 token-transfer --network Testnet --source-chain Solana --destination-chain Sepolia --token 4zMMC9... --amount 0.1 --rpc Solana=https://api.devnet.solana.com",
          "Override the Solana RPC endpoint for this run"
        )
        .strict()) as Argv<TokenTransferArgs>,
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

      const tokenInput = argv.token.trim();
      if (!tokenInput) {
        console.error(chalk.red("Token address must not be empty"));
        process.exit(1);
      }

      const amountInput = argv.amount.trim();
      if (!amountInput) {
        console.error(chalk.red("Amount must not be empty"));
        process.exit(1);
      }

      const sourceKey = argv["source-key"]?.trim();
      const destinationKey = argv["destination-key"]?.trim();
      const rpcRaw = argv["rpc"];
      const rpcArgs = Array.isArray(rpcRaw)
        ? rpcRaw
        : rpcRaw
        ? [rpcRaw]
        : undefined;

      if (
        rpcArgs &&
        (rpcArgs.length === 0 ||
          rpcArgs.some(
            (value) =>
              typeof value !== "string" || value.trim().length === 0
          ))
      ) {
        console.error(
          chalk.red(
            "--rpc expects values in the form Chain=URL. Remove the flag or provide a valid endpoint."
          )
        );
        process.exit(1);
      }

      if (
        Object.prototype.hasOwnProperty.call(argv, "timeout") &&
        (argv.timeout === undefined || argv.timeout === null)
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

      const runtimeOverrides = applyRpcOverrides(
        overrides,
        rpcArgs as string[] | undefined
      );

      const wh = new Wormhole(network, [
        evm.Platform,
        solana.Platform,
        sui.Platform,
      ], runtimeOverrides);

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

      await ensureTokenBridgeSupport(sourceCtx, "source", network);
      await ensureTokenBridgeSupport(destinationCtx, "destination", network);

      const chainContexts = new Map<Chain, ChainContext<Network, Chain>>([
        [sourceChainInput, sourceCtx],
        [destinationChainInput, destinationCtx],
      ]);

      let tokenId: TokenId;
      try {
        tokenId = Wormhole.tokenId(
          sourceChainInput,
          tokenInput === "native" ? "native" : tokenInput
        );
      } catch (error) {
        if (tokenInput !== "native") {
          const platform = chainToPlatform(sourceChainInput);
          let hint = "";
          if (platform === "Evm") {
            hint =
              "Expected a 0x-prefixed address with 40 hexadecimal characters.";
          } else if (platform === "Solana") {
            hint = "Expected a valid Solana base58 address.";
          } else if (platform === "Sui") {
            hint =
              "Expected a valid Sui address (0x-prefixed with 64 hexadecimal characters).";
          }
          console.error(
            chalk.red(
              `Invalid token address "${tokenInput}" for ${sourceChainInput}. ${hint}`
            )
          );
          process.exit(1);
        }
        fail("Failed to parse token identifier", error);
      }

      const { key: normalizedSourceKey, file: normalizedSourceFile } =
        resolveSignerInput(sourceCtx.chain, sourceKey);
      const { key: normalizedDestinationKey, file: normalizedDestinationFile } =
        resolveSignerInput(destinationCtx.chain, destinationKey);

      await ensureTokenBridgeSupport(sourceCtx, "source", network);
      await ensureTokenBridgeSupport(destinationCtx, "destination", network);

      if (tokenId.address !== "native") {
        try {
          await TokenTransfer.lookupDestinationToken(
            sourceCtx,
            destinationCtx,
            tokenId
          );
        } catch (error) {
          console.error(
            chalk.red(
              `Token ${tokenId.address} is not registered on ${destinationCtx.chain}. The asset must exist on the destination chain before transferring.`
            )
          );
          process.exit(1);
        }
      }

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

      let xfer: TokenTransfer<Network>;
      try {
        xfer = await wh.tokenTransfer(
          tokenId,
          transferAmount,
          sourceSigner.address,
          destinationSigner.address,
          "TokenBridge"
        );
      } catch (error) {
        fail("Failed to prepare token transfer", error);
      }

      console.log(
        `Transferring ${formatAmount(transferAmount, decimals)} tokens from ${sourceChainInput} to ${destinationChainInput} (${network})`
      );
      console.log(
        `Source address: ${chalk.cyan(
          sourceSigner.address.address.toString()
        )}`
      );
      console.log(
        `Destination address: ${chalk.cyan(
          destinationSigner.address.address.toString()
        )}`
      );
      console.log(
        `Token: ${chalk.cyan(
          tokenId.address
        )} (decimals: ${decimals.toString()})`
      );

      try {
        const payload =
          (xfer.transfer as { payload?: Uint8Array }).payload ?? undefined;
        const quoteDetails: TokenTransfer.QuoteTransferDetails = {
          token: xfer.transfer.token,
          amount: xfer.transfer.amount,
          protocol: "TokenBridge",
          ...(payload ? { payload } : {}),
        };
        const quote = await TokenTransfer.quoteTransfer(
          wh,
          sourceCtx,
          destinationCtx,
          quoteDetails
        );
        const destCtxForQuote = getOrCreateContext(
          wh,
          chainContexts,
          quote.destinationToken.token.chain
        );
        const destDecimals = await resolveTokenDecimals(
          wh,
          quote.destinationToken.token,
          destCtxForQuote,
          network
        );
        console.log(
          `Estimated destination amount: ${formatAmount(
            quote.destinationToken.amount,
            destDecimals
          )}`
        );
        if (quote.relayFee) {
          const feeCtx = getOrCreateContext(
            wh,
            chainContexts,
            quote.relayFee.token.chain
          );
          const feeDecimals = await resolveTokenDecimals(
            wh,
            quote.relayFee.token,
            feeCtx,
            network
          );
          console.log(
            `Estimated relayer fee: ${formatAmount(
              quote.relayFee.amount,
              feeDecimals
            )}`
          );
        }
        if (quote.destinationNativeGas) {
          console.log(
            `Estimated destination native gas: ${quote.destinationNativeGas.toString()}`
          );
        }
      } catch (error) {
        if (isLikelyRpcError(error)) {
          console.error(
            chalk.red(
              `Failed to fetch transfer quote. Check RPC endpoints for ${sourceCtx.chain} or ${destinationCtx.chain}.`
            )
          );
          console.error(stringifyError(error));
          process.exit(1);
        }
        console.warn(
          chalk.yellow(
            `Warning: failed to fetch transfer quote (${stringifyError(error)})`
          )
        );
      }

      console.log(`Submitting transfer on ${sourceChainInput}...`);
      let initTxs: readonly string[];
      try {
        initTxs = await xfer.initiateTransfer(sourceSigner.signer);
      } catch (error) {
        fail(
          `Failed to submit transfer transaction on ${sourceChainInput}`,
          error,
          sourceCtx,
          network
        );
      }

      if (initTxs.length > 0) {
        console.log(
          `Source transaction: ${chalk.cyan(initTxs[0].toString())}`
        );
        if (initTxs.length > 1) {
          console.log(
            `Wormhole transaction: ${chalk.cyan(initTxs[1].toString())}`
          );
        }
      }

      console.log(
        `Waiting for attestation (timeout ${Math.floor(timeoutMs / 1000)} seconds)...`
      );
      try {
        const attestations = await withRetryStatus(
          "Retrying Wormholescan:GetVaaBytes",
          async () => xfer.fetchAttestation(timeoutMs)
        );
        if (attestations.length > 0) {
          console.log(
            `Attestation sequence: ${chalk.cyan(
              attestations[0].sequence.toString()
            )}`
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

      console.log(`Redeeming transfer on ${destinationChainInput}...`);
      let destTxs: readonly string[];
      try {
        destTxs = await xfer.completeTransfer(destinationSigner.signer);
      } catch (error) {
        fail(
          `Failed to redeem transfer on ${destinationChainInput}`,
          error,
          destinationCtx,
          network
        );
      }

      if (destTxs.length > 0) {
        console.log(
          `Destination transaction: ${chalk.cyan(destTxs[0].toString())}`
        );
      }

      console.log(chalk.green("Transfer completed successfully."));
    },
  };
}

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

function getOrCreateContext(
  wh: Wormhole<Network>,
  cache: Map<Chain, ChainContext<Network, Chain>>,
  chain: Chain
): ChainContext<Network, Chain> {
  let ctx = cache.get(chain);
  if (!ctx) {
    ctx = wh.getChain(chain);
    cache.set(chain, ctx);
  }
  return ctx;
}

async function ensureTokenBridgeSupport(
  ctx: ChainContext<Network, Chain>,
  role: "source" | "destination",
  network: Network
): Promise<void> {
  try {
    await ctx.getTokenBridge();
  } catch (error) {
    fail(
      `TokenBridge is not available on ${role} chain ${ctx.chain}`,
      error,
      ctx,
      network
    );
  }
}

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
  } else {
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
}

function formatAmount(value: bigint, decimals: number): string {
  return amount.display(
    amount.fromBaseUnits(value, decimals),
    Math.min(decimals, 8)
  );
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

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

function isLikelyRpcError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
      ? String((error as any).message)
      : "";
  const stack =
    error instanceof Error
      ? error.stack ?? ""
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
  rpcArgs?: string[]
): WormholeConfigOverrides<N> {
  if (!rpcArgs || rpcArgs.length === 0) {
    return base;
  }

  const cloned = JSON.parse(JSON.stringify(base ?? {})) as WormholeConfigOverrides<N>;
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
        chalk.red(
          `Invalid --rpc value "${arg}". Expected format Chain=URL.`
        )
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
    if (!chainsOverrides[chain]) {
      (chainsOverrides as any)[chain] = {};
    }
    (chainsOverrides as any)[chain].rpc = rpc;
  }

  return cloned;
}

async function withRetryStatus<T>(
  needle: string,
  fn: () => Promise<T>
): Promise<T> {
  const originalLog = console.log;
  let lastMessageLength = 0;
  let lastMessage = "";
  let sawNeedle = false;

  console.log = (...args: any[]) => {
    const message = args.map(String).join(" ");
    if (message.startsWith(needle)) {
      sawNeedle = true;
      if (process.stdout.isTTY) {
        const padded =
          message + (lastMessageLength > message.length
            ? " ".repeat(lastMessageLength - message.length)
            : "");
        process.stdout.write(`\r${padded}`);
        lastMessageLength = message.length;
      } else {
        lastMessage = message;
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
