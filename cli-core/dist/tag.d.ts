import type { Platform } from "@wormhole-foundation/sdk";
export declare function getAvailableVersions<P extends Platform>(platform: P): string[];
export declare function getGitTagName<P extends Platform>(platform: P, version: string): string | undefined;
