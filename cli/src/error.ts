import chalk from "chalk";
import type { Chain, Network } from "@wormhole-foundation/sdk";
import { chainToPlatform } from "@wormhole-foundation/sdk-base";

/**
 * Handles RPC-related errors and provides helpful error messages with suggestions.
 *
 * @param error - The error that occurred
 * @param chain - The chain being deployed to
 * @param network - The network (Mainnet, Testnet, Devnet)
 * @param rpc - The RPC endpoint URL that failed
 */
export function handleRpcError(
  error: any,
  chain: Chain,
  network: Network,
  rpc: string
): never {
  const errorMessage = error?.message || String(error);
  const errorStack = error?.stack || "";

  // Check if this is an RPC-related error by looking for common RPC error indicators
  const isRpcError =
    errorMessage.toLowerCase().includes("jsonrpc") ||
    errorStack.toLowerCase().includes("jsonrpc") ||
    errorMessage.toLowerCase().includes("rpc") ||
    errorMessage.toLowerCase().includes("connection") ||
    errorMessage.toLowerCase().includes("network error");

  if (isRpcError) {
    console.error(
      chalk.red(`RPC connection error for ${chain} on ${network}\n`)
    );
    console.error(chalk.yellow("RPC endpoint:"), chalk.white(rpc));
    console.error(chalk.yellow("Error:"), errorMessage);
    console.error();
    console.error(
      chalk.yellow(
        "This error usually means the RPC endpoint is missing, invalid, or unreachable."
      )
    );
    console.error(
      chalk.yellow(
        "You can specify a private RPC endpoint by creating an overrides.json file.\n"
      )
    );
    console.error(
      chalk.cyan("Create a file named ") +
        chalk.white("overrides.json") +
        chalk.cyan(" in your project root:")
    );
    console.error(
      chalk.white(`
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
          chalk.cyan(`Find RPC endpoints for ${chain}: https://chainlist.org`)
        );
      }
    } catch (e) {
      // If chainToPlatform fails, just skip the platform-specific message
    }

    console.error(
      chalk.cyan(
        `For more information about overrides.json:\n` +
          `  • https://wormhole.com/docs/products/token-transfers/native-token-transfers/faqs/#how-can-i-specify-a-custom-rpc-for-ntt`
      )
    );
  } else {
    console.error(chalk.red("\n Error during deployment:"));
    console.error(errorMessage);
  }
  process.exit(1);
}
