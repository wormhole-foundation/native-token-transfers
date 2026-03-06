import {
  registerProtocol,
  protocolIsRegistered,
} from "@wormhole-foundation/sdk-definitions";
import { _platform } from "@wormhole-foundation/sdk-xrpl";
import { XrplNtt } from "./ntt.js";
import { XrplNttWithExecutor } from "./nttWithExecutor.js";
import { register as registerDefinitions } from "@wormhole-foundation/sdk-definitions-ntt";

/** Explicitly register XRPL NTT protocols. Idempotent — safe to call multiple times. */
export function register(topLevel = false): void {
  if (topLevel) {
    console.warn(
      "@wormhole-foundation/sdk-xrpl-ntt: auto-registration on import is deprecated. Import { register } and call it explicitly."
    );
  }
  registerDefinitions();
  if (!protocolIsRegistered(_platform, "Ntt")) {
    registerProtocol(_platform, "Ntt", XrplNtt);
  }
  if (!protocolIsRegistered(_platform, "NttWithExecutor")) {
    registerProtocol(_platform, "NttWithExecutor", XrplNttWithExecutor);
  }
}

// Backward-compatible: auto-register on import
// TODO: remove this next time we are cool with a major version bump and are OK requiring integrators to make code changes
register(true);

export * from "./ntt.js";
export * from "./nttWithExecutor.js";
