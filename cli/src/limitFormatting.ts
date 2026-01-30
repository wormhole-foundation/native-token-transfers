export function formatNumber(num: bigint, decimals: number): string {
  const str = num.toString();
  if (decimals === 0) {
    return num === 0n ? "0." : `0.${str}`;
  }
  const padded = str.padStart(decimals + 1, "0");
  const splitIndex = padded.length - decimals;
  return `${padded.slice(0, splitIndex)}.${padded.slice(splitIndex)}`;
}

export function checkNumberFormatting(
  formatted: string,
  decimals: number
): boolean {
  const parts = formatted.split(".");
  if (parts.length !== 2) {
    return false;
  }
  const fraction = parts[1];
  if (fraction === undefined) {
    return false;
  }
  if (fraction.length !== decimals) {
    return false;
  }
  return true;
}

export function getDecimalsFromLimit(limit: string): number | null {
  const parts = limit.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const fraction = parts[1];
  if (fraction === undefined) {
    return null;
  }
  return fraction.length;
}

export function isZeroLimit(value: string): boolean {
  const normalized = value.replace(/\./g, "");
  return normalized.length === 0 || /^0+$/.test(normalized);
}

export function isValidLimit(value: string, decimals: number): boolean {
  if (decimals === 0) {
    return /^\d+$/.test(value);
  }
  const parts = value.split(".");
  if (parts.length !== 2) {
    return false;
  }
  const [whole, fraction] = parts;
  if (
    whole === undefined ||
    fraction === undefined ||
    fraction.length !== decimals
  ) {
    return false;
  }
  return /^\d+$/.test(whole) && /^\d+$/.test(fraction);
}
