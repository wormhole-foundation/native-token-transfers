export function formatNumber(num: bigint, decimals: number): string {
  if (num === 0n) {
    return "0." + "0".repeat(decimals);
  }
  const str = num.toString();
  const formatted = str.slice(0, -decimals) + "." + str.slice(-decimals);
  if (formatted.startsWith(".")) {
    return "0" + formatted;
  }
  return formatted;
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
