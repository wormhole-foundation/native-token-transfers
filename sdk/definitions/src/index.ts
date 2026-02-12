import { registerPayloadTypes } from "@wormhole-foundation/sdk-definitions";
import {
  multiTokenNttNamedPayloads,
  nttNamedPayloads,
} from "./layouts/index.js";

let _registered = false;

/** Explicitly register NTT payload types. Idempotent — safe to call multiple times. */
export function register(): void {
  if (_registered) return;
  _registered = true;
  registerPayloadTypes("Ntt", nttNamedPayloads);
  registerPayloadTypes("MultiTokenNtt", multiTokenNttNamedPayloads);
}

// Backward-compatible: auto-register on import
// TODO: remove this next time we are cool with a major version bump and are OK requiring integrators to make code changes
register();

export * from "./ntt.js";
export * from "./nttWithExecutor.js";
export * from "./multiTokenNtt.js";
export * from "./multiTokenNttWithExecutor.js";
export * from "./trimmedAmount.js";
export * from "./axelar.js";

export * from "./layouts/index.js";
export type * from "./layouts/index.js";
