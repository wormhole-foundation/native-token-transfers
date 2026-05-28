import {
  Chain,
  Network,
  toChainId,
  amount as sdkAmount,
  deserializeLayout,
  type Layout,
} from "@wormhole-foundation/sdk-base";
import type { UnsignedTransaction } from "@wormhole-foundation/sdk-definitions";
import { SignedQuote } from "@wormhole-foundation/sdk-definitions";
import axios from "axios";
import { apiBaseUrl } from "./consts.js";
import { NttRoute } from "../types.js";

export enum RelayStatus {
  Pending = "pending",
  Failed = "failed",
  Unsupported = "unsupported",
  Submitted = "submitted",
  Underpaid = "underpaid",
  Aborted = "aborted",
}

export type RequestForExecution = {
  quoterAddress: `0x${string}`;
  amtPaid: string;
  dstChain: number;
  dstAddr: `0x${string}`;
  refundAddr: `0x${string}`;
  signedQuoteBytes: `0x${string}`;
  requestBytes: `0x${string}`;
  relayInstructionsBytes: `0x${string}`;
  timestamp: Date;
};

export type TxInfo = {
  txHash: string;
  chainId: number;
  blockNumber: string;
  blockTime: Date | null;
  cost: string;
};

export type RelayData = {
  id: `0x${string}`;
  txHash: string;
  chainId: number;
  status: string;
  estimatedCost: string;
  requestForExecution: RequestForExecution;
  instruction?: Request;
  txs?: TxInfo[];
  indexed_at: Date;
};

export enum RequestPrefix {
  ERM1 = "ERM1", // MM
  ERV1 = "ERV1", // VAA_V1
  ERN1 = "ERN1", // NTT_V1
  ERC1 = "ERC1", // CCTP_V1
  ERC2 = "ERC2", // CCTP_V2
}

export type Capabilities = {
  requestPrefixes: Array<keyof typeof RequestPrefix>;
  gasDropOffLimit: string;
  maxGasLimit: string;
  maxMsgValue: string; // the maximum msgValue, inclusive of the gasDropOffLimit
  // Lowercased ERC20 address -> decimals. Set when the chain accepts token-fee
  // relay payment (ExecutorWithToken deployed).
  allowedFeeTokens?: Record<string, { decimals: number }>;
};

export interface CapabilitiesResponse {
  [chainId: string]: Capabilities;
}

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

export interface QuoteResponse {
  signedQuote: `0x${string}`;
  estimatedCost?: string;
  // Set on EQ03 responses; `estimatedCost` is in this token's base units.
  feeToken?: string;
}

export async function fetchSignedQuote(
  network: Network,
  srcChain: Chain,
  dstChain: Chain,
  relayInstructions: string, // TODO: `0x:${string}`
  feeToken?: string
): Promise<QuoteResponse> {
  const url = `${apiBaseUrl[network]}/v0/quote`;

  try {
    const response = await axios.post<QuoteResponse>(url, {
      srcChain: toChainId(srcChain),
      dstChain: toChainId(dstChain),
      relayInstructions,
      ...(feeToken ? { feeToken } : {}),
    });
    return response.data;
  } catch (error) {
    throw new Error(`Failed to fetch signed quote.`);
  }
}

export interface StatusResponse extends RelayData {
  signedQuote: SignedQuote;
  estimatedCost: string;
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

const EQ01_PREFIX = 0x45513031;
const EQ03_PREFIX = 0x45513033;

const sharedQuoteBody = [
  { name: "quoterAddress", binary: "bytes", size: 20 },
  { name: "payeeAddress", binary: "bytes", size: 32 },
  { name: "srcChain", binary: "uint", size: 2 },
  { name: "dstChain", binary: "uint", size: 2 },
  { name: "expiryTime", binary: "uint", size: 8 },
  { name: "baseFee", binary: "uint", size: 8 },
  { name: "dstGasPrice", binary: "uint", size: 8 },
  { name: "srcPrice", binary: "uint", size: 8 },
  { name: "dstPrice", binary: "uint", size: 8 },
] as const;

const signatureItem = { name: "signature", binary: "bytes", size: 65 } as const;

export const signedQuoteWithTokenLayout = [
  {
    name: "quote",
    binary: "switch",
    idSize: 4,
    idTag: "prefix",
    layouts: [
      [
        [EQ01_PREFIX, "EQ01"],
        [...sharedQuoteBody, signatureItem],
      ],
      [
        [EQ03_PREFIX, "EQ03"],
        [
          ...sharedQuoteBody,
          { name: "srcToken", binary: "bytes", size: 32 },
          signatureItem,
        ],
      ],
    ],
  },
] as const satisfies Layout;

export function deserializeSignedQuoteWithToken(signedQuoteBytes: Uint8Array): {
  payeeAddress: Uint8Array;
  expiryTime: Date;
} {
  const { quote } = deserializeLayout(
    signedQuoteWithTokenLayout,
    signedQuoteBytes
  );
  return {
    payeeAddress: quote.payeeAddress,
    expiryTime: new Date(Number(quote.expiryTime) * 1000),
  };
}
