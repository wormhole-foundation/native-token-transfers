import { describe, expect, test } from "bun:test";
import { formatNumber, checkNumberFormatting } from "../limitFormatting";

describe("formatNumber", () => {
  test("formats zero with full precision", () => {
    expect(formatNumber(0n, 18)).toBe("0.000000000000000000");
    expect(formatNumber(0n, 9)).toBe("0.000000000");
    expect(formatNumber(0n, 6)).toBe("0.000000");
  });

  test("formats 1 token (10^18 wei) with 18 decimals", () => {
    expect(formatNumber(1000000000000000000n, 18)).toBe("1.000000000000000000");
  });

  test("formats fractional amounts", () => {
    // 0.5 tokens = 5 * 10^17
    expect(formatNumber(500000000000000000n, 18)).toBe("0.500000000000000000");
  });

  test("formats large numbers correctly", () => {
    // 1000 tokens
    expect(formatNumber(1000000000000000000000n, 18)).toBe(
      "1000.000000000000000000"
    );
  });

  test("formats with 9 decimals (Solana/Sui style)", () => {
    expect(formatNumber(1000000000n, 9)).toBe("1.000000000");
    expect(formatNumber(500000000n, 9)).toBe("0.500000000");
  });

  test("formats very small amounts correctly", () => {
    // 1 wei with 18 decimals
    expect(formatNumber(1n, 18)).toBe("0.000000000000000001");
    // 100 wei
    expect(formatNumber(100n, 18)).toBe("0.000000000000000100");
  });

  test("formats amounts with mixed integer and fractional parts", () => {
    // 123.456 tokens (18 decimals)
    expect(formatNumber(123456000000000000000n, 18)).toBe(
      "123.456000000000000000"
    );
  });

  test("formats with 0 decimals", () => {
    expect(formatNumber(42n, 0)).toBe("42.");
  });
});

describe("checkNumberFormatting", () => {
  test("returns true for correctly formatted numbers with exact decimal count", () => {
    expect(checkNumberFormatting("1.000000000000000000", 18)).toBe(true);
    expect(checkNumberFormatting("0.500000000000000000", 18)).toBe(true);
    expect(checkNumberFormatting("1000.000000000000000000", 18)).toBe(true);
  });

  test("returns false for short decimal fractions (strict formatting)", () => {
    // New behavior: requires exactly `decimals` digits after the dot
    expect(checkNumberFormatting("1.0", 18)).toBe(false);
    expect(checkNumberFormatting("0.5", 18)).toBe(false);
    expect(checkNumberFormatting("1000.0", 18)).toBe(false);
  });

  test("returns false for integers (no decimal point)", () => {
    expect(checkNumberFormatting("1000", 18)).toBe(false);
    expect(checkNumberFormatting("0", 18)).toBe(false);
  });

  test("returns true for correctly formatted 9-decimal number", () => {
    expect(checkNumberFormatting("1.000000000", 9)).toBe(true);
  });

  test("returns false for short 9-decimal number", () => {
    expect(checkNumberFormatting("1.0", 9)).toBe(false);
  });

  test("returns false for too many decimals", () => {
    expect(checkNumberFormatting("1.0000000000000000001", 18)).toBe(false); // 19 decimals
  });

  test("returns false for multiple decimal points", () => {
    expect(checkNumberFormatting("1.000.000", 6)).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(checkNumberFormatting("", 18)).toBe(false);
  });

  test("returns false for non-numeric input", () => {
    expect(checkNumberFormatting("abc", 18)).toBe(false);
    expect(checkNumberFormatting("1.2.3", 18)).toBe(false);
  });
});
