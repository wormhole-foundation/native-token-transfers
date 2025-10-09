import {
  Network,
  TransferState,
  isFailed,
  routes,
  isAttested,
} from "@wormhole-foundation/sdk-connect";
import { MultiTokenNttRoute } from "./types.js";
import {
  getAxelarTransactionStatus,
  getAxelarExplorerUrl,
} from "@wormhole-foundation/sdk-evm-ntt";
import { fetchStatus, isRelayStatusFailed } from "./executor/utils.js";

export async function trackExecutor<
  R extends MultiTokenNttRoute.TransferReceipt
>(network: Network, receipt: R): Promise<R> {
  if (!isAttested(receipt) && !isFailed(receipt)) {
    return receipt;
  }

  // Check if the relay was successful or failed
  const txid = receipt.originTxs.at(-1)!.txid;
  const [txStatus] = await fetchStatus(network, txid, receipt.from);
  if (!txStatus) throw new Error("No transaction status found");

  const relayStatus = txStatus.status;
  if (isRelayStatusFailed(relayStatus)) {
    return {
      ...receipt,
      state: TransferState.Failed,
      error: new routes.RelayFailedError(
        `Relay failed with status: ${relayStatus}`
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

export async function trackAxelar<
  R extends MultiTokenNttRoute.TransferReceipt
>(network: Network, receipt: R): Promise<R> {
  if (!isAttested(receipt) && !isFailed(receipt)) {
    return receipt;
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
        // @ts-ignore
        {
          url: getAxelarExplorerUrl(network, txid),
          name: "Axelarscan",
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
