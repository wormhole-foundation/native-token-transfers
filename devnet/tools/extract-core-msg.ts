#!/usr/bin/env ts-node

import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import { parse } from "dotenv";
import "dotenv/config";

type CliArgs = {
  tx: string;
  chain: "chainA" | "chainB";
};

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let tx = "";
  let chain: "chainA" | "chainB" | "" = "";
  for (const a of args) {
    const [k, v] = a.split("=");
    if (k === "--tx") tx = v;
    if (k === "--chain") {
      if (v !== "chainA" && v !== "chainB") {
        console.error(`--chain must be chainA or chainB`);
        process.exit(1);
      }
      chain = v;
    }
  }
  if (!tx || !chain) {
    console.error("Usage: extract-core-msg.ts --tx=0x... --chain=chainA|chainB");
    process.exit(1);
  }
  return { tx, chain };
}

function loadEnv(chain: "chainA" | "chainB") {
  const envPath = path.join("devnet", "chains", `${chain}.env`);
  if (!fs.existsSync(envPath)) {
    console.error(`Missing ${envPath}`);
    process.exit(1);
  }
  const cfg = parse(fs.readFileSync(envPath));
  const rpcUrl = cfg.RPC_URL;
  if (!rpcUrl) {
    console.error(`RPC_URL missing in ${envPath}`);
    process.exit(1);
  }
  return { rpcUrl, wormholeChainId: Number(cfg.WORMHOLE_CHAIN_ID) || 0 };
}

function loadDeployment() {
  const p = "devnet/config/deployment.local.json";
  if (!fs.existsSync(p)) {
    console.error("deployment.local.json not found. Run deploy scripts first.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function main() {
  const { tx, chain } = parseArgs();
  const { rpcUrl } = loadEnv(chain);
  const deployment = loadDeployment();
  const coreAddr: string | undefined = deployment.chains?.[chain]?.core;
  if (!coreAddr) {
    console.error(`Core address for ${chain} not found in deployment.local.json`);
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const receipt = await provider.getTransactionReceipt(tx);
  if (!receipt) {
    console.error(`Transaction receipt not found: ${tx}`);
    process.exit(1);
  }

  const eventSig =
    "event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)";
  const iface = new ethers.Interface([eventSig]);
  const topic0 = iface.getEvent("LogMessagePublished")!.topicHash;

  const coreLogs = receipt.logs.filter(
    (l) => l.address.toLowerCase() === coreAddr.toLowerCase() && l.topics[0] === topic0,
  );
  if (coreLogs.length === 0) {
    console.error("No LogMessagePublished found in this tx for Core.");
    process.exit(1);
  }
  const log = coreLogs[0];
  const decoded = iface.decodeEventLog("LogMessagePublished", log.data, log.topics);
  const sender: string = decoded.sender as string; // EVM address
  const sequence: bigint = decoded.sequence as bigint;
  const nonce: number = Number(decoded.nonce);
  const payload: string = decoded.payload as string;
  const consistencyLevel: number = Number(decoded.consistencyLevel);

  const emitterAddress32 = ethers.hexlify(ethers.zeroPadValue(sender, 32));

  // Print in a convenient, copy-pastable way
  const out = {
    core: coreAddr,
    sender,
    emitterAddress32,
    sequence: sequence.toString(),
    nonce,
    payload,
    consistencyLevel,
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


