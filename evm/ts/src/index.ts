import { registerProtocol } from "@wormhole-foundation/sdk-definitions";
import { _platform } from "@wormhole-foundation/sdk-evm";
import { EvmNtt } from "./ntt.js";
import { EvmNttWithExecutor } from "./nttWithExecutor.js";
import { EvmMultiTokenNtt } from "./multiTokenNtt.js";
import { EvmMultiTokenNttWithExecutor } from "./multiTokenNttWithExecutor.js";
import "@wormhole-foundation/sdk-definitions-ntt";

registerProtocol(_platform, "Ntt", EvmNtt);
registerProtocol(_platform, "NttWithExecutor", EvmNttWithExecutor);
registerProtocol(_platform, "MultiTokenNtt", EvmMultiTokenNtt);
registerProtocol(
  _platform,
  "MultiTokenNttWithExecutor",
  EvmMultiTokenNttWithExecutor
);

export * as ethers_contracts from "./ethers-contracts/index.js";
export * from "./ntt.js";
export * from "./nttWithExecutor.js";
export * from "./multiTokenNtt.js";
export * from "./multiTokenNttWithExecutor.js";
export * from "./axelar.js";
