import { describe, expect, mock, test } from "bun:test";
import type { Signer as EthersSigner, TransactionRequest } from "ethers";
import { EvmNativeSigner, buildGasOpts } from "../evm/signer";

const HIGH_MAX_FEE = 5_000_000_000n; // 5 gwei (any value > 50_000_000n)
const LOW_MAX_FEE = 1n; // BSC post-Lorentz shape
const DEFAULT_FALLBACK_GAS_PRICE = 200_000_000_000n; // module-internal default
const DEFAULT_FALLBACK_MAX_FEE = 6_000_000_000n;
const DEFAULT_FALLBACK_PRIO = 1_000_000_000n;

type CapturedTx = TransactionRequest & {
  gasLimit?: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  type?: number;
};

function makeFakeSigner(opts?: {
  feeData?: {
    gasPrice?: bigint | null;
    maxFeePerGas?: bigint | null;
    maxPriorityFeePerGas?: bigint | null;
  };
  failGetFeeData?: boolean;
}) {
  const captured: CapturedTx[] = [];
  const getFeeData = mock(async () => {
    if (opts?.failGetFeeData) throw new Error("RPC down");
    return {
      gasPrice: opts?.feeData?.gasPrice ?? null,
      maxFeePerGas: opts?.feeData?.maxFeePerGas ?? null,
      maxPriorityFeePerGas: opts?.feeData?.maxPriorityFeePerGas ?? null,
    };
  });
  const signer = {
    provider: { getFeeData },
    getNonce: mock(async () => 0),
    signTransaction: mock(async (t: CapturedTx) => {
      captured.push(t);
      return "0xsigned";
    }),
  } as unknown as EthersSigner;
  return { signer, captured, getFeeData };
}

function makeUnsignedTx(): any {
  return {
    transaction: {
      to: "0x0000000000000000000000000000000000000001",
      data: "0x",
    },
    description: "test",
    network: "Mainnet",
    chain: "Ethereum",
    parallelizable: false,
  };
}

describe("buildGasOpts", () => {
  test("uses EIP-1559 path when maxFeePerGas is above sanity floor", () => {
    const opts = buildGasOpts(3_000_000n, {
      gasPrice: 7n,
      maxFeePerGas: HIGH_MAX_FEE,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    expect(opts.gasLimit).toBe(3_000_000n);
    expect(opts.maxFeePerGas).toBe(HIGH_MAX_FEE);
    expect(opts.maxPriorityFeePerGas).toBe(1_000_000_000n);
    expect(opts.gasPrice).toBe(7n); // preserved for backward compat
    expect(opts.type).toBeUndefined();
  });

  test("falls back to legacy when maxFeePerGas < sanity floor (BSC post-Lorentz)", () => {
    const opts = buildGasOpts(3_000_000n, {
      gasPrice: 50_000_000n, // BSC node minimum, below 1 gwei floor
      maxFeePerGas: LOW_MAX_FEE,
      maxPriorityFeePerGas: 1n,
    });
    expect(opts.type).toBe(0);
    expect(opts.gasPrice).toBe(1_000_000_000n); // clamped to LEGACY_FALLBACK_GAS_PRICE
    expect(opts.gasLimit).toBe(3_000_000n);
    expect(opts.maxFeePerGas).toBeUndefined();
    expect(opts.maxPriorityFeePerGas).toBeUndefined();
  });

  test("legacy path preserves provider gasPrice when above the floor", () => {
    const provider = 5_000_000_000n;
    const opts = buildGasOpts(3_000_000n, {
      gasPrice: provider,
      maxFeePerGas: LOW_MAX_FEE,
      maxPriorityFeePerGas: 1n,
    });
    expect(opts.type).toBe(0);
    expect(opts.gasPrice).toBe(provider);
  });

  test("threshold is exclusive: maxFeePerGas == floor stays on EIP-1559 path", () => {
    const opts = buildGasOpts(3_000_000n, {
      gasPrice: 1n,
      maxFeePerGas: 50_000_000n,
      maxPriorityFeePerGas: 1n,
    });
    expect(opts.type).toBeUndefined();
    expect(opts.maxFeePerGas).toBe(50_000_000n);
  });
});

describe("EvmNativeSigner.sign — gas options", () => {
  test("default chain uses 3M gasLimit", async () => {
    const { signer, captured } = makeFakeSigner({
      feeData: {
        gasPrice: HIGH_MAX_FEE,
        maxFeePerGas: HIGH_MAX_FEE,
        maxPriorityFeePerGas: 1_000_000_000n,
      },
    });
    const sut = new EvmNativeSigner("Ethereum", "0xabc", signer);
    await sut.sign([makeUnsignedTx()]);
    expect(captured[0].gasLimit).toBe(3_000_000n);
    expect(captured[0].maxFeePerGas).toBe(HIGH_MAX_FEE);
    expect(captured[0].type).toBeUndefined();
  });

  test("opts.maxGasLimit overrides the default on the catch-all branch", async () => {
    const { signer, captured } = makeFakeSigner({
      feeData: {
        gasPrice: HIGH_MAX_FEE,
        maxFeePerGas: HIGH_MAX_FEE,
        maxPriorityFeePerGas: 1_000_000_000n,
      },
    });
    const sut = new EvmNativeSigner("Ethereum", "0xabc", signer, {
      maxGasLimit: 42n,
    });
    await sut.sign([makeUnsignedTx()]);
    expect(captured[0].gasLimit).toBe(42n);
  });

  test("Mantle and ArbitrumSepolia keep their specialized gasLimits regardless of override", async () => {
    for (const [chain, expected] of [
      ["Mantle", 2600_000_000_000n],
      ["ArbitrumSepolia", 4_000_000n],
    ] as const) {
      const { signer, captured } = makeFakeSigner({
        feeData: {
          gasPrice: HIGH_MAX_FEE,
          maxFeePerGas: HIGH_MAX_FEE,
          maxPriorityFeePerGas: 1n,
        },
      });
      const sut = new EvmNativeSigner(chain, "0xabc", signer, {
        maxGasLimit: 1n, // ignored on these branches
      });
      await sut.sign([makeUnsignedTx()]);
      expect(captured[0].gasLimit).toBe(expected);
    }
  });

  test("BSC-shaped feeData (maxFeePerGas = 1) triggers legacy path with gasPrice floor", async () => {
    const { signer, captured } = makeFakeSigner({
      feeData: {
        gasPrice: 50_000_000n, // BSC node minimum, below 1 gwei floor
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
      },
    });
    const sut = new EvmNativeSigner("Bsc", "0xabc", signer);
    await sut.sign([makeUnsignedTx()]);
    expect(captured[0].type).toBe(0);
    expect(captured[0].gasPrice).toBe(1_000_000_000n);
    expect(captured[0].maxFeePerGas).toBeUndefined();
    expect(captured[0].maxPriorityFeePerGas).toBeUndefined();
  });

  test("Celo skips getFeeData and uses fallback defaults on the EIP-1559 path", async () => {
    const { signer, captured, getFeeData } = makeFakeSigner({
      failGetFeeData: true, // would throw if called
    });
    const sut = new EvmNativeSigner("Celo", "0xabc", signer);
    await sut.sign([makeUnsignedTx()]);
    expect(getFeeData).not.toHaveBeenCalled();
    expect(captured[0].gasPrice).toBe(DEFAULT_FALLBACK_GAS_PRICE);
    expect(captured[0].maxFeePerGas).toBe(DEFAULT_FALLBACK_MAX_FEE);
    expect(captured[0].maxPriorityFeePerGas).toBe(DEFAULT_FALLBACK_PRIO);
    expect(captured[0].type).toBeUndefined();
  });

  test("getFeeData() throwing falls back to literal defaults instead of propagating", async () => {
    const { signer, captured } = makeFakeSigner({ failGetFeeData: true });
    const sut = new EvmNativeSigner("Ethereum", "0xabc", signer);
    await sut.sign([makeUnsignedTx()]);
    expect(captured[0].gasPrice).toBe(DEFAULT_FALLBACK_GAS_PRICE);
    expect(captured[0].maxFeePerGas).toBe(DEFAULT_FALLBACK_MAX_FEE);
    expect(captured[0].gasLimit).toBe(3_000_000n);
  });
});
