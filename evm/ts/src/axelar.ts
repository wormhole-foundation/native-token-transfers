import { Chain, Network } from "@wormhole-foundation/sdk-base";
import {
  AxelarQueryAPI,
  Environment,
  EvmChain,
} from "@axelar-network/axelarjs-sdk";

export const axelarChains: Partial<Record<Chain, EvmChain>> = {
  Sepolia: EvmChain.SEPOLIA,
  // Monad: EvmChain.MONAD,
  Ethereum: EvmChain.ETHEREUM,
  // add more as needed
};

export async function getAxelarGasFee(
  network: Network,
  sourceChain: Chain,
  destinationChain: Chain,
  gasLimit: bigint
): Promise<bigint> {
  const api = new AxelarQueryAPI({
    environment:
      network === "Mainnet" ? Environment.MAINNET : Environment.TESTNET,
  });

  const axelarSourceChain = axelarChains[sourceChain];
  if (!axelarSourceChain) {
    throw new Error(`Unsupported source chain: ${sourceChain}`);
  }

  const axelarDestinationChain = axelarChains[destinationChain];
  if (!axelarDestinationChain) {
    throw new Error(`Unsupported destination chain: ${destinationChain}`);
  }

  const response = await api.estimateGasFee(
    axelarSourceChain,
    axelarDestinationChain,
    gasLimit
  );

  if (typeof response !== "string") {
    throw new Error(`Unexpected response type: ${typeof response}`);
  }

  return BigInt(response);
}
