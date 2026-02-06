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

  it("formats zero-decimal values with trailing dot", () => {
    expect(formatNumber(0n, 0)).toBe("0.");
    expect(formatNumber(5n, 0)).toBe("5.");
    expect(formatNumber(1234n, 0)).toBe("1234.");
  });

  it("always includes a single dot with the expected fractional length", () => {
    const cases = [0n, 1n, 9n, 10n, 99n, 100n, 999n, 1000n, 123456n];
    for (let decimals = 1; decimals <= 6; decimals += 1) {
      for (const num of cases) {
        const formatted = formatNumber(num, decimals);
        const parts = formatted.split(".");
        expect(parts).toHaveLength(2);
        expect(parts[1]?.length).toBe(decimals);
      }
    }
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
    expect(isValidLimit("", 2)).toBe(false);
    expect(isValidLimit("10.0.0", 2)).toBe(false);
    expect(isValidLimit("10..", 2)).toBe(false);
    expect(isValidLimit(".10", 2)).toBe(false);
    expect(isValidLimit("10.a", 2)).toBe(false);
    expect(isValidLimit("10", 0)).toBe(true);
    expect(isValidLimit("10.", 0)).toBe(true);
  });

  it("detects zero-like limits", () => {
    expect(isZeroLimit("0")).toBe(true);
    expect(isZeroLimit("0.0")).toBe(true);
    expect(isZeroLimit("00.000")).toBe(true);
    expect(isZeroLimit("1.0")).toBe(false);
  });
});
