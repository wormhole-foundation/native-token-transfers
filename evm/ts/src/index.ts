import { registerProtocol } from "@wormhole-foundation/sdk-definitions";
import { _platform } from "@wormhole-foundation/sdk-evm";
import { EvmNtt } from "./ntt.js";
import { EvmNttWithExecutor } from "./nttWithExecutor.js";
import "@wormhole-foundation/sdk-definitions-ntt";

registerProtocol(_platform, "Ntt", EvmNtt);
registerProtocol(_platform, "NttWithExecutor", EvmNttWithExecutor);

export * as ethers_contracts from "./ethers-contracts/index.js";
export * from "./ntt.js";
export * from "./nttWithExecutor.js";
