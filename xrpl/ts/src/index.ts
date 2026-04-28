import {
  registerProtocol,
  protocolIsRegistered,
} from "@wormhole-foundation/sdk-definitions";
import { _platform } from "@wormhole-foundation/sdk-xrpl";
import { XrplNtt } from "./ntt.js";
import { XrplNttWithExecutor } from "./nttWithExecutor.js";
import { register as registerDefinitions } from "@wormhole-foundation/sdk-definitions-ntt";

/** Explicitly register XRPL NTT protocols. Idempotent — safe to call multiple times. */
export function register(): void {
  registerDefinitions();
  if (!protocolIsRegistered(_platform, "Ntt")) {
    registerProtocol(_platform, "Ntt", XrplNtt);
  }
  if (!protocolIsRegistered(_platform, "NttWithExecutor")) {
    registerProtocol(_platform, "NttWithExecutor", XrplNttWithExecutor);
  }
}

export * from "./ntt.js";
export * from "./nttWithExecutor.js";
