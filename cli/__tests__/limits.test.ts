import { describe, it, expect, spyOn, afterEach } from "bun:test";
import { collectMissingInboundGroups } from "../src/limits";
import type { Config } from "../src/deployments";

describe("collectMissingInboundGroups", () => {
  const asChainsConfig = (chains: object): Config["chains"] =>
    chains as Config["chains"];

  let warnSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    warnSpy?.mockRestore();
  });

  it("returns empty when new chain is not in config", () => {
    const chainsConfig = asChainsConfig({
      Ethereum: {
        limits: { outbound: "1.00", inbound: {} },
      },
    });

    expect(collectMissingInboundGroups(chainsConfig, "Solana")).toEqual([]);
  });

  it("collects missing inbound limits for pairs involving the new chain", () => {
    const chainsConfig = asChainsConfig({
      Solana: {
        limits: { outbound: "10.00", inbound: {} },
      },
      Ethereum: {
        limits: { outbound: "20.00", inbound: {} },
      },
    });

    const result = collectMissingInboundGroups(chainsConfig, "Solana");

    expect(result).toEqual([
      {
        destination: "Ethereum",
        sources: ["Solana"],
        defaultLimit: "20.00",
        decimals: 2,
      },
      {
        destination: "Solana",
        sources: ["Ethereum"],
        defaultLimit: "10.00",
        decimals: 2,
      },
    ]);
  });

  it("treats zero inbound limits as missing and ignores non-zero values", () => {
    const chainsConfig = asChainsConfig({
      Solana: {
        limits: { outbound: "10.00", inbound: { Ethereum: "0" } },
      },
      Ethereum: {
        limits: { outbound: "20.00", inbound: { Solana: "5.00" } },
      },
    });

    const result = collectMissingInboundGroups(chainsConfig, "Solana");

    expect(result).toEqual([
      {
        destination: "Solana",
        sources: ["Ethereum"],
        defaultLimit: "10.00",
        decimals: 2,
      },
    ]);
  });

  it("warns and skips destinations with malformed outbound limits", () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);

    const chainsConfig = asChainsConfig({
      Solana: {
        limits: { outbound: "10", inbound: {} },
      },
      Ethereum: {
        limits: { outbound: "20.00", inbound: {} },
      },
    });

    const result = collectMissingInboundGroups(chainsConfig, "Solana");

    expect(result).toEqual([
      {
        destination: "Ethereum",
        sources: ["Solana"],
        defaultLimit: "20.00",
        decimals: 2,
      },
    ]);

    expect(warnSpy).toHaveBeenCalled();
    const warningMessage = (warnSpy.mock.calls[0] as any[])[0] as string;
    expect(warningMessage).toContain("Skipping Solana");
  });

  it("handles zero-decimal limits formatted with a trailing dot", () => {
    const chainsConfig = asChainsConfig({
      Solana: {
        limits: { outbound: "5.", inbound: { Ethereum: "0." } },
      },
      Ethereum: {
        limits: { outbound: "7.", inbound: {} },
      },
    });

    const result = collectMissingInboundGroups(chainsConfig, "Solana");

    expect(result).toEqual([
      {
        destination: "Ethereum",
        sources: ["Solana"],
        defaultLimit: "7.",
        decimals: 0,
      },
      {
        destination: "Solana",
        sources: ["Ethereum"],
        defaultLimit: "5.",
        decimals: 0,
      },
    ]);
  });

  it("groups multiple missing sources for a destination involving the new chain", () => {
    const chainsConfig = asChainsConfig({
      Solana: {
        limits: { outbound: "10.00", inbound: {} },
      },
      Ethereum: {
        limits: { outbound: "20.00", inbound: {} },
      },
      Sui: {
        limits: { outbound: "30.00", inbound: {} },
      },
    });

    const result = collectMissingInboundGroups(chainsConfig, "Solana");

    expect(result).toEqual([
      {
        destination: "Ethereum",
        sources: ["Solana"],
        defaultLimit: "20.00",
        decimals: 2,
      },
      {
        destination: "Solana",
        sources: ["Ethereum", "Sui"],
        defaultLimit: "10.00",
        decimals: 2,
      },
      {
        destination: "Sui",
        sources: ["Solana"],
        defaultLimit: "30.00",
        decimals: 2,
      },
    ]);
  });

  it("skips destinations with missing outbound limits but still includes them as sources", () => {
    const chainsConfig = asChainsConfig({
      Solana: {
        limits: { outbound: "10.00", inbound: {} },
      },
      Ethereum: {
        limits: { outbound: "20.00", inbound: {} },
      },
      Sui: {
        limits: { inbound: {} },
      },
    });

    const result = collectMissingInboundGroups(chainsConfig, "Solana");

    expect(result).toEqual([
      {
        destination: "Ethereum",
        sources: ["Solana"],
        defaultLimit: "20.00",
        decimals: 2,
      },
      {
        destination: "Solana",
        sources: ["Ethereum", "Sui"],
        defaultLimit: "10.00",
        decimals: 2,
      },
    ]);
  });

  it("treats zero-like inbound values as missing", () => {
    const chainsConfig = asChainsConfig({
      Solana: {
        limits: { outbound: "10.00", inbound: { Ethereum: "0.00" } },
      },
      Ethereum: {
        limits: { outbound: "20.00", inbound: { Solana: "000" } },
      },
    });

    const result = collectMissingInboundGroups(chainsConfig, "Solana");

    expect(result).toEqual([
      {
        destination: "Ethereum",
        sources: ["Solana"],
        defaultLimit: "20.00",
        decimals: 2,
      },
      {
        destination: "Solana",
        sources: ["Ethereum"],
        defaultLimit: "10.00",
        decimals: 2,
      },
    ]);
  });

  it("collects missing inbound groups across all chains", () => {
    const chainsConfig = asChainsConfig({
      Solana: {
        limits: { outbound: "10.00", inbound: {} },
      },
      Ethereum: {
        limits: { outbound: "20.00", inbound: {} },
      },
      Sui: {
        limits: { outbound: "30.00", inbound: {} },
      },
    });

    const result = collectMissingInboundGroups(chainsConfig);

    expect(result).toEqual([
      {
        destination: "Ethereum",
        sources: ["Solana", "Sui"],
        defaultLimit: "20.00",
        decimals: 2,
      },
      {
        destination: "Solana",
        sources: ["Ethereum", "Sui"],
        defaultLimit: "10.00",
        decimals: 2,
      },
      {
        destination: "Sui",
        sources: ["Solana", "Ethereum"],
        defaultLimit: "30.00",
        decimals: 2,
      },
    ]);
  });
});
