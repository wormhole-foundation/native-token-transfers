import { NttExecutorRoute } from "../src/executor/executor.js";

describe("NttExecutorRoute config types", () => {
  it("Config accepts getFee callback", () => {
    const config: NttExecutorRoute.Config = {
      ntt: { tokens: {} },
      getFee: async ({
        amount,
        sourceChain,
        sourceToken,
        destinationChain,
        destinationToken,
      }) => ({
        transferTokenFee: (amount * 10n) / 100_000n,
        nativeTokenFee: 0n,
        referrerAddress: "0x9b2A3B92b1D86938D3Ed37B0519952C227bA6D09",
      }),
    };
    expect(config.getFee).toBeDefined();
  });

  it("Config works without getFee (zero fees)", () => {
    const config: NttExecutorRoute.Config = {
      ntt: { tokens: {} },
    };
    expect(config.getFee).toBeUndefined();
  });

  it("GetFeeResult has required fields", () => {
    const result: NttExecutorRoute.GetFeeResult = {
      transferTokenFee: 1000n,
      nativeTokenFee: 500n,
      referrerAddress: "0x9b2A3B92b1D86938D3Ed37B0519952C227bA6D09",
    };
    expect(result.transferTokenFee).toBe(1000n);
    expect(result.nativeTokenFee).toBe(500n);
  });

  it("NormalizedParams has fee fields", () => {
    const params: Partial<NttExecutorRoute.NormalizedParams> = {
      transferTokenFee: 100n,
      nativeTokenFee: 0n,
    };
    expect(params.transferTokenFee).toBe(100n);
    expect(params.nativeTokenFee).toBe(0n);
  });
});
