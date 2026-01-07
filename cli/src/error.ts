import { colors } from "./colors.js";
import type { Chain, Network } from "@wormhole-foundation/sdk";
import { chainToPlatform } from "@wormhole-foundation/sdk-base";

const RPC_ERROR_KEYWORDS = [
  "jsonrpc",
  "network error",
  "rpc",
  "connection",
  "unable to connect",
  "404 not found",
  "status code: 404",
  "status code",
  "not found",
  "could not connect",
  "failed to fetch",
  "connect to",
] as const;

function extractErrorDetails(error: unknown): {
  message: string;
  stack: string;
} {
  if (error instanceof Error) {
    return {
      message: error.message ?? "",
      stack: error.stack ?? "",
    };
  }
  if (typeof error === "object" && error !== null) {
    const message =
      "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : "";
    const stack =
      "stack" in error
        ? String((error as { stack?: unknown }).stack ?? "")
        : "";
    return { message, stack };
  }
  return { message: String(error ?? ""), stack: "" };
}

export function isRpcConnectionError(error: unknown): boolean {
  const { message, stack } = extractErrorDetails(error);
  const haystack = `${message} ${stack}`.toLowerCase();
  if (!haystack.trim()) {
    return false;
  }
  return RPC_ERROR_KEYWORDS.some((needle) => haystack.includes(needle));
}

/**
 * @param error - The error that occurred (typically from execSync)
 * @param rpc - The RPC endpoint URL
 * @returns true if this was a Sui deployment error and was handled, false otherwise
 */
function handleSuiDeploymentError(error: any, rpc: string): boolean {
  if (!error.stdout && !error.stderr && !error.output) {
    return false;
  }

  console.error(colors.red("\nSui deployment failed\n"));

  let errorMessage = "";

  // Check stdout first (where sui client publish errors often appear)
  if (error.stdout) {
    const stdout = error.stdout.toString().trim();
    if (stdout && !stdout.startsWith("{")) {
      errorMessage = stdout;
    }
  }

  // Check error.output array [stdin, stdout, stderr]
  if (!errorMessage && error.output && Array.isArray(error.output)) {
    if (error.output[1]) {
      const stdout = error.output[1].toString().trim();
      if (stdout && !stdout.startsWith("{")) {
        errorMessage = stdout;
      }
    }
  }

  // Fallback to error.message
  if (!errorMessage && error.message) {
    errorMessage = error.message;
  }

  console.error(colors.red(errorMessage || "Unknown deployment error"));

  return true;
}

/**
 * @param error - The error that occurred
 * @param chain - The chain being deployed to
 * @param network - The network (Mainnet, Testnet, Devnet)
 * @param rpc - The RPC endpoint URL that failed
 * @returns true if this was an RPC error and was handled, false otherwise
 */
function handleRpcConnectionError(
  error: any,
  chain: Chain,
  network: Network,
  rpc: string
): boolean {
  if (!isRpcConnectionError(error)) {
    return false;
  }

  const errorMessage = error?.message || String(error);

  console.error(
    colors.red(`RPC connection error for ${chain} on ${network}\n`)
  );
  console.error(colors.yellow("RPC endpoint:"), colors.white(rpc));
  console.error(colors.yellow("Error:"), errorMessage);
  console.error();
  console.error(
    colors.yellow(
      "This error usually means the RPC endpoint is missing, invalid, or unreachable."
    )
  );
  console.error(
    colors.yellow(
      "You can specify a private RPC endpoint by creating an overrides.json file.\n"
    )
  );
  console.error(
    colors.cyan("Create a file named ") +
      colors.white("overrides.json") +
      colors.cyan(" in your project root:")
  );
  console.error(
    colors.white(`
{
  "chains": {
    "${chain}": {
      "rpc": "https://your-private-rpc-endpoint"
    }
  }
}
`)
  );

  // Show chainlist.org only for EVM chains
  try {
    const platform = chainToPlatform(chain as any);
    if (platform === "Evm") {
      console.error(
        colors.cyan(`Find RPC endpoints for ${chain}: https://chainlist.org`)
      );
    }
  } catch (e) {
    // If chainToPlatform fails, just skip the platform-specific message
  }

  console.error(
    colors.cyan(
      `For more information about overrides.json:\n` +
        `  • https://wormhole.com/docs/products/token-transfers/native-token-transfers/faqs/#how-can-i-specify-a-custom-rpc-for-ntt`
    )
  );

  return true;
}

/**
 * @param error - The error that occurred
 */
function handleGenericError(error: any): never {
  console.error(colors.red("\nDeployment failed\n"));

  const errorMessage = error?.message || String(error);

  // Show stdout if available
  if (error.stdout) {
    console.error(colors.yellow("Output:"));
    console.error(error.stdout.toString());
  }

  // Show stderr if available
  if (error.stderr) {
    console.error(colors.yellow("\nError output:"));
    console.error(error.stderr.toString());
  }

  // Show message if no stdout/stderr
  if (!error.stdout && !error.stderr) {
    console.error(colors.yellow("Error:"), errorMessage);

    // Show stack trace for debugging if available
    if (error.stack) {
      console.error(colors.dim("\nStack trace:"));
      console.error(colors.dim(error.stack));
    }
  }

  process.exit(1);
}

export function handleDeploymentError(
  error: any,
  chain: Chain,
  network: Network,
  rpc: string
): never {
  if (chain === "Sui" && handleSuiDeploymentError(error, rpc)) {
    process.exit(1);
  }

  if (handleRpcConnectionError(error, chain, network, rpc)) {
    process.exit(1);
  }

  handleGenericError(error);
}

/**
 * Log a concise RPC failure when connection-specific guidance wasn’t already printed.
 */
export function logRpcError(
  error: any,
  chain: Chain,
  network: Network,
  rpc?: string
): void {
  if (rpc && handleRpcConnectionError(error, chain, network, rpc)) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(colors.red(`RPC error for ${chain} on ${network}`));
  console.error(message);
}
