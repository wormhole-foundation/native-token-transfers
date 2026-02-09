import { describe, expect, test } from "bun:test";
import {
  ensurePlatformSupported,
  validatePayerOption,
  normalizeRpcArgs,
  validateTimeout,
  SUPPORTED_PLATFORMS,
  retryWithExponentialBackoff,
} from "../validation";

describe("SUPPORTED_PLATFORMS", () => {
  test("contains Evm, Solana, Sui", () => {
    expect(SUPPORTED_PLATFORMS.has("Evm")).toBe(true);
    expect(SUPPORTED_PLATFORMS.has("Solana")).toBe(true);
    expect(SUPPORTED_PLATFORMS.has("Sui")).toBe(true);
  });

  test("does not contain unsupported platforms", () => {
    expect(SUPPORTED_PLATFORMS.has("Cosmwasm" as any)).toBe(false);
  });
});

describe("ensurePlatformSupported", () => {
  test("does not throw for EVM chains", () => {
    expect(() => ensurePlatformSupported("Ethereum")).not.toThrow();
    expect(() => ensurePlatformSupported("Sepolia")).not.toThrow();
    expect(() => ensurePlatformSupported("Base")).not.toThrow();
  });

  test("does not throw for Solana", () => {
    expect(() => ensurePlatformSupported("Solana")).not.toThrow();
  });

  test("does not throw for Sui", () => {
    expect(() => ensurePlatformSupported("Sui")).not.toThrow();
  });

  test("throws for unsupported chains with default error factory", () => {
    expect(() => ensurePlatformSupported("Cosmoshub" as any)).toThrow();
  });

  test("uses custom error factory", () => {
    const customFactory = (msg: string) => new TypeError(msg);
    expect(() =>
      ensurePlatformSupported("Cosmoshub" as any, customFactory)
    ).toThrow(TypeError);
  });
});

describe("validatePayerOption", () => {
  const errorFactory = (msg: string) => new Error(msg);

  test("returns undefined when rawPayer is undefined", () => {
    expect(validatePayerOption(undefined, "Solana", errorFactory)).toBeUndefined();
  });

  test("throws when rawPayer is an array", () => {
    expect(() =>
      validatePayerOption(["a", "b"], "Solana", errorFactory)
    ).toThrow("--payer may only be specified once");
  });

  test("throws when rawPayer is empty string", () => {
    expect(() =>
      validatePayerOption("", "Solana", errorFactory)
    ).toThrow("--payer must be a path");
  });

  test("warns and returns undefined for non-Solana chains", () => {
    const warnings: string[] = [];
    const result = validatePayerOption(
      "/some/path",
      "Ethereum",
      errorFactory,
      (msg) => warnings.push(msg)
    );
    expect(result).toBeUndefined();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("only used when the source chain is Solana");
  });
});

describe("normalizeRpcArgs", () => {
  const errorFactory = (msg: string) => new Error(msg);

  test("returns undefined when rawRpc is undefined", () => {
    expect(normalizeRpcArgs(undefined, errorFactory)).toBeUndefined();
  });

  test("returns undefined when rawRpc is falsy", () => {
    expect(normalizeRpcArgs(null, errorFactory)).toBeUndefined();
    expect(normalizeRpcArgs("", errorFactory)).toBeUndefined();
  });

  test("wraps single string in array", () => {
    expect(normalizeRpcArgs("Sepolia=http://localhost:8545", errorFactory)).toEqual([
      "Sepolia=http://localhost:8545",
    ]);
  });

  test("passes through array", () => {
    const input = ["Sepolia=http://a", "Base=http://b"];
    expect(normalizeRpcArgs(input, errorFactory)).toEqual(input);
  });

  test("trims whitespace", () => {
    expect(normalizeRpcArgs("  Sepolia=http://a  ", errorFactory)).toEqual([
      "Sepolia=http://a",
    ]);
  });

  test("throws for empty array", () => {
    expect(() => normalizeRpcArgs([], errorFactory)).toThrow("--rpc expects");
  });
});

describe("validateTimeout", () => {
  const errorFactory = (msg: string) => new Error(msg);

  test("returns undefined when not provided", () => {
    expect(validateTimeout(undefined, false, errorFactory)).toBeUndefined();
  });

  test("returns the number when valid", () => {
    expect(validateTimeout(30, true, errorFactory)).toBe(30);
    expect(validateTimeout(0.5, true, errorFactory)).toBe(0.5);
  });

  test("throws for negative timeout", () => {
    expect(() => validateTimeout(-1, true, errorFactory)).toThrow("positive");
  });

  test("throws for zero timeout", () => {
    expect(() => validateTimeout(0, true, errorFactory)).toThrow("positive");
  });

  test("throws for NaN", () => {
    expect(() => validateTimeout(NaN, true, errorFactory)).toThrow("numeric");
  });

  test("throws for null when provided", () => {
    expect(() => validateTimeout(null, true, errorFactory)).toThrow("numeric");
  });

  test("throws for array", () => {
    expect(() => validateTimeout([30], true, errorFactory)).toThrow("numeric");
  });
});

describe("retryWithExponentialBackoff", () => {
  test("returns result on first success", async () => {
    const result = await retryWithExponentialBackoff(
      async () => 42,
      3,
      10
    );
    expect(result).toBe(42);
  });

  test("retries on failure then succeeds", async () => {
    let attempts = 0;
    const result = await retryWithExponentialBackoff(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("fail");
        return "ok";
      },
      5,
      10
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  test("throws after max retries exceeded", async () => {
    let attempts = 0;
    await expect(
      retryWithExponentialBackoff(
        async () => {
          attempts++;
          throw new Error("always fails");
        },
        2,
        10
      )
    ).rejects.toThrow("always fails");
    // 1 initial + 2 retries = 3 attempts
    expect(attempts).toBe(3);
  });
});
