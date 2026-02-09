import { describe, expect, test } from "bun:test";
import { cargoNetworkFeature } from "../solana-helpers";

describe("cargoNetworkFeature", () => {
  test("returns mainnet for Mainnet", () => {
    expect(cargoNetworkFeature("Mainnet")).toBe("mainnet");
  });

  test("returns solana-devnet for Testnet", () => {
    expect(cargoNetworkFeature("Testnet")).toBe("solana-devnet");
  });

  test("returns tilt-devnet for Devnet", () => {
    expect(cargoNetworkFeature("Devnet")).toBe("tilt-devnet");
  });

  test("throws for unsupported network", () => {
    expect(() => cargoNetworkFeature("InvalidNetwork" as any)).toThrow(
      "Unsupported network"
    );
  });
});
