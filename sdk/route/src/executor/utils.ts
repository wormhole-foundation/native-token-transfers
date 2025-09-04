import { amount as sdkAmount } from "@wormhole-foundation/sdk-base";
import { NttRoute } from "../types.js";

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
