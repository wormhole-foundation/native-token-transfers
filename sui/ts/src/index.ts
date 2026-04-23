import {
  registerProtocol,
  protocolIsRegistered,
} from "@wormhole-foundation/sdk-definitions";
import { _platform } from "@wormhole-foundation/sdk-sui";
import { SuiNtt } from "./ntt.js";
import { SuiNttWithExecutor } from "./nttWithExecutor.js";
import { register as registerDefinitions } from "@wormhole-foundation/sdk-definitions-ntt";

/** Explicitly register Sui NTT protocols. Idempotent — safe to call multiple times. */
export function register(): void {
  registerDefinitions();
  if (!protocolIsRegistered(_platform, "Ntt")) {
    registerProtocol(_platform, "Ntt", SuiNtt);
  }
  if (!protocolIsRegistered(_platform, "NttWithExecutor")) {
    registerProtocol(_platform, "NttWithExecutor", SuiNttWithExecutor);
  }
}

export * from "./ntt.js";
export * from "./nttWithExecutor.js";
