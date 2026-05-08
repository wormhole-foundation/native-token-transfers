import { Interface } from "ethers";
import { Wormhole } from "@wormhole-foundation/sdk";
import { EvmPlatform } from "@wormhole-foundation/sdk-evm";
import {
  EvmNttWithExecutor,
  hasExecutorDeployed,
  nttWithExecutorAbi,
} from "../src/nttWithExecutor.js";
import { EvmNtt } from "../src/ntt.js";
import type { NttWithExecutor } from "@wormhole-foundation/sdk-definitions-ntt";

const iface = new Interface(nttWithExecutorAbi);

describe("NttWithExecutor V2", () => {
  describe("hasExecutorDeployed", () => {
    it("returns true for chains with addresses", () => {
      expect(hasExecutorDeployed("Mainnet", "Ethereum")).toBe(true);
      expect(hasExecutorDeployed("Testnet", "Monad")).toBe(true);
    });

    it("returns false for chains without any executor", () => {
      expect(hasExecutorDeployed("Mainnet", "Klaytn")).toBe(false);
    });
  });

  describe("transfer calldata", () => {
    const MANAGER_ADDRESS = "0x649fF7B32C2DE771043ea105c4aAb2D724497238";
    const TOKEN_ADDRESS = "0x738141EFf659625F2eAD4feECDfCD94155C67f18";
    const REFERRER_ADDRESS = "0x9b2A3B92b1D86938D3Ed37B0519952C227bA6D09";

    let executor: EvmNttWithExecutor<"Testnet", "Sepolia">;
    let mockNtt: EvmNtt<"Testnet", "Sepolia">;

    beforeAll(async () => {
      const wh = new Wormhole("Testnet", [EvmPlatform]);
      const ctx = wh.getChain("Sepolia");
      const rpc = await ctx.getRpc();

      executor = new EvmNttWithExecutor("Testnet", "Sepolia", rpc, {
        ntt: {
          token: TOKEN_ADDRESS,
          manager: MANAGER_ADDRESS,
          transceiver: {
            wormhole: "0x06413c42e913327Bc9a08B7C1E362BAE7C0b9598",
          },
        },
      });

      mockNtt = {
        managerAddress: MANAGER_ADDRESS,
        tokenAddress: TOKEN_ADDRESS,
        quoteDeliveryPrice: jest.fn().mockResolvedValue(10_000n),
        encodeOptions: jest.fn().mockReturnValue([]),
        createUnsignedTx: jest.fn().mockImplementation((txReq, desc) => ({
          transaction: txReq,
          description: desc,
        })),
      } as unknown as EvmNtt<"Testnet", "Sepolia">;
    });

    function makeQuote(
      overrides: Partial<NttWithExecutor.Quote> = {}
    ): NttWithExecutor.Quote {
      return {
        signedQuote: new Uint8Array(64),
        relayInstructions: new Uint8Array(32),
        estimatedCost: 50_000n,
        payeeAddress: new Uint8Array(32),
        referrer: Wormhole.chainAddress("Sepolia", REFERRER_ADDRESS),
        transferTokenFee: 1_000_000n,
        nativeTokenFee: 0n,
        remainingAmount: 99_000_000n,
        expires: new Date(Date.now() + 60_000),
        gasDropOff: 0n,
        ...overrides,
      };
    }

    async function collectTxs(gen: AsyncGenerator<any>) {
      const txs = [];
      for await (const tx of gen) {
        txs.push(tx);
      }
      return txs;
    }

    it("passes remainingAmount as the contract amount param", async () => {
      const quote = makeQuote();
      const sender = Wormhole.chainAddress("Sepolia", REFERRER_ADDRESS);

      // Mock approveIfNeeded to skip RPC
      (executor as any).approveIfNeeded = async function* () {};

      const txs = await collectTxs(
        executor.transfer(
          sender.address,
          Wormhole.chainAddress("ArbitrumSepolia", REFERRER_ADDRESS),
          100_000_000n,
          quote,
          mockNtt
        )
      );

      const transferTx = txs[txs.length - 1];
      const decoded = iface.decodeFunctionData(
        "transfer",
        transferTx.transaction.data
      );

      expect(decoded["amount"]).toBe(99_000_000n);
    });

    it("encodes transferTokenFee and nativeTokenFee in feeArgs", async () => {
      const quote = makeQuote({
        transferTokenFee: 1_000_000n,
        nativeTokenFee: 500_000n,
      });
      const sender = Wormhole.chainAddress("Sepolia", REFERRER_ADDRESS);
      (executor as any).approveIfNeeded = async function* () {};

      const txs = await collectTxs(
        executor.transfer(
          sender.address,
          Wormhole.chainAddress("ArbitrumSepolia", REFERRER_ADDRESS),
          100_000_000n,
          quote,
          mockNtt
        )
      );

      const decoded = iface.decodeFunctionData(
        "transfer",
        txs[txs.length - 1].transaction.data
      );

      expect(decoded["feeArgs"].transferTokenFee).toBe(1_000_000n);
      expect(decoded["feeArgs"].nativeTokenFee).toBe(500_000n);
      expect(decoded["feeArgs"].payee).toBe(REFERRER_ADDRESS);
    });

    it("sets correct msgValue for ERC20 transfer", async () => {
      const quote = makeQuote({
        estimatedCost: 50_000n,
        nativeTokenFee: 500_000n,
      });
      const sender = Wormhole.chainAddress("Sepolia", REFERRER_ADDRESS);
      (executor as any).approveIfNeeded = async function* () {};

      const txs = await collectTxs(
        executor.transfer(
          sender.address,
          Wormhole.chainAddress("ArbitrumSepolia", REFERRER_ADDRESS),
          100_000_000n,
          quote,
          mockNtt
        )
      );

      const transferTx = txs[txs.length - 1];
      // msgValue = estimatedCost + deliveryPrice + nativeTokenFee
      // deliveryPrice = 10_000n (mocked)
      expect(transferTx.transaction.value).toBe(50_000n + 10_000n + 500_000n);
    });

    it("uses transferETH when wrapNative is true", async () => {
      const quote = makeQuote({
        remainingAmount: 99_000_000n,
        transferTokenFee: 1_000_000n,
        nativeTokenFee: 0n,
        estimatedCost: 50_000n,
      });
      const sender = Wormhole.chainAddress("Sepolia", REFERRER_ADDRESS);

      const txs = await collectTxs(
        executor.transfer(
          sender.address,
          Wormhole.chainAddress("ArbitrumSepolia", REFERRER_ADDRESS),
          100_000_000n,
          quote,
          mockNtt,
          true // wrapNative
        )
      );

      const transferTx = txs[txs.length - 1];
      const decoded = iface.decodeFunctionData(
        "transferETH",
        transferTx.transaction.data
      );

      expect(decoded["amount"]).toBe(99_000_000n);
      // msgValue includes totalAmount for transferETH
      const totalAmount = 99_000_000n + 1_000_000n;
      expect(transferTx.transaction.value).toBe(
        50_000n + 10_000n + 0n + totalAmount
      );
    });
  });
});
