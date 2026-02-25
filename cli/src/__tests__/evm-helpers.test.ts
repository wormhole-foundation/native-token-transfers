import { describe, expect, test } from "bun:test";
import { getSlowFlag, getGasMultiplier } from "../evm/helpers";

describe("getSlowFlag", () => {
  const slowChains = ["Mezo", "HyperEVM", "XRPLEVM", "CreditCoin"] as const;
  const normalChains = ["Ethereum", "Sepolia", "Base", "Arbitrum"] as const;

  test("returns --slow for known slow chains", () => {
    for (const chain of slowChains) {
      expect(getSlowFlag(chain)).toBe("--slow");
    }
  });

  test("returns empty string for normal chains", () => {
    for (const chain of normalChains) {
      expect(getSlowFlag(chain)).toBe("");
    }
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
