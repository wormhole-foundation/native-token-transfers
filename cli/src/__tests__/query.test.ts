import { describe, expect, test } from "bun:test";
import { formatNumber, checkNumberFormatting } from "../query";

describe("formatNumber", () => {
  test("formats zero with correct decimal places", () => {
    expect(formatNumber(0n, 18)).toBe("0." + "0".repeat(18));
    expect(formatNumber(0n, 9)).toBe("0." + "0".repeat(9));
    expect(formatNumber(0n, 6)).toBe("0." + "0".repeat(6));
  });

  test("formats 1 token (10^18 wei) with 18 decimals", () => {
    expect(formatNumber(1000000000000000000n, 18)).toBe(
      "1.000000000000000000"
    );
  });

  test("formats fractional amounts with leading zero", () => {
    // 0.5 tokens = 5 * 10^17
    expect(formatNumber(500000000000000000n, 18)).toBe(
      "0.500000000000000000"
    );
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

  test("formats very small amounts (no zero-padding)", () => {
    // formatNumber does not zero-pad the fractional part for values shorter
    // than `decimals` digits — the slice just takes whatever digits exist.
    // 1 wei with 18 decimals: str="1", slice(-18)="1" → "0.1"
    expect(formatNumber(1n, 18)).toBe("0.1");
    // 100 wei: str="100", slice(-18)="100" → "0.100"
    expect(formatNumber(100n, 18)).toBe("0.100");
  });

  test("formats amounts with mixed integer and fractional parts", () => {
    // 123.456 tokens (18 decimals)
    expect(formatNumber(123456000000000000000n, 18)).toBe(
      "123.456000000000000000"
    );
  });
});

describe("checkNumberFormatting", () => {
  test("returns true for correctly formatted 18-decimal number", () => {
    expect(checkNumberFormatting("1.000000000000000000", 18)).toBe(true);
    expect(checkNumberFormatting("0.500000000000000000", 18)).toBe(true);
    expect(checkNumberFormatting("1000.000000000000000000", 18)).toBe(true);
  });

  test("returns true for correctly formatted 9-decimal number", () => {
    expect(checkNumberFormatting("1.000000000", 9)).toBe(true);
  });

  test("returns false for wrong number of decimals", () => {
    expect(checkNumberFormatting("1.00", 18)).toBe(false);
    expect(checkNumberFormatting("1.0000000000000000000", 18)).toBe(false); // 19 decimals
  });

  test("returns false for no decimal point", () => {
    expect(checkNumberFormatting("1000", 18)).toBe(false);
  });

  test("returns false for multiple decimal points", () => {
    expect(checkNumberFormatting("1.000.000", 6)).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(checkNumberFormatting("", 18)).toBe(false);
  });
});
