import { describe, test, expect } from "bun:test";
import { ethers } from "ethers";
import {
  computeAssetBridge,
  computeDeployNonce,
  computeDeployNonceFromHyperEvm,
} from "../../evm/hyperliquid";

describe("hyperliquid helpers", () => {
  test("computeAssetBridge returns deterministic bridge address", () => {
    expect(computeAssetBridge(0)).toBe(
      "0x2000000000000000000000000000000000000000"
    );
    expect(computeAssetBridge(1591)).toBe(
      "0x2000000000000000000000000000000000000637"
    );
    expect(computeAssetBridge(65535)).toBe(
      "0x200000000000000000000000000000000000ffff"
    );
  });

  test("computeAssetBridge rejects invalid token indexes", () => {
    expect(() => computeAssetBridge(-1)).toThrow(
      "tokenIndex must be an integer in range [0, 65535]"
    );
    expect(() => computeAssetBridge(1.2)).toThrow(
      "tokenIndex must be an integer in range [0, 65535]"
    );
    expect(() => computeAssetBridge(65536)).toThrow(
      "tokenIndex must be an integer in range [0, 65535]"
    );
  });

  test("computeDeployNonce finds the correct nonce", () => {
    const deployer = "0x1111111111111111111111111111111111111111";
    const targetAddress = ethers.getCreateAddress({ from: deployer, nonce: 7 });
    expect(computeDeployNonce(deployer, targetAddress, 50)).toBe(7);
  });

  test("computeDeployNonce throws when nonce cannot be found", () => {
    const deployer = "0x1111111111111111111111111111111111111111";
    const targetAddress = ethers.getCreateAddress({ from: deployer, nonce: 7 });
    expect(() => computeDeployNonce(deployer, targetAddress, 3)).toThrow(
      "Could not find deploy nonce"
    );
  });

  test("computeDeployNonceFromHyperEvm uses a floor search bound for low tx counts", async () => {
    const deployer = "0x1111111111111111111111111111111111111111";
    const targetAddress = ethers.getCreateAddress({
      from: deployer,
      nonce: 900,
    });

    const originalGetTransactionCount =
      ethers.JsonRpcProvider.prototype.getTransactionCount;
    ethers.JsonRpcProvider.prototype.getTransactionCount = async () => 5;

    try {
      await expect(
        computeDeployNonceFromHyperEvm(deployer, targetAddress, true)
      ).resolves.toBe(900);
    } finally {
      ethers.JsonRpcProvider.prototype.getTransactionCount =
        originalGetTransactionCount;
    }
  });

  test("computeDeployNonceFromHyperEvm respects hard cap", async () => {
    const deployer = "0x1111111111111111111111111111111111111111";
    const targetAddress = ethers.getCreateAddress({
      from: deployer,
      nonce: 1300,
    });

    const originalGetTransactionCount =
      ethers.JsonRpcProvider.prototype.getTransactionCount;
    ethers.JsonRpcProvider.prototype.getTransactionCount = async () => 10_000;

    try {
      await expect(
        computeDeployNonceFromHyperEvm(deployer, targetAddress, false, 1200)
      ).rejects.toThrow("Could not find deploy nonce");
    } finally {
      ethers.JsonRpcProvider.prototype.getTransactionCount =
        originalGetTransactionCount;
    }
  });
});
