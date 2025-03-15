/// <reference types="yargs" />
import "./side-effects";
import { ChainContext, type Chain, type ChainAddress, type Network } from "@wormhole-foundation/sdk";
import "@wormhole-foundation/sdk-evm-ntt";
import "@wormhole-foundation/sdk-solana-ntt";
import "@wormhole-foundation/sdk-definitions-ntt";
import type { Ntt, NttTransceiver } from "@wormhole-foundation/sdk-definitions-ntt";
export type Deployment<C extends Chain> = {
    ctx: ChainContext<Network, C>;
    ntt: Ntt<Network, C>;
    whTransceiver: NttTransceiver<Network, C, Ntt.Attestation>;
    decimals: number;
    manager: ChainAddress<C>;
    config: {
        remote?: ChainConfig;
        local?: ChainConfig;
    };
};
export type ChainConfig = {
    version: string;
    mode: Ntt.Mode;
    paused: boolean;
    owner: string;
    pauser?: string;
    manager: string;
    token: string;
    transceivers: {
        threshold: number;
        wormhole: {
            address: string;
            pauser?: string;
        };
    };
    limits: {
        outbound: string;
        inbound: Partial<{
            [C in Chain]: string;
        }>;
    };
};
export type Config = {
    network: Network;
    chains: Partial<{
        [C in Chain]: ChainConfig;
    }>;
    defaultLimits?: {
        outbound: string;
    };
};
export declare const YARGSCommand: import("yargs").Argv<{}>;
export declare function ensureNttRoot(pwd?: string): void;
