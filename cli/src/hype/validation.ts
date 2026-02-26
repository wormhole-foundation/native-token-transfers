import { ethers } from "ethers";

export function parseIntegerInRange(
  name: string,
  value: number,
  min: number,
  max?: number
): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  if (value < min) {
    throw new Error(`${name} must be >= ${min}`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`${name} must be <= ${max}`);
  }
  return value;
}

export function parsePositiveDecimalAmount(
  name: string,
  value: string
): string {
  const trimmed = value.trim();
  if (!/^(?:\d+(\.\d+)?|\.\d+)$/.test(trimmed)) {
    throw new Error(
      `${name} must be a positive decimal string (examples: '1', '1.0', '0.5', '.5')`
    );
  }
  const digits = trimmed.replace(".", "");
  if (!/[1-9]/.test(digits)) {
    throw new Error(`${name} must be greater than zero`);
  }
  return trimmed;
}

export function parseEvmAddress(name: string, value: string): string {
  if (!ethers.isAddress(value)) {
    throw new Error(`${name} must be a valid EVM address`);
  }
  return value;
}
