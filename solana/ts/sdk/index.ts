import { registerProtocol } from "@wormhole-foundation/sdk-definitions";
import { _platform } from "@wormhole-foundation/sdk-solana";
import { SolanaNtt } from "./ntt.js";
import { SolanaNttWithExecutor } from "./nttWithExecutor.js";
import "@wormhole-foundation/sdk-definitions-ntt";

registerProtocol(_platform, "Ntt", SolanaNtt);
registerProtocol(_platform, "NttWithExecutor", SolanaNttWithExecutor);

export * from "./ntt.js";
export * from "./nttWithExecutor.js";
