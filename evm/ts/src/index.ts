import { registerProtocol } from "@wormhole-foundation/sdk-definitions";
import { _platform } from "@wormhole-foundation/sdk-evm";
import { EvmNtt } from "./ntt.js";
import { EvmMultiTokenNtt } from "./multiTokenNtt.js";
import "@wormhole-foundation/sdk-definitions-ntt";

registerProtocol(_platform, "Ntt", EvmNtt);
registerProtocol(_platform, "MultiTokenNtt", EvmMultiTokenNtt);

export * as ethers_contracts from "./ethers-contracts/index.js";
export * from "./ntt.js";
