import {
  Chain,
  Network,
  TransferState,
  isFailed,
  routes,
  isAttested,
} from "@wormhole-foundation/sdk-connect";
import { MultiTokenNtt, Ntt } from "@wormhole-foundation/sdk-definitions-ntt";
import { MultiTokenNttRoute } from "./types.js";
import {
  getAxelarTransactionStatus,
  getAxelarExplorerUrl,
} from "@wormhole-foundation/sdk-evm-ntt";

export async function trackExecutor<
  R extends MultiTokenNttRoute.ManualTransferReceipt
>(
  network: Network,
  receipt: R,
  destinationNtt: MultiTokenNtt<Network, Chain>,
  wormholeTransceiver: Ntt.TransceiverMeta
): Promise<R> {
  if (!isAttested(receipt) && !isFailed(receipt)) {
    return receipt;
  }

  if (!receipt.attestation) {
    throw new Error("No attestation found on the transfer receipt");
  }

  const wormholeAttested = await destinationNtt.transceiverAttestedToMessage(
    receipt.from,
    receipt.attestation.attestation.payload.nttManagerPayload,
    wormholeTransceiver.index
  );

  if (wormholeAttested) {
    return isFailed(receipt)
      ? {
          ...receipt,
          state: TransferState.Attested,
          // reset the error if we were previously failed
          // @ts-ignore
          error: undefined,
        }
      : receipt;
  }

  // Check if the relay was successful or failed
  const txid = receipt.originTxs.at(-1)!.txid;
  const [txStatus] = await fetchStatus(network, txid, receipt.from);
  if (!txStatus) throw new Error("No transaction status found");

  const relayStatus = txStatus.status;
  if (
    relayStatus === RelayStatus.Failed || // this could happen if simulation fails
    relayStatus === RelayStatus.Underpaid || // only happens if you don't pay at least the costEstimate
    relayStatus === RelayStatus.Unsupported || // capabilities check didn't pass
    relayStatus === RelayStatus.Aborted // An unrecoverable error indicating the attempt should stop (bad data, pre-flight checks failed, or chain-specific conditions)
  ) {
    receipt = {
      ...receipt,
      state: TransferState.Failed,
      error: new routes.RelayFailedError(
        `Relay failed with status: ${relayStatus}`
      ),
    };
    return receipt;
  }

  // Clear error state if relay status is not an error
  if (isFailed(receipt)) {
    return {
      ...receipt,
      state: TransferState.Attested,
      // @ts-ignore
      error: undefined,
    };
  }

  return receipt;
}

export async function trackAxelar<
  R extends MultiTokenNttRoute.ManualTransferReceipt
>(
  network: Network,
  receipt: R,
  destinationNtt: MultiTokenNtt<Network, Chain>,
  axelarTransceiver: Ntt.TransceiverMeta
): Promise<R> {
  if (!isAttested(receipt) && !isFailed(receipt)) {
    return receipt;
  }

  if (!receipt.attestation) {
    throw new Error("No attestation found on the transfer receipt");
  }

  const axelarAttested = await destinationNtt.transceiverAttestedToMessage(
    receipt.from,
    receipt.attestation.attestation.payload.nttManagerPayload,
    axelarTransceiver.index
  );

  if (axelarAttested) {
    return isFailed(receipt)
      ? {
          ...receipt,
          state: TransferState.Attested,
          // reset the error if we were previously failed
          error: undefined,
        }
      : receipt;
  }

  // Check relayer status
  const txid = receipt.originTxs.at(-1)!.txid;
  const axelarStatus = await getAxelarTransactionStatus(
    network,
    receipt.from,
    txid
  );

  if (axelarStatus.error) {
    return {
      ...receipt,
      state: TransferState.Failed,
      error: new routes.RelayFailedError(
        `Axelar error: ${axelarStatus.error.message}`,
        // TODO: remove
        // @ts-ignore
        {
          url: getAxelarExplorerUrl(network, txid),
          explorerName: "Axelarscan",
        }
      ),
    };
  }

  // Clear error state if relay status is not an error
  if (isFailed(receipt)) {
    return {
      ...receipt,
      state: TransferState.Attested,
      // @ts-ignore
      error: undefined,
    };
  }

  return receipt;
}
