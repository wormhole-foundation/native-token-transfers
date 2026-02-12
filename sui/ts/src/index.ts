import { registerProtocol } from "@wormhole-foundation/sdk-definitions";
import { _platform } from "@wormhole-foundation/sdk-sui";
import { SuiNtt } from "./ntt.js";
import { SuiNttWithExecutor } from "./nttWithExecutor.js";
import { register as registerDefinitions } from "@wormhole-foundation/sdk-definitions-ntt";

let _registered = false;

/** Explicitly register Sui NTT protocols. Idempotent — safe to call multiple times. */
export function register(): void {
  if (_registered) return;
  _registered = true;
  registerDefinitions();
  registerProtocol(_platform, "Ntt", SuiNtt);
  registerProtocol(_platform, "NttWithExecutor", SuiNttWithExecutor);
}

// Backward-compatible: auto-register on import
// TODO: remove this next time we are cool with a major version bump and are OK requiring integrators to make code changes
register();

export * from "./ntt.js";
export * from "./nttWithExecutor.js";
