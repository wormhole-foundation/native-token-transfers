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

    for (const txn of tx) {
      const { transaction, description } = txn;
      if (this.opts?.debug)
        console.log(`Signing: ${description} for ${this.address()}`);

      // Build the transaction block
      const txb = new Transaction();
      // TODO: This is a placeholder - we'll need to properly construct
      // Sui transactions based on the transaction data
      
      // Sign the transaction
      const result = await this.client.signAndExecuteTransaction({
        signer: this._signer,
        transaction: txb,
      });

      signed.push(result.digest);
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