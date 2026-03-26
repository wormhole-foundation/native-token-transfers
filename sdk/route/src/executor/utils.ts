import {
  Chain,
  Network,
  toChainId,
  amount as sdkAmount,
} from "@wormhole-foundation/sdk-base";
import type { UnsignedTransaction } from "@wormhole-foundation/sdk-definitions";
import {
  type CapabilitiesResponse,
  type Capabilities,
  type QuoteResponse,
  type RelayData,
  type RequestForExecution,
  type StatusResponse,
  type TxInfo,
  RelayStatus,
  RequestPrefix,
} from "@wormhole-foundation/sdk-definitions";
import axios from "axios";
import { apiBaseUrl } from "./consts.js";
import { NttRoute } from "../types.js";

export { RelayStatus, RequestPrefix };
export type {
  CapabilitiesResponse,
  Capabilities,
  QuoteResponse,
  RelayData,
  RequestForExecution,
  StatusResponse,
  TxInfo,
};

export async function fetchCapabilities(
  network: Network
): Promise<CapabilitiesResponse> {
  const url = `${apiBaseUrl[network]}/v0/capabilities`;

  try {
    const response = await axios.get<CapabilitiesResponse>(url);
    return response.data;
  } catch (error) {
    throw new Error(`Failed to fetch capabilities for network: ${network}.`);
  }
}

export async function fetchSignedQuote(
  network: Network,
  srcChain: Chain,
  dstChain: Chain,
  relayInstructions: string // TODO: `0x:${string}`
): Promise<QuoteResponse> {
  const url = `${apiBaseUrl[network]}/v0/quote`;

  try {
    const response = await axios.post<QuoteResponse>(url, {
      srcChain: toChainId(srcChain),
      dstChain: toChainId(dstChain),
      relayInstructions,
    });
    return response.data;
  } catch (error) {
    throw new Error(`Failed to fetch signed quote.`);
  }
}

// Fetch Status
export async function fetchStatus(
  network: Network,
  txHash: string,
  chain: Chain
): Promise<StatusResponse[]> {
  const url = `${apiBaseUrl[network]}/v0/status/tx`;

  try {
    const response = await axios.post<StatusResponse[]>(url, {
      txHash,
      chainId: toChainId(chain),
    });
    return response.data;
  } catch (error) {
    throw new Error(`Failed to fetch status for txHash: ${txHash}.`);
  }
}

export function isRelayStatusFailed(status: string): boolean {
  return (
    status === RelayStatus.Failed || // this could happen if simulation fails
    status === RelayStatus.Underpaid || // only happens if you don't pay at least the costEstimate
    status === RelayStatus.Unsupported || // capabilities check didn't pass
    status === RelayStatus.Aborted
  );
}

const MAX_U16 = 65_535n;
export function calculateReferrerFee(
  _amount: sdkAmount.Amount,
  dBps: bigint,
  destinationTokenDecimals: number
): { referrerFee: bigint; remainingAmount: bigint; referrerFeeDbps: bigint } {
  if (dBps > MAX_U16) {
    throw new Error("dBps exceeds max u16");
  }
  const amount = sdkAmount.units(_amount);
  let remainingAmount: bigint = amount;
  let referrerFee: bigint = 0n;
  if (dBps > 0) {
    referrerFee = (amount * dBps) / 100_000n;
    // The NttManagerWithExecutor trims the fee before subtracting it from the amount
    const trimmedFee = NttRoute.trimAmount(
      sdkAmount.fromBaseUnits(referrerFee, _amount.decimals),
      destinationTokenDecimals
    );
    remainingAmount = amount - sdkAmount.units(trimmedFee);
  }
  return { referrerFee, remainingAmount, referrerFeeDbps: dBps };
}

export async function collectTransactions<N extends Network, C extends Chain>(
  xfer: AsyncGenerator<UnsignedTransaction<N, C>>
): Promise<UnsignedTransaction<N, C>[]> {
  const transactions: UnsignedTransaction<N, C>[] = [];
  for await (const tx of xfer) {
    transactions.push(tx);
  }
  return transactions;
}
