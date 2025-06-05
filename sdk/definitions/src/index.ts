import { registerPayloadTypes } from "@wormhole-foundation/sdk-definitions";
import { nttNamedPayloads } from "./layouts/index.js";

registerPayloadTypes("Ntt", nttNamedPayloads);

export * from "./ntt.js";
export * from "./nttWithExecutor.js";

export * from "./layouts/index.js";
export type * from "./layouts/index.js";
