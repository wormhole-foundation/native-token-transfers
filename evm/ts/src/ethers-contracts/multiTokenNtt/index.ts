import * as __1_1_0 from "./1_1_0/index.js";
import { WormholeTransceiver__factory } from "../1_1_0/index.js";

const _1_1_0 = {
  NttManager: {
    connect: __1_1_0.MultiTokenNtt__factory.connect,
  },
  NttTransceiver: {
    connect: WormholeTransceiver__factory.connect,
  },
  GmpManager: {
    connect: __1_1_0.GmpManager__factory.connect,
  },
};

export { _1_1_0 };
