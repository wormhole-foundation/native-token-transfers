import {
  registerProtocol,
  protocolIsRegistered,
} from "@wormhole-foundation/sdk-definitions";
import { _platform } from "@wormhole-foundation/sdk-sui";
import { SuiNtt } from "./ntt.js";
import { SuiNttWithExecutor } from "./nttWithExecutor.js";
import { register as registerDefinitions } from "@wormhole-foundation/sdk-definitions-ntt";

/** Explicitly register Sui NTT protocols. Idempotent — safe to call multiple times. */
export function register(topLevel = false): void {
  if (topLevel) {
    console.warn(
      "@wormhole-foundation/sdk-sui-ntt: auto-registration on import is deprecated. Import { register } and call it explicitly."
    );
  }
  registerDefinitions();
  if (!protocolIsRegistered(_platform, "Ntt")) {
    registerProtocol(_platform, "Ntt", SuiNtt);
  }
  if (!protocolIsRegistered(_platform, "NttWithExecutor")) {
    registerProtocol(_platform, "NttWithExecutor", SuiNttWithExecutor);
  }
}

// Backward-compatible: auto-register on import
// TODO: remove this next time we are cool with a major version bump and are OK requiring integrators to make code changes
register(true);

export * from "./ntt.js";
export * from "./nttWithExecutor.js";
