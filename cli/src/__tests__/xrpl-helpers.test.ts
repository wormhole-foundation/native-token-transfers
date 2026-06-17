import { describe, expect, test } from "bun:test";
import {
  XRPL_ENDPOINTS,
  loadMetadataHex,
  loadSeed,
  normalizeCurrency,
  parseMptFlags,
  resolveXrplEndpoint,
  validateMptIssuanceParams,
} from "../xrpl/helpers";

describe("parseMptFlags", () => {
  test("returns 0 for empty/undefined input", () => {
    expect(parseMptFlags(undefined)).toBe(0);
    expect(parseMptFlags("")).toBe(0);
  });

  test("parses a single named flag", () => {
    expect(parseMptFlags("tfMPTCanTransfer")).toBe(0x0020);
  });

  test("ORs multiple named flags (with whitespace)", () => {
    expect(parseMptFlags("tfMPTCanTransfer, tfMPTCanClawback")).toBe(
      0x0020 | 0x0040
    );
  });

  test("accepts raw decimal and hex integers", () => {
    expect(parseMptFlags("96")).toBe(96);
    expect(parseMptFlags("0x60")).toBe(0x60);
  });

  test("throws on an unknown flag name", () => {
    expect(() => parseMptFlags("tfNope")).toThrow(/Unknown MPT flag/);
  });
});

describe("normalizeCurrency", () => {
  test("passes through a 3-char ASCII code", () => {
    expect(normalizeCurrency("FOO")).toBe("FOO");
  });

  test("uppercases and accepts a 40-char hex code", () => {
    const hex = "524c555344000000000000000000000000000000"; // RLUSD
    expect(normalizeCurrency(hex)).toBe(hex.toUpperCase());
  });

  test("rejects other lengths / non-hex", () => {
    expect(() => normalizeCurrency("RLUSD")).toThrow(/Invalid currency/);
    expect(() => normalizeCurrency("ZZ")).toThrow(/Invalid currency/);
  });
});

describe("loadMetadataHex", () => {
  test("returns undefined when no input given", () => {
    expect(loadMetadataHex(undefined)).toBeUndefined();
  });

  test("hex-encodes inline JSON (round-trips)", () => {
    const hex = loadMetadataHex('{"n":"BAR"}');
    expect(hex).toBeDefined();
    expect(JSON.parse(Buffer.from(hex!, "hex").toString("utf8"))).toEqual({
      n: "BAR",
    });
  });

  test("throws on invalid JSON", () => {
    expect(() => loadMetadataHex("not json")).toThrow(/valid JSON/);
  });

  test("throws when the encoded blob exceeds 1024 bytes", () => {
    const big = JSON.stringify({ d: "x".repeat(1100) });
    expect(() => loadMetadataHex(big)).toThrow(/1024 bytes/);
  });
});

describe("validateMptIssuanceParams", () => {
  const ok = { assetScale: 0, transferFee: 0, flags: 0 };

  test("accepts valid defaults", () => {
    expect(() => validateMptIssuanceParams(ok)).not.toThrow();
  });

  test("rejects out-of-range asset scale", () => {
    expect(() =>
      validateMptIssuanceParams({ ...ok, assetScale: 256 })
    ).toThrow(/asset-scale/);
  });

  test("rejects out-of-range transfer fee", () => {
    expect(() =>
      validateMptIssuanceParams({ ...ok, transferFee: 50001, flags: 0x0020 })
    ).toThrow(/transfer-fee/);
  });

  test("requires tfMPTCanTransfer when transfer fee is set", () => {
    expect(() =>
      validateMptIssuanceParams({ ...ok, transferFee: 100, flags: 0 })
    ).toThrow(/tfMPTCanTransfer/);
    // with the flag set, the same fee is fine
    expect(() =>
      validateMptIssuanceParams({ ...ok, transferFee: 100, flags: 0x0020 })
    ).not.toThrow();
  });

  test("validates maxAmount: integer, > 0, within UInt64 ceiling", () => {
    expect(() =>
      validateMptIssuanceParams({ ...ok, maxAmount: "1000000" })
    ).not.toThrow();
    expect(() =>
      validateMptIssuanceParams({ ...ok, maxAmount: "0" })
    ).toThrow(/greater than 0/);
    expect(() =>
      validateMptIssuanceParams({ ...ok, maxAmount: "1.5" })
    ).toThrow(/non-negative integer/);
    expect(() =>
      validateMptIssuanceParams({ ...ok, maxAmount: (2n ** 63n).toString() })
    ).toThrow(/2\^63/);
  });
});

describe("loadSeed", () => {
  test("prefers the flag value", () => {
    expect(loadSeed("sFlag", "seed", "XRPL_TEST_SEED_UNSET")).toBe("sFlag");
  });

  test("falls back to the env var", () => {
    process.env.XRPL_TEST_SEED = "sEnv";
    expect(loadSeed(undefined, "seed", "XRPL_TEST_SEED")).toBe("sEnv");
    delete process.env.XRPL_TEST_SEED;
  });

  test("throws when neither flag nor env is present", () => {
    expect(() => loadSeed(undefined, "seed", "XRPL_TEST_SEED_UNSET")).toThrow(
      /Missing seed/
    );
  });
});

describe("resolveXrplEndpoint", () => {
  test("uses the network default when nothing else is provided", () => {
    expect(resolveXrplEndpoint("Testnet")).toBe(XRPL_ENDPOINTS.Testnet);
  });

  test("--rpc override wins over everything", () => {
    expect(resolveXrplEndpoint("Mainnet", "wss://custom", undefined)).toBe(
      "wss://custom"
    );
  });

  test("falls back to overrides.json (chains.Xrpl.rpc) before the default", () => {
    const overrides = { chains: { Xrpl: { rpc: "wss://override" } } } as any;
    expect(resolveXrplEndpoint("Mainnet", undefined, overrides)).toBe(
      "wss://override"
    );
  });
});
