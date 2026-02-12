import { describe, expect, test } from "bun:test";
import { getSlowFlag, getGasMultiplier } from "../evm/helpers";

describe("getSlowFlag", () => {
  test("returns --slow for Mezo", () => {
    expect(getSlowFlag("Mezo")).toBe("--slow");
  });

  test("returns --slow for HyperEVM", () => {
    expect(getSlowFlag("HyperEVM")).toBe("--slow");
  });

  test("returns --slow for XRPLEVM", () => {
    expect(getSlowFlag("XRPLEVM")).toBe("--slow");
  });

  test("returns --slow for CreditCoin", () => {
    expect(getSlowFlag("CreditCoin")).toBe("--slow");
  });

  test("returns empty string for Ethereum", () => {
    expect(getSlowFlag("Ethereum")).toBe("");
  });

  test("returns empty string for Sepolia", () => {
    expect(getSlowFlag("Sepolia")).toBe("");
  });

  test("returns empty string for Base", () => {
    expect(getSlowFlag("Base")).toBe("");
  });

  test("returns empty string for Arbitrum", () => {
    expect(getSlowFlag("Arbitrum")).toBe("");
  });
});

describe("getGasMultiplier", () => {
  test("returns empty string when no multiplier provided", () => {
    expect(getGasMultiplier()).toBe("");
    expect(getGasMultiplier(undefined)).toBe("");
  });

  test("returns flag with value when multiplier provided", () => {
    expect(getGasMultiplier(200)).toBe("--gas-estimate-multiplier 200");
    expect(getGasMultiplier(150)).toBe("--gas-estimate-multiplier 150");
  });

  test("handles multiplier of 0", () => {
    expect(getGasMultiplier(0)).toBe("--gas-estimate-multiplier 0");
  });
});
