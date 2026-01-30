import {
  checkNumberFormatting,
  formatNumber,
  isValidLimit,
  isZeroLimit,
} from "../src/limitFormatting";

describe("limitFormatting helpers", () => {
  it("formats numbers with the expected decimal precision", () => {
    expect(formatNumber(0n, 2)).toBe("0.00");
    expect(formatNumber(1234n, 2)).toBe("12.34");
    expect(formatNumber(5n, 1)).toBe("0.5");
    expect(formatNumber(5n, 2)).toBe("0.05");
  });

  it("preserves legacy zero-precision formatting", () => {
    // Legacy formatting keeps a trailing dot for zero precision.
    expect(formatNumber(0n, 0)).toBe("0.");
    // Historical behavior uses a leading zero and dot for non-zero values.
    expect(formatNumber(1234n, 0)).toBe("0.1234");
  });

  it("checks decimal formatting length", () => {
    expect(checkNumberFormatting("10.00", 2)).toBe(true);
    expect(checkNumberFormatting("10.0", 2)).toBe(false);
    expect(checkNumberFormatting("10", 2)).toBe(false);
  });

  it("validates numeric formatting and decimal precision", () => {
    expect(isValidLimit("10.00", 2)).toBe(true);
    expect(isValidLimit("10.0", 2)).toBe(false);
    expect(isValidLimit("aa.bb", 2)).toBe(false);
    expect(isValidLimit("10", 0)).toBe(true);
    expect(isValidLimit("10.", 0)).toBe(false);
  });

  it("detects zero-like limits", () => {
    expect(isZeroLimit("0")).toBe(true);
    expect(isZeroLimit("0.0")).toBe(true);
    expect(isZeroLimit("00.000")).toBe(true);
    expect(isZeroLimit("1.0")).toBe(false);
  });
});
