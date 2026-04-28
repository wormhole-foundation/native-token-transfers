import {
  registerPayloadTypes,
  payloadFactory,
  composeLiteral,
} from "@wormhole-foundation/sdk-definitions";
import {
  multiTokenNttNamedPayloads,
  nttNamedPayloads,
} from "./layouts/index.js";

/** Explicitly register NTT payload types. Idempotent — safe to call multiple times. */
export function register(): void {
  if (!payloadFactory.has(composeLiteral("Ntt", nttNamedPayloads[0]![0]))) {
    registerPayloadTypes("Ntt", nttNamedPayloads);
  }
  if (
    !payloadFactory.has(
      composeLiteral("MultiTokenNtt", multiTokenNttNamedPayloads[0]![0])
    )
  ) {
    registerPayloadTypes("MultiTokenNtt", multiTokenNttNamedPayloads);
  }
}

export * from "./ntt.js";
export * from "./nttWithExecutor.js";
export * from "./multiTokenNtt.js";
export * from "./multiTokenNttWithExecutor.js";
export * from "./trimmedAmount.js";
export * from "./axelar.js";

export * from "./layouts/index.js";
export type * from "./layouts/index.js";
