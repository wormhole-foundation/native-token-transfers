import { Chain, Network } from "@wormhole-foundation/sdk-base";

// The point if this module is to use direct API calls instead of importing the entire @axelar-network/axelarjs-sdk to stay lightweight.

// Axelar chains: https://github.com/axelarnetwork/axelarjs-sdk/blob/53a957deb1209325b1e3d109e0985a64db6d9901/src/constants/EvmChain.ts#L1
export const axelarChains: Partial<Record<Chain, string>> = {
  Ethereum: "ethereum",
  Monad: "monad",
  Sepolia: "ethereum-sepolia",
  // add more as needed
};

// https://github.com/axelarnetwork/axelarjs-sdk/blob/53a957deb1209325b1e3d109e0985a64db6d9901/src/libs/TransactionRecoveryApi/AxelarRecoveryApi.ts#L16
export enum GMPStatus {
  SRC_GATEWAY_CALLED = "source_gateway_called",
  DEST_GATEWAY_APPROVED = "destination_gateway_approved",
  DEST_EXECUTED = "destination_executed",
  EXPRESS_EXECUTED = "express_executed",
  DEST_EXECUTE_ERROR = "error",
  DEST_EXECUTING = "executing",
  APPROVING = "approving",
  FORECALLED = "forecalled",
  FORECALLED_WITHOUT_GAS_PAID = "forecalled_without_gas_paid",
  NOT_EXECUTED = "not_executed",
  NOT_EXECUTED_WITHOUT_GAS_PAID = "not_executed_without_gas_paid",
  INSUFFICIENT_FEE = "insufficient_fee",
  UNKNOWN_ERROR = "unknown_error",
  CANNOT_FETCH_STATUS = "cannot_fetch_status",
  SRC_GATEWAY_CONFIRMED = "confirmed",
}

export interface GMPError {
  txHash: string;
  chain: string;
  message: string;
}

export function getAxelarApiUrl(network: Network): string {
  return network === "Mainnet"
    ? "https://api.axelarscan.io"
    : "https://testnet.api.axelarscan.io";
}

export function getAxelarChain(chain: Chain): string {
  const axelarChain = axelarChains[chain];
  if (!axelarChain) {
    throw new Error(`Unsupported axelar chain: ${chain}`);
  }
  return axelarChain;
}

export async function getAxelarGasFee(
  network: Network,
  sourceChain: Chain,
  destinationChain: Chain,
  gasLimit: bigint,
  timeoutMs = 10000
): Promise<bigint> {
  const url = `${getAxelarApiUrl(network)}/gmp/estimateGasFee`;
  const axelarSourceChain = getAxelarChain(sourceChain);
  const axelarDestinationChain = getAxelarChain(destinationChain);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Set a minimum fee of 1 to avoid 0-fee issue with relays not proceeding
  // past the gas paid step
  let fee = 1n;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sourceChain: axelarSourceChain,
        destinationChain: axelarDestinationChain,
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

    const parsedFee = BigInt(result);
    if (parsedFee > 0n) {
      fee = parsedFee;
    }
  } finally {
    clearTimeout(timeoutId);
  }

  return fee;
}

export async function getAxelarTransactionStatus(
  network: Network,
  sourceChain: Chain,
  txHash: string,
  timeoutMs = 10000
): Promise<{ status: GMPStatus | string; error?: GMPError }> {
  const url = `${getAxelarApiUrl(network)}/gmp/searchGMP`;

  const axelarSourceChain = getAxelarChain(sourceChain);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sourceChain: axelarSourceChain,
        txHash: txHash,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to get transaction status: ${response.status} ${errorText}`
      );
    }

    const result = await response.json();
    if (!result.data || result.data.length === 0) {
      throw new Error("No transaction details found");
    }

    const txDetails = result.data[0];
    return {
      status: parseGMPStatus(txDetails),
      error: parseGMPError(txDetails),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export function parseGMPStatus(response: any): GMPStatus | string {
  const { error, status } = response;

  if (status === "error" && error) return GMPStatus.DEST_EXECUTE_ERROR;
  else if (status === "executed") return GMPStatus.DEST_EXECUTED;
  else if (status === "approved") return GMPStatus.DEST_GATEWAY_APPROVED;
  else if (status === "called") return GMPStatus.SRC_GATEWAY_CALLED;
  else if (status === "executing") return GMPStatus.DEST_EXECUTING;
  else {
    return status;
  }
}

export function parseGMPError(response: any): GMPError | undefined {
  if (response.error) {
    return {
      message: response.error.error.message,
      txHash: response.error.sourceTransactionHash,
      chain: response.error.chain,
    };
  } else if (response.is_insufficient_fee) {
    return {
      message: "Insufficient gas",
      txHash: response.call.transaction.hash,
      chain: response.call.chain,
    };
  }
}

export function getAxelarExplorerUrl(network: Network, txHash: string): string {
  return network === "Mainnet"
    ? `https://axelarscan.io/gmp/${txHash}`
    : `https://testnet.axelarscan.io/gmp/${txHash}`;
}
