import type { Network, SignOnlySigner, SignedTx, Signer, UnsignedTransaction } from '@wormhole-foundation/sdk-connect';
import { PlatformNativeSigner } from '@wormhole-foundation/sdk-connect';
import { type EvmChains } from '@wormhole-foundation/sdk-evm';
import type { Signer as EthersSigner, Provider } from 'ethers';
export declare function getEvmSigner(rpc: Provider, key: string | EthersSigner, opts?: {
    maxGasLimit?: bigint;
    chain?: EvmChains;
    debug?: boolean;
}): Promise<Signer>;
export declare function getEvmSignerForKey(rpc: Provider, privateKey: string): Promise<Signer>;
export declare function getEvmSignerForSigner(signer: EthersSigner): Promise<Signer>;
export declare class EvmNativeSigner<N extends Network, C extends EvmChains = EvmChains> extends PlatformNativeSigner<EthersSigner, N, C> implements SignOnlySigner<N, C> {
    readonly opts?: {
        maxGasLimit?: bigint | undefined;
        debug?: boolean | undefined;
    } | undefined;
    constructor(_chain: C, _address: string, _signer: EthersSigner, opts?: {
        maxGasLimit?: bigint | undefined;
        debug?: boolean | undefined;
    } | undefined);
    chain(): C;
    address(): string;
    sign(tx: UnsignedTransaction<N, C>[]): Promise<SignedTx[]>;
}
export declare function isEvmNativeSigner<N extends Network>(signer: Signer<N>): signer is EvmNativeSigner<N>;
