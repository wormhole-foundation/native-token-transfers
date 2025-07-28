import type {
  Network,
  SignOnlySigner,
  SignedTx,
  Signer,
  UnsignedTransaction,
} from '@wormhole-foundation/sdk-connect';
import {
  PlatformNativeSigner,
  chainToPlatform,
  isNativeSigner,
} from '@wormhole-foundation/sdk-connect';
import {
  SuiPlatform,
  type SuiChains,
  _platform
} from '@wormhole-foundation/sdk-sui';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

export async function getSuiSigner(
  rpc: SuiClient,
  key: string | Ed25519Keypair,
  opts?: {
    debug?: boolean;
  },
): Promise<Signer> {
  const keypair: Ed25519Keypair =
    typeof key === 'string' ? Ed25519Keypair.fromSecretKey(key) : key;

  const chain = (await SuiPlatform.chainFromRpc(rpc))[1];
  const address = keypair.getPublicKey().toSuiAddress();

  return new SuiNativeSigner(
    chain,
    address,
    keypair,
    rpc,
    opts,
  );
}

export class SuiNativeSigner<N extends Network, C extends SuiChains = SuiChains>
  extends PlatformNativeSigner<Ed25519Keypair, N, C>
  implements SignOnlySigner<N, C>
{
  constructor(
    _chain: C,
    _address: string,
    _signer: Ed25519Keypair,
    readonly client: SuiClient,
    readonly opts?: { debug?: boolean },
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
    const signed = [];


    for (let i = 0; i < tx.length; i++) {
      const txn = tx[i];
      const { transaction, description } = txn;


      // Enhanced validation and logging

      if (transaction === null || transaction === undefined) {
        console.error("ERROR: Transaction is null/undefined");
        throw new Error(`Transaction ${i + 1} is null or undefined`);
      }

      // Use the actual transaction that was prepared, not a new empty one
      // The transaction is already a Transaction object from SuiUnsignedTransaction
      if (!(transaction instanceof Transaction)) {
        console.error("ERROR: Expected Transaction object, got:", typeof transaction);
        throw new Error(`Expected Transaction object, got ${typeof transaction}`);
      }

      try {

        // Log transaction details for debugging
        if (this.opts?.debug) {
        }

        // Sign the transaction
        let transactionBytes;
        if (transaction instanceof Uint8Array) {
          transactionBytes = transaction;
        } else {
          transaction.setSenderIfNotSet(this._signer.toSuiAddress());
          transactionBytes = await transaction.build({ client: this.client });
        }
        let result = await this._signer.signTransaction(transactionBytes);
        signed.push({ transactionBlock: result.bytes, signature: result.signature });
      } catch (error) {
        console.error(`ERROR: Failed to sign/execute transaction ${i + 1}:`);
        console.error("ERROR: Transaction signing error:", error);
        if (error instanceof Error) {
          console.error("ERROR: Transaction signing error stack:", error.stack);
        }

        // Log additional context that might help debug the bytes.length error
        console.error("ERROR: Transaction context at time of failure:");
        console.error("  - Description:", description);
        console.error("  - Transaction type:", typeof transaction);
        console.error("  - Transaction blockData exists:", !!transaction.blockData);
        console.error("  - Signer exists:", !!this._signer);
        console.error("  - Client exists:", !!this.client);

        throw error;
      }
    }

    return signed;
  }
}

export function isSuiNativeSigner<N extends Network>(
  signer: Signer<N>,
): signer is SuiNativeSigner<N> {
  return (
    isNativeSigner(signer) &&
    chainToPlatform(signer.chain()) === _platform &&
    isSuiKeypair(signer.unwrap())
  );
}

function isSuiKeypair(thing: any): thing is Ed25519Keypair {
  return (
    typeof thing.getPublicKey === 'function' &&
    typeof thing.signPersonalMessage === 'function' &&
    typeof thing.signTransaction === 'function'
  );
}
