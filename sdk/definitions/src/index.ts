import { registerPayloadTypes } from "@wormhole-foundation/sdk-definitions";
import {
  multiTokenNttNamedPayloads,
  nttNamedPayloads,
} from "./layouts/index.js";

registerPayloadTypes("Ntt", nttNamedPayloads);
registerPayloadTypes("MultiTokenNtt", multiTokenNttNamedPayloads);

export * from "./ntt.js";
export * from "./nttWithExecutor.js";
export * from "./multiTokenNtt.js";
export * from "./multiTokenNttWithExecutor.js";
export * from "./trimmedAmount.js";

export * from "./layouts/index.js";
export type * from "./layouts/index.js";
