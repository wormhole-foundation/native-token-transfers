import { describe, it, expect, spyOn, afterEach } from "bun:test";
import { checkConfigErrors } from "../src/configErrors";
import type { Deployment } from "../src/validation";
import type { Chain } from "@wormhole-foundation/sdk";

describe("checkConfigErrors", () => {
  let errorSpy: ReturnType<typeof spyOn> | undefined;
  let warnSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    errorSpy?.mockRestore();
    warnSpy?.mockRestore();
  });

  const makeDeployment = (
    decimals: number,
    outbound: string,
    inbound: Record<string, string>
  ) =>
    ({
      decimals,
      config: {
        local: {
          limits: {
            outbound,
            inbound,
          },
        },
      },
    }) as Deployment<Chain>;

  it("returns 0 for valid formatting", () => {
    const deployments = {
      Solana: makeDeployment(2, "10.00", { Ethereum: "1.00" }),
    } as Record<string, Deployment<Chain>>;

    const result = checkConfigErrors(deployments);

    expect(result).toBe(0);
  });

  it("counts invalid outbound formatting", () => {
    errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const deployments = {
      Solana: makeDeployment(2, "10.0", {}),
    } as Record<string, Deployment<Chain>>;

    const result = checkConfigErrors(deployments);

    expect(result).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("counts invalid inbound formatting", () => {
    errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const deployments = {
      Solana: makeDeployment(2, "10.00", { Ethereum: "1.0" }),
    } as Record<string, Deployment<Chain>>;

    const result = checkConfigErrors(deployments);

    expect(result).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("warns for zero outbound and inbound limits", () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
    const deployments = {
      Solana: makeDeployment(2, "0.00", { Ethereum: "0.00" }),
    } as Record<string, Deployment<Chain>>;

    const result = checkConfigErrors(deployments);

    expect(result).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect((warnSpy.mock.calls[0] as any[])[0]).toContain("outbound limit of 0");
    expect((warnSpy.mock.calls[1] as any[])[0]).toContain("inbound limit of 0");
  });

  it("handles undefined config.local without TypeError", () => {
    errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const deps = {
      Sepolia: {
        decimals: 18,
        config: { local: undefined },
      } as any,
    };
    expect(() => checkConfigErrors(deps)).not.toThrow();
    expect(checkConfigErrors(deps)).toBeGreaterThan(0);
  });

  it("handles undefined config.limits without TypeError", () => {
    errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const deps = {
      Sepolia: {
        decimals: 18,
        config: {
          local: {
            mode: "locking",
            paused: false,
            owner: "0x1",
            manager: "0x2",
            token: "0x3",
            transceivers: { threshold: 1, wormhole: { address: "0x4" } },
            // limits deliberately omitted
          },
        },
      } as any,
    };
    expect(() => checkConfigErrors(deps)).not.toThrow();
    expect(checkConfigErrors(deps)).toBeGreaterThan(0);
  });
});
