/* Autogenerated file. Do not edit manually. */
/* tslint:disable */
/* eslint-disable */

import { Contract, Signer, utils } from "ethers";
import type { Provider } from "@ethersproject/providers";
import type {
  CCTPAndTokenBase,
  CCTPAndTokenBaseInterface,
} from "../../CCTPAndTokenBase.sol/CCTPAndTokenBase";

const _abi = [
  {
    type: "function",
    name: "setRegisteredSender",
    inputs: [
      {
        name: "sourceChain",
        type: "uint16",
        internalType: "uint16",
      },
      {
        name: "sourceAddress",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "tokenBridge",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract ITokenBridge",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "wormhole",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract IWormhole",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "wormholeRelayer",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract IWormholeRelayer",
      },
    ],
    stateMutability: "view",
  },
] as const;

export class CCTPAndTokenBase__factory {
  static readonly abi = _abi;
  static createInterface(): CCTPAndTokenBaseInterface {
    return new utils.Interface(_abi) as CCTPAndTokenBaseInterface;
  }
  static connect(
    address: string,
    signerOrProvider: Signer | Provider
  ): CCTPAndTokenBase {
    return new Contract(address, _abi, signerOrProvider) as CCTPAndTokenBase;
  }
}