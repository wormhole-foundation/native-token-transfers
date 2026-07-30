import { describe, it, expect } from "bun:test";
import { canUpgrade } from "../upgradeBarriers";

describe("canUpgrade", () => {
  it("blocks a Solana v3 -> v4 upgrade across the barrier", () => {
    const check = canUpgrade("Solana", "3.0.0", "4.0.0");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("v4");
  });

  it("blocks a Solana v4 -> v3 downgrade across the barrier", () => {
    // Regression: the barrier must hold in both directions. A downgrade would
    // run v3 bytecode against the v4 account layout and strand the deployment.
    const check = canUpgrade("Solana", "4.0.0", "3.0.0");
    expect(check.ok).toBe(false);
  });

  it("permits a Solana upgrade that stays below the barrier", () => {
    expect(canUpgrade("Solana", "2.0.0", "3.0.0").ok).toBe(true);
  });

  it("permits a Solana upgrade that stays at or above the barrier", () => {
    expect(canUpgrade("Solana", "4.0.0", "4.1.0").ok).toBe(true);
  });

  it("permits a local (null target) version change", () => {
    expect(canUpgrade("Solana", "3.0.0", null).ok).toBe(true);
  });

  it("does not block a chain that has no registered barrier", () => {
    // Only Solana has a v4 barrier registered; EVM crossing majors is allowed.
    expect(canUpgrade("Ethereum", "3.0.0", "4.0.0").ok).toBe(true);
  });
});
