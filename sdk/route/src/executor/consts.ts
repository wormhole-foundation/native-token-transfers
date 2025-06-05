import { Chain, Network } from "@wormhole-foundation/sdk-connect";

export const apiBaseUrl: Partial<Record<Network, string>> = {
  Testnet: "https://executor-testnet.labsapis.com",
  Mainnet: "https://executor.labsapis.com",
};

export const nttManagerWithExecutorContracts: Partial<
  Record<Network, Partial<Record<Chain, string>>>
> = {
  Mainnet: {},
  Testnet: {
    Avalanche: "0x246E3968dA8f9aA3608BAa9FdBe83c8EB6B51671",
    BaseSepolia: "0x49D2c608Ae52b456A3896efa296e4F555f5BE480",
    Sepolia: "0xeE4ECA827e999F0489099ac35b10c4bE5036C422",
    Solana: "nex1gkSWtRBheEJuQZMqHhbMG5A45qPU76KqnCZNVHR",
  },
};

// Referrer addresses (to whom the referrer fee should be paid)
export const referrers: Partial<
  Record<Network, Partial<Record<Chain, string>>>
> = {
  Mainnet: {},
  Testnet: {
    Avalanche: "0x8F26A0025dcCc6Cfc07A7d38756280a10E295ad7",
    BaseSepolia: "0x8F26A0025dcCc6Cfc07A7d38756280a10E295ad7",
    Sepolia: "0x8F26A0025dcCc6Cfc07A7d38756280a10E295ad7",
    Solana: "9r6q2iEg4MBevjC8reaLmQUDxueF3vabUoqDkZ2LoAYe",
  },
};

// Gas limits must be high enough to cover the worst-case scenario for each chain
// to avoid relay failures. However, they should not be too high to reduce the
// `estimatedCost` returned by the quote endpoint.
export const gasLimits: Partial<
  Record<Network, Partial<Record<Chain, bigint>>>
> = {
  Mainnet: {},
  Testnet: {
    Sepolia: 300_000n,
    Solana: 300_000n,
  },
};
