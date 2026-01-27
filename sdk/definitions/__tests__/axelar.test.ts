import {
  getAxelarApiUrl,
  getAxelarChain,
  parseGMPStatus,
  parseGMPError,
  getAxelarGasFee,
  getAxelarTransactionStatus,
  GMPStatus,
} from "../src/axelar.js";

describe("Axelar Utility Functions", () => {
  describe("getAxelarApiUrl", () => {
    it("should return mainnet API URL for Mainnet network", () => {
      const url = getAxelarApiUrl("Mainnet");
      expect(url).toBe("https://api.axelarscan.io");
    });

    it("should return testnet API URL for Testnet network", () => {
      const url = getAxelarApiUrl("Testnet");
      expect(url).toBe("https://testnet.api.axelarscan.io");
    });
  });

  describe("getAxelarChain", () => {
    it("should return axelar chain name for Ethereum", () => {
      const chain = getAxelarChain("Ethereum");
      expect(chain).toBe("ethereum");
    });

    it("should return axelar chain name for Monad", () => {
      const chain = getAxelarChain("Monad");
      expect(chain).toBe("monad");
    });

    it("should return axelar chain name for Sepolia", () => {
      const chain = getAxelarChain("Sepolia");
      expect(chain).toBe("ethereum-sepolia");
    });

    it("should throw error for unsupported chain", () => {
      expect(() => getAxelarChain("Solana" as any)).toThrow(
        "Unsupported axelar chain: Solana"
      );
    });
  });

  describe("parseGMPStatus", () => {
    it("should parse error status", () => {
      const response = { status: "error", error: { message: "some error" } };
      const status = parseGMPStatus(response);
      expect(status).toBe(GMPStatus.DEST_EXECUTE_ERROR);
    });

    it("should parse executed status", () => {
      const response = { status: "executed" };
      const status = parseGMPStatus(response);
      expect(status).toBe(GMPStatus.DEST_EXECUTED);
    });

    it("should parse called status", () => {
      const response = { status: "called" };
      const status = parseGMPStatus(response);
      expect(status).toBe(GMPStatus.SRC_GATEWAY_CALLED);
    });

    it("should parse executing status", () => {
      const response = { status: "executing" };
      const status = parseGMPStatus(response);
      expect(status).toBe(GMPStatus.DEST_EXECUTING);
    });
  });

  describe("parseGMPError", () => {
    it("should parse error from response", () => {
      const response = {
        error: {
          error: { message: "execution failed" },
          sourceTransactionHash: "0xabc123",
          chain: "ethereum",
        },
      };
      const error = parseGMPError(response);
      expect(error).toEqual({
        message: "Transfer failed",
        txHash: "0xabc123",
        chain: "ethereum",
      });
    });

    it("should parse insufficient fee error", () => {
      const response = {
        is_insufficient_fee: true,
        call: {
          transaction: { hash: "0xdef456" },
          chain: "monad",
        },
      };
      const error = parseGMPError(response);
      expect(error).toEqual({
        message: "Insufficient gas",
        txHash: "0xdef456",
        chain: "monad",
      });
    });

    it("should return undefined when no error", () => {
      const response = { status: "executed" };
      const error = parseGMPError(response);
      expect(error).toBeUndefined();
    });
  });

  describe("getAxelarGasFee", () => {
    const originalFetch = global.fetch;
    let mockFetch: jest.Mock;

    beforeEach(() => {
      mockFetch = jest.fn() as jest.Mock;
      global.fetch = mockFetch as any;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it("should fetch and return gas fee", async () => {
      const mockResponse = {
        ok: true,
        json: async () => "1000000000000000",
      };
      mockFetch.mockResolvedValue(mockResponse);

      const fee = await getAxelarGasFee("Testnet", "Sepolia", "Monad", 500000n);
      expect(fee).toBe(1000000000000000n);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://testnet.api.axelarscan.io/gmp/estimateGasFee",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceChain: "ethereum-sepolia",
            destinationChain: "monad",
            gasMultiplier: "auto",
            gasLimit: "500000",
          }),
        })
      );
    });

    it("should throw error when API returns 0", async () => {
      const mockResponse = {
        ok: true,
        json: async () => "0",
      };
      mockFetch.mockResolvedValue(mockResponse);

      await expect(
        getAxelarGasFee("Testnet", "Sepolia", "Monad", 500000n)
      ).rejects.toThrow("Invalid gas fee estimate");
    });

    it("should throw error when API call fails", async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        text: async () => "Internal server error",
      };
      mockFetch.mockResolvedValue(mockResponse);

      await expect(
        getAxelarGasFee("Testnet", "Sepolia", "Monad", 500000n)
      ).rejects.toThrow("Failed to estimate gas fee: 500");
    });

    it("should throw error when request times out", async () => {
      mockFetch.mockImplementation(() => {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Timeout")), 100);
        });
      });

      await expect(
        getAxelarGasFee("Testnet", "Sepolia", "Monad", 500000n, 50)
      ).rejects.toThrow("Timeout");
    });

    it("should use mainnet API for Mainnet network", async () => {
      const mockResponse = {
        ok: true,
        json: async () => "2000000000000000",
      };
      mockFetch.mockResolvedValue(mockResponse);

      await getAxelarGasFee("Mainnet", "Ethereum", "Monad", 500000n);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.axelarscan.io/gmp/estimateGasFee",
        expect.any(Object)
      );
    });
  });

  describe("getAxelarTransactionStatus", () => {
    const originalFetch = global.fetch;
    let mockFetch: jest.Mock;

    beforeEach(() => {
      mockFetch = jest.fn() as jest.Mock;
      global.fetch = mockFetch as any;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it("should fetch and return transaction status", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          data: [
            {
              status: "executed",
            },
          ],
        }),
      };
      mockFetch.mockResolvedValue(mockResponse);

      const result = await getAxelarTransactionStatus(
        "Testnet",
        "Sepolia",
        "0xabc123"
      );
      expect(result.status).toBe(GMPStatus.DEST_EXECUTED);
      expect(result.error).toBeUndefined();
      expect(global.fetch).toHaveBeenCalledWith(
        "https://testnet.api.axelarscan.io/gmp/searchGMP",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceChain: "ethereum-sepolia",
            txHash: "0xabc123",
          }),
        })
      );
    });

    it("should return status with error when present", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          data: [
            {
              status: "error",
              error: {
                error: { message: "execution reverted" },
                sourceTransactionHash: "0xabc123",
                chain: "ethereum",
              },
            },
          ],
        }),
      };
      mockFetch.mockResolvedValue(mockResponse);

      const result = await getAxelarTransactionStatus(
        "Testnet",
        "Sepolia",
        "0xabc123"
      );
      expect(result.status).toBe(GMPStatus.DEST_EXECUTE_ERROR);
      expect(result.error).toEqual({
        message: "Transfer failed",
        txHash: "0xabc123",
        chain: "ethereum",
      });
    });

    it("should throw error when no transaction details found", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          data: [],
        }),
      };
      mockFetch.mockResolvedValue(mockResponse);

      await expect(
        getAxelarTransactionStatus("Testnet", "Sepolia", "0xabc123")
      ).rejects.toThrow("No transaction details found");
    });

    it("should throw error when API call fails", async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        text: async () => "Internal server error",
      };
      mockFetch.mockResolvedValue(mockResponse);

      await expect(
        getAxelarTransactionStatus("Testnet", "Sepolia", "0xabc123")
      ).rejects.toThrow("Failed to get transaction status: 500");
    });

    it("should throw error when request times out", async () => {
      mockFetch.mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Timeout")), 100);
          })
      );

      await expect(
        getAxelarTransactionStatus("Testnet", "Sepolia", "0xabc123", 50)
      ).rejects.toThrow();
    });
  });
});
