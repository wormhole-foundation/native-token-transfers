import { describe, test, expect } from "bun:test";
import {
  parseEvmAddress,
  parseIntegerInRange,
  parsePositiveDecimalAmount,
} from "../validation";

describe("hype validation helpers", () => {
  test("parseIntegerInRange accepts valid values", () => {
    expect(parseIntegerInRange("value", 0, 0, 10)).toBe(0);
    expect(parseIntegerInRange("value", 10, 0, 10)).toBe(10);
    expect(parseIntegerInRange("value", 7, 0)).toBe(7);
  });

  test("parseIntegerInRange rejects invalid values", () => {
    expect(() => parseIntegerInRange("value", 1.5, 0, 10)).toThrow(
      "value must be an integer"
    );
    expect(() => parseIntegerInRange("value", -1, 0, 10)).toThrow(
      "value must be >= 0"
    );
    expect(() => parseIntegerInRange("value", 11, 0, 10)).toThrow(
      "value must be <= 10"
    );
  });

  test("parsePositiveDecimalAmount accepts valid amounts", () => {
    expect(parsePositiveDecimalAmount("amount", "1")).toBe("1");
    expect(parsePositiveDecimalAmount("amount", "1.0")).toBe("1.0");
    expect(parsePositiveDecimalAmount("amount", ".5")).toBe(".5");
    expect(parsePositiveDecimalAmount("amount", " 0.25 ")).toBe("0.25");
  });

  test("parsePositiveDecimalAmount rejects invalid amounts", () => {
    expect(() => parsePositiveDecimalAmount("amount", "0")).toThrow(
      "amount must be greater than zero"
    );
    expect(() => parsePositiveDecimalAmount("amount", "0.000")).toThrow(
      "amount must be greater than zero"
    );
    expect(() => parsePositiveDecimalAmount("amount", "abc")).toThrow(
      "amount must be a positive decimal string"
    );
    expect(() => parsePositiveDecimalAmount("amount", "1e18")).toThrow(
      "amount must be a positive decimal string"
    );
  });

  test("parseEvmAddress accepts valid addresses and rejects invalid ones", () => {
    expect(
      parseEvmAddress("address", "0x1111111111111111111111111111111111111111")
    ).toBe("0x1111111111111111111111111111111111111111");
    expect(() => parseEvmAddress("address", "not-an-address")).toThrow(
      "address must be a valid EVM address"
    );
  });
});
