import { TrimmedAmount } from "./layouts/amount.js";

export type EncodedTrimmedAmount = bigint; // uint72

export function decodeTrimmedAmount(
  encoded: EncodedTrimmedAmount
): TrimmedAmount {
  const decimals = Number(encoded & 0xffn);
  const amount = encoded >> 8n;
  return {
    amount,
    decimals,
  };
}

export function untrim(trimmed: TrimmedAmount, toDecimals: number): bigint {
  const { amount, decimals: fromDecimals } = trimmed;
  return scale(amount, fromDecimals, toDecimals);
}

export function scale(
  amount: bigint,
  fromDecimals: number,
  toDecimals: number
): bigint {
  if (fromDecimals == toDecimals) {
    return amount;
  }

  if (fromDecimals > toDecimals) {
    return amount / 10n ** BigInt(fromDecimals - toDecimals);
  } else {
    return amount * 10n ** BigInt(toDecimals - fromDecimals);
  }
}
