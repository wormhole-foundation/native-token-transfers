import {
  Chain,
  Network,
  toChainId,
  amount as sdkAmount,
  encoding,
  deserializeLayout,
} from "@wormhole-foundation/sdk-base";
import {
  NativeAddress,
  SignedQuote,
  relayInstructionsLayout,
} from "@wormhole-foundation/sdk-definitions";
import { isAttested, Wormhole } from "@wormhole-foundation/sdk-connect";
import axios from "axios";
import { apiBaseUrl } from "./consts.js";
import { NttRoute } from "../types.js";
import { NttExecutorRoute } from "./executor.js";

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

export interface StatusResponse extends RelayData {
  signedQuote: SignedQuote;
  estimatedCost: string;
  requestForExecution: RequestForExecution;
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

export async function getNativeRecipientAddress(
  network: Network,
  receipt: NttExecutorRoute.TransferReceipt
): Promise<NativeAddress<Chain>> {
  if (!isAttested(receipt)) {
    throw new Error(
      "Cannot extract recipient address from unattested transfer"
    );
  }

  // For Stacks, we need to extract from the transaction's relay instructions
  // which will contain the pre-hashed recipient address
  if (receipt.to === "Stacks") {
    const [txStatus] = await fetchStatus(
      network,
      receipt.originTxs.at(-1)!.txid,
      receipt.to
    );

    if (!txStatus) {
      throw new Error("Failed to fetch transaction status");
    }

    const { relayInstructionsBytes } = txStatus.requestForExecution;

    const relayInstructionsDecoded = encoding.hex.decode(
      relayInstructionsBytes
    );

    const relayInstructions = deserializeLayout(
      relayInstructionsLayout,
      relayInstructionsDecoded
    );

    const stacksInstruction = relayInstructions.requests.find(
      ({ request }) => request.type === "StacksNttReceiveInstruction"
    );

    if (
      !stacksInstruction ||
      stacksInstruction.request.type !== "StacksNttReceiveInstruction"
    ) {
      throw new Error(
        "No StacksNttReceiveInstruction found in relay instructions"
      );
    }

    const recipientBytes = stacksInstruction.request.recipient;
    const recipientAddressString = encoding.bytes.decode(recipientBytes);
    return Wormhole.parseAddress("Stacks", recipientAddressString);
  }

  // For other chains, we can extract directly from the VAA payload
  const vaa = receipt.attestation.attestation;
  return Wormhole.parseAddress(
    receipt.to,
    vaa.payload.nttManagerPayload.payload.recipientAddress.toString()
  );
}
