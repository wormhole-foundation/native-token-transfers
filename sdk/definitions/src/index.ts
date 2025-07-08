import { registerPayloadTypes } from "@wormhole-foundation/sdk-definitions";
import { nttNamedPayloads } from "./layouts/index.js";

registerPayloadTypes("Ntt", nttNamedPayloads);

export * from "./ntt.js";
export type * from "./nttWithExecutor.js";

export * from "./layouts/index.js";
