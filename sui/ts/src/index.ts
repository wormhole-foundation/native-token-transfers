import {
  registerProtocol,
  protocolIsRegistered,
} from "@wormhole-foundation/sdk-definitions";
import { _platform } from "@wormhole-foundation/sdk-sui";
import { SuiNtt } from "./ntt.js";
import { SuiNttWithExecutor } from "./nttWithExecutor.js";
import { register as registerDefinitions } from "@wormhole-foundation/sdk-definitions-ntt";

let _explicitlyRegistered = false;

/** Explicitly register Sui NTT protocols. Idempotent — safe to call multiple times. */
export function register(_deprecatedTopLevel?: boolean): void {
  _explicitlyRegistered = true;
  registerDefinitions();
  if (!protocolIsRegistered(_platform, "Ntt")) {
    registerProtocol(_platform, "Ntt", SuiNtt);
  }
  if (!protocolIsRegistered(_platform, "NttWithExecutor")) {
    registerProtocol(_platform, "NttWithExecutor", SuiNttWithExecutor);
  }
}

// Backward-compatible: auto-register on import.
// Deferred so that consumers who call register() explicitly don't see the warning.
// TODO: remove this next time we are cool with a major version bump and are OK requiring integrators to make code changes
setTimeout(() => {
  if (!_explicitlyRegistered) {
    console.warn(
      "@wormhole-foundation/sdk-sui-ntt: auto-registration on import is deprecated. Import { register } and call it explicitly."
    );
  }
  register();
}, 0);

export * from "./ntt.js";
export * from "./nttWithExecutor.js";
