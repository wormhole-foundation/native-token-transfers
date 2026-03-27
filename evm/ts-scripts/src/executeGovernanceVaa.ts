import { inspect } from "util";
import { ChainId } from "@certusone/wormhole-sdk";

import {
  loadOperatingChains,
  init,
  ChainInfo,
  getChainConfig,
  getSigner,
  getContractAddress,
} from "./env";
import { Governance__factory } from "../contract-bindings";

const processName = "executeGovernanceVaas";

type GovernanceConfig = {
  chainId: ChainId;
  vaa: string;
};

init();
const chains = loadOperatingChains();
async function run() {
  console.log(`Start ${processName}!`);

  const results = await Promise.all(
    chains.map(async (chain) => {
      let result;
      try {
        result = await executeGovernance(chain);
      } catch (error: unknown) {
        return { chainId: chain.chainId, peerUpdateTxs: [] as string[], error };
      }

      return result;
    })
  );

  for (const result of results) {
    if (!result) {
      continue;
    }
    
    if ("error" in result) {
      console.error(
        `${processName} failed for chain ${result.chainId}: ${inspect(result.error)}`
      );
      continue;
    }

    console.log(`${processName} succeeded for chain ${result.chainId}`);
  }
}

async function executeGovernance(
  chain: ChainInfo,
) {
  const log = (...args: any[]) => console.log(`[${chain.chainId}]`, ...args);
  const { vaa } = await getChainConfig<GovernanceConfig>("governance-vaas", chain.chainId);
  
  const governanceContract = await getGovernanceContract(chain);

  const vaaHex = Buffer.from(vaa, "base64").toString("hex");
  log("Executing governance with VAA: ", vaaHex);

  const tx = await governanceContract.performGovernance(
    `0x${vaaHex}`,
    {} // overrides
  );

  log(`Submitted governance transaction: ${tx.hash}`);

  await tx.wait();

  log("success.");
}

run().then(() => console.log("Done!"));

async function getGovernanceContract(chain: ChainInfo) {
  const signer = await getSigner(chain);
  const governanceAddress = await getContractAddress("GeneralPurposeGovernances", chain.chainId);
  return Governance__factory.connect(governanceAddress, signer);
}