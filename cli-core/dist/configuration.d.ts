import { type Chain } from "@wormhole-foundation/sdk";
import * as yargs from "yargs";
type ChainConfig = Partial<typeof configTemplate>;
declare const configTemplate: {
    scan_api_key: string;
};
export declare const command: (args: yargs.Argv<{}>) => yargs.Argv<{}>;
export declare function get(chain: Chain, key: keyof ChainConfig, { reportError }: {
    reportError?: boolean | undefined;
}): string | undefined;
export {};
