import { type Chain } from "@wormhole-foundation/sdk-base";
import { type Ntt } from "@wormhole-foundation/sdk-definitions-ntt";
import { type NttRoute } from "@wormhole-foundation/sdk-route-ntt";
export type NttContracts = {
  [key in Chain]?: Ntt.Contracts;
};

export const JITO_NTT_CONTRACTS: NttContracts = {
  Solana: {
    token: "E3W7KwMH8ptaitYyWtxmfBUpqcuf2XieaFtQSn1LVXsA",
    manager: "WZLm4bJU4BNVmzWEwEzGVMQ5XFUc4iBmMSLutFbr41f",
    transceiver: { wormhole: "WZLm4bJU4BNVmzWEwEzGVMQ5XFUc4iBmMSLutFbr41f" },
    quoter: "Nqd6XqA8LbsCuG8MLWWuP865NV6jR1MbXeKxD4HLKDJ",
  },
  ArbitrumSepolia: {
    token: "0x87579Dc40781e99b870DDce46e93bd58A0e58Ae5",
    manager: "0xdA5a8e05e276AAaF4d79AB5b937a002E5221a4D8",
    transceiver: { wormhole: "0xd2940c256a3D887833D449eF357b6D639Cb98e12" },
  },
};

export const TEST_NTT_TOKENS: NttContracts = {
  Sepolia: {
    token: "0x738141EFf659625F2eAD4feECDfCD94155C67f18",
    manager: "0x06413c42e913327Bc9a08B7C1E362BAE7C0b9598",
    transceiver: { wormhole: "0x649fF7B32C2DE771043ea105c4aAb2D724497238" },
  },
  ArbitrumSepolia: {
    token: "0x395D3C74232D12916ecA8952BA352b4d27818035",
    manager: "0xCeC6FB4F352bf3DC2b95E1c41831E4D2DBF9a35D",
    transceiver: { wormhole: "0xfA42603152E4f133F5F3DA610CDa91dF5821d8bc" },
  },
  OptimismSepolia: {
    token: "0x1d30E78B7C7fbbcef87ae6e97B5389b2e470CA4a",
    manager: "0x27F9Fdd3eaD5aA9A5D827Ca860Be28442A1e7582",
    transceiver: { wormhole: "0xeCF0496DE01e9Aa4ADB50ae56dB550f52003bdB7" },
  },
  BaseSepolia: {
    token: "0xdDFeABcCf2063CD66f53a1218e23c681Ba6e7962",
    manager: "0x8b9E328bE1b1Bc7501B413d04EBF7479B110775c",
    transceiver: { wormhole: "0x149987472333cD48ac6D28293A338a1EEa6Be7EE" },
  },
  Solana: {
    token: "EetppHswYvV1jjRWoQKC1hejdeBDHR9NNzNtCyRQfrrQ",
    manager: "NTtAaoDJhkeHeaVUHnyhwbPNAN6WgBpHkHBTc6d7vLK",
    transceiver: { wormhole: "NTtAaoDJhkeHeaVUHnyhwbPNAN6WgBpHkHBTc6d7vLK" },
    quoter: "Nqd6XqA8LbsCuG8MLWWuP865NV6jR1MbXeKxD4HLKDJ",
  },
};

export const TEST_NTT_SPL22_TOKENS: NttContracts = {
  Sepolia: {
    token: "0x3a84364d27ed3d16022da0f603f3e0f74826c707",
    manager: "0x46475d067f7c2a388a7bb7fd5a9A4a68D7fA45c5",
    transceiver: {
      wormhole: "0x24cb9E1FEcaa40f07feBC0E32Ce16C0bb3ed6443",
    },
  },
  Solana: {
    token: "BAn1Zcr48bmaK5SmzBDjoju6csFe8AT6bot4ACBJvVwU",
    manager: "NtTnpY76eiMYqYX9xkag2CSXk9cGi6hinMWbMLMDYUP",
    transceiver: { wormhole: "NtTnpY76eiMYqYX9xkag2CSXk9cGi6hinMWbMLMDYUP" },
    quoter: "Nqd6XqA8LbsCuG8MLWWuP865NV6jR1MbXeKxD4HLKDJ",
  },
};

// Reformat NTT contracts to fit TokenConfig for Route
function reformat(nttContracts: NttContracts = TEST_NTT_TOKENS) {
  return Object.entries(nttContracts).map(([chain, contracts]) => {
    const { token, manager, transceiver: xcvrs, quoter } = contracts;
    const transceiver = Object.entries(xcvrs).map(([k, v]) => {
      return { type: k as NttRoute.TransceiverType, address: v };
    });
    return { chain: chain as Chain, token, manager, quoter, transceiver };
  });
}

export const NttTokens = {
  Test: reformat(TEST_NTT_TOKENS),
};
