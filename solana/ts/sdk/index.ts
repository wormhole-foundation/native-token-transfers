import { registerProtocol } from "@wormhole-foundation/sdk-definitions";
import { _platform } from "@wormhole-foundation/sdk-solana";
import { SolanaNtt } from "./ntt.js";
import { SolanaNttWithExecutor } from "./nttWithExecutor.js";
import { register as registerDefinitions } from "@wormhole-foundation/sdk-definitions-ntt";
import "./side-effects";

let _registered = false;

/** Explicitly register Solana NTT protocols. Idempotent — safe to call multiple times. */
export function register(): void {
  if (_registered) return;
  _registered = true;
  registerDefinitions();
  registerProtocol(_platform, "Ntt", SolanaNtt);
  registerProtocol(_platform, "NttWithExecutor", SolanaNttWithExecutor);
}

// Backward-compatible: auto-register on import
// TODO: remove this next time we are cool with a major version bump and are OK requiring integrators to make code changes
register();

export * from "./ntt.js";
export * from "./nttWithExecutor.js";
