import { ChainContext, type Chain, type ChainAddress, type Network, type Signer } from "@wormhole-foundation/sdk";
export type SignerType = "privateKey" | "ledger";
export type SignerSource = {
    type: SignerType;
    source: string;
};
export interface SignerStuff<N extends Network, C extends Chain> {
    chain: ChainContext<N, C>;
    signer: Signer<N, C>;
    address: ChainAddress<C>;
    source: SignerSource;
}
export declare function forgeSignerArgs(source: SignerSource): string;
export declare function getSigner<N extends Network, C extends Chain>(chain: ChainContext<N, C>, type: SignerType, source?: string, filePath?: string): Promise<SignerStuff<N, C>>;
