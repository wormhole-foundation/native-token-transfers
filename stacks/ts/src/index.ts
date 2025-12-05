import { registerProtocol } from "@wormhole-foundation/sdk-definitions";
import { _platform } from "@wormhole-foundation/sdk-stacks";
import { StacksNtt } from "./ntt.js";
import { StacksNttWithExecutor } from "./nttWithExecutor.js";
import "@wormhole-foundation/sdk-definitions-ntt";
import "@wormhole-foundation/sdk-stacks-core";

registerProtocol(_platform, "Ntt", StacksNtt);
registerProtocol(_platform, "NttWithExecutor", StacksNttWithExecutor);

export * from "./ntt.js";
export * from "./nttWithExecutor.js";
