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

export function encodeTrimmedAmount(
  trimmed: TrimmedAmount
): EncodedTrimmedAmount {
  const { amount, decimals } = trimmed;
  if (decimals < 0 || decimals > 255) {
    throw new Error("decimals out of range");
  }
  if (amount < 0n || amount >= 1n << 64n) {
    throw new Error("amount out of range");
  }
  return (amount << 8n) | BigInt(decimals);
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
