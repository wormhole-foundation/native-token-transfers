import {
  toDecimalValue,
  prepareAmount,
  toXrplAddress,
  xrplAddressToUniversalBytes,
} from "../utils.js";
import { encoding } from "@wormhole-foundation/sdk-base";
import type { Contracts } from "@wormhole-foundation/sdk-definitions";
import type { Ntt } from "@wormhole-foundation/sdk-definitions-ntt";

function makeContracts(token: string): Contracts & { ntt?: Ntt.Contracts } {
  return {
    ntt: { token, manager: "0x00" } as unknown as Ntt.Contracts,
  } as Contracts & { ntt?: Ntt.Contracts };
}

describe("toDecimalValue", () => {
  it("converts with 9 decimals", () => {
    expect(toDecimalValue(1000n, 9)).toBe("0.000001");
  });

  it("converts with 6 decimals", () => {
    expect(toDecimalValue(1_000_000n, 6)).toBe("1");
  });

  it("converts with 6 decimals and fractional part", () => {
    expect(toDecimalValue(1_500_000n, 6)).toBe("1.5");
  });

  it("handles 0 decimals", () => {
    expect(toDecimalValue(42n, 0)).toBe("42");
  });

  it("handles zero amount", () => {
    expect(toDecimalValue(0n, 6)).toBe("0");
  });

  it("handles amount smaller than one unit", () => {
    expect(toDecimalValue(1n, 8)).toBe("0.00000001");
  });

  it("strips trailing zeros", () => {
    expect(toDecimalValue(100n, 6)).toBe("0.0001");
  });

  it("handles large amounts", () => {
    expect(toDecimalValue(123_456_789_000_000_000n, 15)).toBe("123.456789");
  });

  it("handles 18 decimals", () => {
    expect(toDecimalValue(1_000_000_000_000_000_000n, 18)).toBe("1");
  });
});

describe("prepareAmount", () => {
  it("returns string for native token", () => {
    const result = prepareAmount(1000n, makeContracts("native"), 6);
    expect(result).toBe("1000");
  });

  it("returns IssuedCurrencyAmount for IOU token", () => {
    const result = prepareAmount(
      1_000_000n,
      makeContracts("FOO.rBa2jdUu8S2ZzaCJv8y1Lx9Pdrns51hJj"),
      6
    );
    expect(result).toEqual({
      currency: "FOO",
      issuer: "rBa2jdUu8S2ZzaCJv8y1Lx9Pdrns51hJj",
      value: "1",
    });
  });

  it("returns decimal value for IOU with fractional amount", () => {
    const result = prepareAmount(1000n, makeContracts("USD.rIssuer123"), 9);
    expect(result).toEqual({
      currency: "USD",
      issuer: "rIssuer123",
      value: "0.000001",
    });
  });

  it("returns MPTAmount for 48-char hex token", () => {
    const mptId = "00ef0c086c1b25b6a159b32b05b9ae9be1d6c960951a644f";
    const result = prepareAmount(500n, makeContracts(mptId), 6);
    expect(result).toEqual({
      mpt_issuance_id: mptId,
      value: "500",
    });
  });

  it("throws for unrecognized token format", () => {
    expect(() => prepareAmount(1n, makeContracts("unknown"), 6)).toThrow(
      "unsupported token: unknown"
    );
  });

  it("rejects hex string that is not 48 characters", () => {
    expect(() => prepareAmount(1n, makeContracts("abcdef1234"), 6)).toThrow(
      "unsupported token"
    );
  });
});

describe("toXrplAddress", () => {
  it("converts a known hex to the expected r-address", () => {
    const rAddr = "rfeMQr71KJQwNUbRwGTgCfVLoUVdWuvyny";
    const hex = "0x" + encoding.hex.encode(xrplAddressToUniversalBytes(rAddr));
    expect(toXrplAddress(hex)).toBe(rAddr);
  });

  it("returns an r-address unchanged", () => {
    const rAddr = "rfeMQr71KJQwNUbRwGTgCfVLoUVdWuvyny";
    expect(toXrplAddress(rAddr)).toBe(rAddr);
  });

  it("handles hex without 0x prefix", () => {
    const hex =
      "00000000000000000000000049cc1fc419e6e4a3c1a135db3baee3b01adaf84b";
    const result = toXrplAddress(hex);
    expect(result).toMatch(/^r[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it("produces the same r-address from hex and r-address round-trip", () => {
    const hex =
      "0x00000000000000000000000049cc1fc419e6e4a3c1a135db3baee3b01adaf84b";
    const fromHex = toXrplAddress(hex);
    expect(toXrplAddress(fromHex)).toBe(fromHex);
  });
});

describe("xrplAddressToUniversalBytes", () => {
  it("converts an r-address to 32 zero-padded bytes", () => {
    const rAddr = "rfeMQr71KJQwNUbRwGTgCfVLoUVdWuvyny";
    const bytes = xrplAddressToUniversalBytes(rAddr);
    expect(bytes.length).toBe(32);
    // First 12 bytes should be zero padding
    expect(bytes.slice(0, 12)).toEqual(new Uint8Array(12));
  });

  it("converts a hex universal address to raw bytes", () => {
    const hex =
      "0x00000000000000000000000049cc1fc419e6e4a3c1a135db3baee3b01adaf84b";
    const bytes = xrplAddressToUniversalBytes(hex);
    expect(bytes.length).toBe(32);
    expect(encoding.hex.encode(bytes)).toBe(hex.replace(/^0x/, ""));
  });

  it("round-trips: r-address -> universal bytes -> r-address", () => {
    const rAddr = "rfeMQr71KJQwNUbRwGTgCfVLoUVdWuvyny";
    const bytes = xrplAddressToUniversalBytes(rAddr);
    const hex = encoding.hex.encode(bytes);
    const result = toXrplAddress(hex);
    expect(result).toBe(rAddr);
  });
});
