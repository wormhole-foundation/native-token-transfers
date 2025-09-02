import { Chain, Network } from "@wormhole-foundation/sdk-base";
import {
  AxelarGMPRecoveryAPI,
  Environment,
  GMPStatusResponse,
} from "@axelar-network/axelarjs-sdk";

// See: https://github.com/axelarnetwork/axelarjs-sdk/blob/main/src/constants/EvmChain.ts
export const axelarChains: Partial<Record<Chain, string>> = {
  Ethereum: "ethereum",
  Monad: "monad",
  Sepolia: "ethereum-sepolia",
  // add more as needed
};

export async function getAxelarGasFee(
  network: Network,
  sourceChain: Chain,
  destinationChain: Chain,
  gasLimit: bigint,
  timeoutMs = 10000
): Promise<bigint> {
  const baseUrl =
    network === "Mainnet"
      ? "https://api.axelarscan.io/gmp/estimateGasFee"
      : "https://testnet.api.axelarscan.io/gmp/estimateGasFee";

  const axelarSourceChain = axelarChains[sourceChain];
  if (!axelarSourceChain) {
    throw new Error(`Unsupported source chain: ${sourceChain}`);
  }

  const axelarDestinationChain = axelarChains[destinationChain];
  if (!axelarDestinationChain) {
    throw new Error(`Unsupported destination chain: ${destinationChain}`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sourceChain: axelarSourceChain,
        destinationChain: axelarDestinationChain,
        sourceTokenAddress: "0x0000000000000000000000000000000000000000",
        gasMultiplier: "auto",
        gasLimit: gasLimit.toString(),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to estimate gas fee: ${response.status} ${errorText}`
      );
    }

    const result = await response.json();

    return BigInt(result);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function getAxelarTransactionStatus(
  network: Network,
  txHash: string
): Promise<GMPStatusResponse> {
  const api = new AxelarGMPRecoveryAPI({
    environment:
      network === "Mainnet" ? Environment.MAINNET : Environment.TESTNET,
  });
  const status = await api.queryTransactionStatus(txHash);
  return status;
}

export function getAxelarExplorerUrl(network: Network, txHash: string): string {
  return network === "Mainnet"
    ? `https://axelarscan.io/gmp/${txHash}`
    : `https://testnet.axelarscan.io/gmp/${txHash}`;
}
