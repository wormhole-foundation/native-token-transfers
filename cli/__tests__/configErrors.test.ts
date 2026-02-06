import { checkConfigErrors } from "../src/configErrors";
import type { Deployment } from "../src/validation";
import type { Chain } from "@wormhole-foundation/sdk";
describe("checkConfigErrors", () => {
  afterEach(() => {
    jest.restoreAllMocks();
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
    const errorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const deployments = {
      Solana: makeDeployment(2, "10.0", {}),
    } as Record<string, Deployment<Chain>>;

    const result = checkConfigErrors(deployments);

    expect(result).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("counts invalid inbound formatting", () => {
    const errorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const deployments = {
      Solana: makeDeployment(2, "10.00", { Ethereum: "1.0" }),
    } as Record<string, Deployment<Chain>>;

    const result = checkConfigErrors(deployments);

    expect(result).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("warns for zero outbound and inbound limits", () => {
    const warnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const deployments = {
      Solana: makeDeployment(2, "0.00", { Ethereum: "0.00" }),
    } as Record<string, Deployment<Chain>>;

    const result = checkConfigErrors(deployments);

    expect(result).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0][0]).toContain("outbound limit of 0");
    expect(warnSpy.mock.calls[1][0]).toContain("inbound limit of 0");
  });
});
