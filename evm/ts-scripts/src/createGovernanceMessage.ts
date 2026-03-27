import { ethers } from "ethers";
const elliptic = require("elliptic");
import { inspect } from "util";
import { ChainId } from "@certusone/wormhole-sdk";
import {
  loadOperatingChains,
  init,
  ChainInfo,
  loadScriptConfig,
  getContractAddress,
  loadGuardianSetIndex,
} from "./env";

type ManagerConfig = {
  token: string;
  chainId: ChainId;
};

function loadGuardianKey(): string {
  const key = process.env.GUARDIAN_KEY;
  if (!key) throw new Error("GUARDIAN_KEY environment variable is required");
  return key;
}

const governanceChainId = 1;
const governanceContract =
  "0x0000000000000000000000000000000000000000000000000000000000000004";

const governanceModule =
  "0x000000000000000047656E6572616C507572706F7365476F7665726E616E6365";

const processName = "deployGovernances";

init();
const chains = loadOperatingChains();

async function run() {
  console.log(`Start ${processName}!`);
  const managersConfiguration: ManagerConfig[] = loadScriptConfig("managers");

  const results = await Promise.all(
    chains.map(async (chain) => {
      const govAddress = await getContractAddress(
        "GeneralPurposeGovernances",
        chain.chainId
      );
      const managerConfig = managersConfiguration.find(
        (config) => config.chainId === chain.chainId
      );

      if (!managerConfig) {
        return {
          chainId: chain.chainId,
          error: "Manager configuration not found for chain",
        };
      }

      const vaa = await createAcceptDefaultAdminTransferVaa(
        chain,
        govAddress,
        managerConfig.token
      );

      console.log(`Vaa for chain: ${chain.chainId}: ${vaa}`);
      return { chainId: chain.chainId, vaa };
    })
  );

  for (const result of results) {
    if ("error" in result) {
      console.error(
        `Error deploying for chain ${result.chainId}: ${inspect(result.error)}`
      );
      continue;
    }

    console.log(`Deployed succeded for chain ${result.chainId}`);
  }
}

run().then(() => console.log("Done!"));

async function createAcceptDefaultAdminTransferVaa(
  chain: ChainInfo,
  generalPurposeGovernanceAddress: string,
  tokenAddress: string
) {
  const abi = ["function acceptDefaultAdminTransfer()"];
  const contract = new ethers.Contract(
    "0x0000000000000000000000000000000000000000",
    abi
  );

  const call = await contract.populateTransaction.acceptDefaultAdminTransfer();
  const callData = call.data;

  const payload = ethers.utils.solidityPack(
    ["bytes32", "uint8", "uin16", "address", "address", "uint16", "bytes"],
    [
      governanceModule,
      1,
      chain.chainId,
      generalPurposeGovernanceAddress,
      tokenAddress,
      callData,
    ]
  );

  return encodeAndSignGovernancePayload(payload);
}

export function encodeAndSignGovernancePayload(payload: string): string {
  const timestamp = Math.floor(+new Date() / 1000);
  const nonce = 1;
  const sequence = 1;
  const consistencyLevel = 1;

  const encodedVAABody = ethers.utils.solidityPack(
    ["uint32", "uint32", "uint16", "bytes32", "uint64", "uint8", "bytes"],
    [
      timestamp,
      nonce,
      governanceChainId,
      governanceContract,
      sequence,
      consistencyLevel,
      payload,
    ]
  );

  const hash = doubleKeccak256(encodedVAABody);

  // sign the hash
  const ec = new elliptic.ec("secp256k1");
  const key = ec.keyFromPrivate(loadGuardianKey());
  const signature = key.sign(hash.substring(2), { canonical: true });

  // pack the signatures
  const packSig = [
    ethers.utils.solidityPack(["uint8"], [0]).substring(2),
    zeroPadBytes(signature.r.toString(16), 32),
    zeroPadBytes(signature.s.toString(16), 32),
    ethers.utils
      .solidityPack(["uint8"], [signature.recoveryParam])
      .substring(2),
  ];

  const vm = [
    ethers.utils.solidityPack(["uint8"], [1]).substring(2),
    ethers.utils
      .solidityPack(["uint32"], [loadGuardianSetIndex()])
      .substring(2), // guardianSetIndex
    ethers.utils.solidityPack(["uint8"], [1]).substring(2), // number of signers
    [packSig],
    encodedVAABody.substring(2),
  ].join("");

  return "0x" + vm;
}

export function zeroPadBytes(value: string, length: number): string {
  while (value.length < 2 * length) {
    value = "0" + value;
  }
  return value;
}

function doubleKeccak256(body: ethers.BytesLike) {
  return ethers.utils.keccak256(ethers.utils.keccak256(body));
}
