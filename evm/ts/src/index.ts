import {
  registerProtocol,
  protocolIsRegistered,
} from "@wormhole-foundation/sdk-definitions";
import { _platform } from "@wormhole-foundation/sdk-evm";
import { EvmNtt } from "./ntt.js";
import { EvmNttWithExecutor } from "./nttWithExecutor.js";
import { EvmMultiTokenNtt } from "./multiTokenNtt.js";
import { EvmMultiTokenNttWithExecutor } from "./multiTokenNttWithExecutor.js";
import { register as registerDefinitions } from "@wormhole-foundation/sdk-definitions-ntt";

let _explicitlyRegistered = false;

/** Explicitly register EVM NTT protocols. Idempotent — safe to call multiple times. */
export function register(_deprecatedTopLevel?: boolean): void {
  _explicitlyRegistered = true;
  registerDefinitions();
  if (!protocolIsRegistered(_platform, "Ntt")) {
    registerProtocol(_platform, "Ntt", EvmNtt);
  }
  if (!protocolIsRegistered(_platform, "NttWithExecutor")) {
    registerProtocol(_platform, "NttWithExecutor", EvmNttWithExecutor);
  }
  if (!protocolIsRegistered(_platform, "MultiTokenNtt")) {
    registerProtocol(_platform, "MultiTokenNtt", EvmMultiTokenNtt);
  }
  if (!protocolIsRegistered(_platform, "MultiTokenNttWithExecutor")) {
    registerProtocol(
      _platform,
      "MultiTokenNttWithExecutor",
      EvmMultiTokenNttWithExecutor
    );
  }
}

// Backward-compatible: auto-register on import.
// Deferred so that consumers who call register() explicitly don't see the warning.
// TODO: remove this next time we are cool with a major version bump and are OK requiring integrators to make code changes
setTimeout(() => {
  if (!_explicitlyRegistered) {
    console.warn(
      "@wormhole-foundation/sdk-evm-ntt: auto-registration on import is deprecated. Import { register } and call it explicitly."
    );
  }
  register();
}, 0);

export * as ethers_contracts from "./ethers-contracts/index.js";
export * from "./ntt.js";
export * from "./nttWithExecutor.js";
export * from "./multiTokenNtt.js";
export * from "./multiTokenNttWithExecutor.js";
