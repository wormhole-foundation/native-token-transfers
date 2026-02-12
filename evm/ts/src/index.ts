import { registerProtocol } from "@wormhole-foundation/sdk-definitions";
import { _platform } from "@wormhole-foundation/sdk-evm";
import { EvmNtt } from "./ntt.js";
import { EvmNttWithExecutor } from "./nttWithExecutor.js";
import { EvmMultiTokenNtt } from "./multiTokenNtt.js";
import { EvmMultiTokenNttWithExecutor } from "./multiTokenNttWithExecutor.js";
import { register as registerDefinitions } from "@wormhole-foundation/sdk-definitions-ntt";

let _registered = false;

/** Explicitly register EVM NTT protocols. Idempotent — safe to call multiple times. */
export function register(): void {
  if (_registered) return;
  _registered = true;
  registerDefinitions();
  registerProtocol(_platform, "Ntt", EvmNtt);
  registerProtocol(_platform, "NttWithExecutor", EvmNttWithExecutor);
  registerProtocol(_platform, "MultiTokenNtt", EvmMultiTokenNtt);
  registerProtocol(
    _platform,
    "MultiTokenNttWithExecutor",
    EvmMultiTokenNttWithExecutor,
  );
}

// Backward-compatible: auto-register on import
// TODO: remove this next time we are cool with a major version bump and are OK requiring integrators to make code changes
register();

export * as ethers_contracts from "./ethers-contracts/index.js";
export * from "./ntt.js";
export * from "./nttWithExecutor.js";
export * from "./multiTokenNtt.js";
export * from "./multiTokenNttWithExecutor.js";
