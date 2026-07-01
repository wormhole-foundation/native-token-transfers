// NOTE: This file is a copy of the file from the wormhole-sdk package. The only
// change is messing with the gas parameters, because the original hardcoded
// values underpriced BSC testnet transactions, and they would get stuck in the mempool.
//
// Obviously this is a very short term stopgap. At the least, the sdk should
// probably support overriding the default gas parameters, but ideally it should
// be able to estimate the gas price and set it dynamically. (is that possible? idk)
//
// NOTE: we should now be able to use https://github.com/wormhole-foundation/wormhole-sdk-ts/pull/583 (thanks @ben)
import type {
  Network,
  SignOnlySigner,
  SignedTx,
  Signer,
  UnsignedTransaction,
} from "@wormhole-foundation/sdk-connect";
import {
  PlatformNativeSigner,
  chainToPlatform,
  isNativeSigner,
} from "@wormhole-foundation/sdk-connect";
import {
  EvmPlatform,
  type EvmChains,
  _platform,
} from "@wormhole-foundation/sdk-evm";
import type {
  Signer as EthersSigner,
  Provider,
  TransactionRequest,
} from "ethers";
import { NonceManager, Wallet } from "ethers";

// Default gas limit for the catch-all chain branch. Raised from 500k because
// NttWithExecutor.transfer bundles token escrow + Wormhole message publish +
// Executor relay instructions in a single transaction, realistically using
// ~1.2-1.5M gas on mainnet EVM chains. The previous 500k default caused
// silent out-of-gas reverts in token-transfer flows.
const DEFAULT_GAS_LIMIT = 3_000_000n;

// gasPrice floor used when the provider's EIP-1559 fee derivation is broken
// (see EIP1559_FEE_SANITY_FLOOR below). 1 gwei is 20x BSC's 0.05 gwei node
// minimum and remains inexpensive on every chain that hits this path.
const LEGACY_FALLBACK_GAS_PRICE = 1_000_000_000n; // 1 gwei

// Threshold (in wei) below which we treat the provider's maxFeePerGas as
// nonsense and fall back to a legacy (type 0) transaction. The canonical
// case is BSC post-Lorentz hardfork (mainnet, April 2025) where
// baseFeePerGas = 0; ethers' getFeeData() then returns maxFeePerGas = 1 wei
// and the node rejects with:
//   [private transaction service] require GasPrice=50000000, Provide=1
// Detecting by content (not by chain name) keeps this forward-compatible
// with any future chain that exhibits the same shape.
const EIP1559_FEE_SANITY_FLOOR = 50_000_000n; // 0.05 gwei

type FeeData = {
  gasPrice: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export function buildGasOpts(
  gasLimit: bigint,
  feeData: FeeData
): Partial<TransactionRequest> {
  if (feeData.maxFeePerGas < EIP1559_FEE_SANITY_FLOOR) {
    return {
      gasLimit,
      gasPrice:
        feeData.gasPrice > LEGACY_FALLBACK_GAS_PRICE
          ? feeData.gasPrice
          : LEGACY_FALLBACK_GAS_PRICE,
      type: 0,
    };
  }
  return {
    gasLimit,
    gasPrice: feeData.gasPrice,
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
  };
}

export async function getEvmSigner(
  rpc: Provider,
  key: string | EthersSigner,
  opts?: {
    maxGasLimit?: bigint;
    chain?: EvmChains;
    debug?: boolean;
  }
): Promise<Signer> {
  const signer: EthersSigner =
    typeof key === "string" ? new Wallet(key, rpc) : key;

  const chain = opts?.chain ?? (await EvmPlatform.chainFromRpc(rpc))[1];
  const managedSigner = new NonceManager(signer);

  if (managedSigner.provider === null) {
    try {
      managedSigner.connect(rpc);
    } catch (e) {
      console.error("Cannot connect to network for signer", e);
    }
  }

  return new EvmNativeSigner(
    chain,
    await signer.getAddress(),
    managedSigner,
    opts
  );
}

// Get a SignOnlySigner for the EVM platform
export async function getEvmSignerForKey(
  rpc: Provider,
  privateKey: string
): Promise<Signer> {
  return getEvmSigner(rpc, privateKey);
}

// Get a SignOnlySigner for the EVM platform
export async function getEvmSignerForSigner(
  signer: EthersSigner
): Promise<Signer> {
  if (!signer.provider) throw new Error("Signer must have a provider");
  return getEvmSigner(signer.provider!, signer, {});
}

export class EvmNativeSigner<N extends Network, C extends EvmChains = EvmChains>
  extends PlatformNativeSigner<EthersSigner, N, C>
  implements SignOnlySigner<N, C>
{
  constructor(
    _chain: C,
    _address: string,
    _signer: EthersSigner,
    readonly opts?: { maxGasLimit?: bigint; debug?: boolean }
  ) {
    super(_chain, _address, _signer);
  }

  chain(): C {
    return this._chain;
  }

  address(): string {
    return this._address;
  }

  async sign(tx: UnsignedTransaction<N, C>[]): Promise<SignedTx[]> {
    const chain: EvmChains = this.chain();

    const signed = [];

    let gasLimit: bigint;

    // Per-chain gas limit overrides where the default 500k is insufficient
    switch (chain) {
      case "ArbitrumSepolia":
        gasLimit = 4_000_000n;
        break;
      case "Tempo":
        gasLimit = 2_000_000n;
        break;
      default:
        gasLimit = this.opts?.maxGasLimit ?? DEFAULT_GAS_LIMIT;
        break;
    }

    let feeData: FeeData = {
      gasPrice: 200_000_000_000n, // 200 gwei
      maxFeePerGas: 6_000_000_000n, // 6 gwei
      maxPriorityFeePerGas: 1_000_000_000n, // 1 gwei
    };

    // Celo does not support this call
    if (chain !== "Celo") {
      try {
        const fetched = await this._signer.provider!.getFeeData();
        feeData = {
          gasPrice: fetched.gasPrice ?? feeData.gasPrice,
          maxFeePerGas: fetched.maxFeePerGas ?? feeData.maxFeePerGas,
          maxPriorityFeePerGas:
            fetched.maxPriorityFeePerGas ?? feeData.maxPriorityFeePerGas,
        };
      } catch (e) {
        if (this.opts?.debug) {
          console.warn(
            `getFeeData() failed for ${chain}; using fallback defaults`,
            e
          );
        }
      }
    }

    const gasOpts = buildGasOpts(gasLimit, feeData);

    for (const txn of tx) {
      const { transaction, description } = txn;
      if (this.opts?.debug)
        console.log(`Signing: ${description} for ${this.address()}`);

      const t: TransactionRequest = {
        ...transaction,
        ...gasOpts,
        from: this.address(),
        nonce: await this._signer.getNonce("pending"),
      };

      // TODO: Refactor signing code and remove manually incrementing nonce as a breaking change occured when bumping sdks
      // NonceManager should really take care of this?
      if ("increment" in this._signer) {
        (this._signer as Signer & NonceManager).increment();
      }

      // try {
      //   const estimate = await this._signer.provider!.estimateGas(t);
      //   t.gasLimit = estimate + estimate / 10n; // Add 10% buffer
      //   if (this.opts?.maxGasLimit && t.gasLimit > this.opts?.maxGasLimit) {
      //     throw new Error(
      //       `Gas limit ${t.gasLimit} exceeds maxGasLimit ${this.opts?.maxGasLimit}`,
      //     );
      //   }
      // } catch (e) {
      //   console.info('Failed to estimate gas for transaction: ', e);
      //   console.info('Using gas limit: ', t.gasLimit);
      // }

      signed.push(await this._signer.signTransaction(t));
    }
    return signed;
  }
}

export function isEvmNativeSigner<N extends Network>(
  signer: Signer<N>
): signer is EvmNativeSigner<N> {
  return (
    isNativeSigner(signer) &&
    chainToPlatform(signer.chain()) === _platform &&
    isEthersSigner(signer.unwrap())
  );
}

// No type guard provided by ethers, instanceof checks will fail on even slightly different versions of ethers
function isEthersSigner(thing: any): thing is EthersSigner {
  return (
    "provider" in thing &&
    typeof thing.connect === "function" &&
    typeof thing.getAddress === "function" &&
    typeof thing.getNonce === "function" &&
    typeof thing.populateCall === "function" &&
    typeof thing.populateTransaction === "function" &&
    typeof thing.estimateGas === "function" &&
    typeof thing.call === "function" &&
    typeof thing.resolveName === "function" &&
    typeof thing.signTransaction === "function" &&
    typeof thing.sendTransaction === "function" &&
    typeof thing.signMessage === "function" &&
    typeof thing.signTypedData === "function"
  );
}
