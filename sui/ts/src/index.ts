import { registerProtocol } from "@wormhole-foundation/sdk-definitions";
import { _platform } from "@wormhole-foundation/sdk-sui";
import { SuiNtt } from "./ntt.js";
import { SuiNttWithExecutor } from "./nttWithExecutor.js";
import "@wormhole-foundation/sdk-definitions-ntt";

registerProtocol(_platform, "Ntt", SuiNtt);
registerProtocol(_platform, "NttWithExecutor", SuiNttWithExecutor);

export * from "./ntt.js";
export * from "./nttWithExecutor.js";