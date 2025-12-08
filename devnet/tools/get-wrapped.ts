#!/usr/bin/env ts-node

import fs from "fs";
import path from "path";
import { ethers } from "ethers";

type ChainName = "chainA" | "chainB";

type Cli = {
  source: ChainName;      // origin chain of the token
  dest: ChainName;        // chain where wrapped resides
  token: string;          // token address on source chain
};

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function parseArgs(): Cli {
  const entries = process.argv.slice(2).map((a) => {
    const [k, v] = a.split("=");
    return [(k ?? "").replace(/^--/, ""), v ?? ""];
  });
  const args = Object.fromEntries(entries) as Record<string, string>;
  const source = ((args["source"] as any) as ChainName) || "chainA";
  const dest = ((args["dest"] as any) as ChainName) || (source === "chainA" ? "chainB" : "chainA");
  const token = args["token"] || "";
  if (!token) fail("Missing --token=<address> on source chain");
  return { source, dest, token };
}

function parseSimpleEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadDeployment() {
  const p = path.join("devnet", "config", "deployment.local.json");
  if (!fs.existsSync(p)) fail("deployment.local.json not found. Run deploy scripts first.");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadChainRpc(chain: ChainName): { rpcUrl: string; wormholeChainId: number } {
  const envPath = path.join("devnet", "chains", `${chain}.env`);
  if (!fs.existsSync(envPath)) fail(`Missing ${envPath}`);
  const cfg = parseSimpleEnv(fs.readFileSync(envPath, "utf8"));
  const rpcUrl = cfg["RPC_URL"];
  const wormholeChainId = Number(cfg["WORMHOLE_CHAIN_ID"]);
  if (!rpcUrl) fail(`RPC_URL missing in ${envPath}`);
  if (!wormholeChainId) fail(`WORMHOLE_CHAIN_ID missing/invalid in ${envPath}`);
  return { rpcUrl, wormholeChainId };
}

async function main() {
  const { source, dest, token } = parseArgs();
  const deployment = loadDeployment();

  const destBridge: string | undefined = deployment.chains?.[dest]?.bridge;
  const srcWormholeId: number | undefined = deployment.chains?.[source]?.wormholeChainId;
  if (!destBridge || !srcWormholeId) {
    fail("Missing bridge or wormholeChainId in deployment.local.json");
  }
  const { rpcUrl } = loadChainRpc(dest);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const iface = new ethers.Interface([
    "function wrappedAsset(uint16 chainId, bytes32 tokenAddress) view returns (address)"
  ]);
  const bridge = new ethers.Contract(destBridge, iface, provider);
  const token32 = ethers.zeroPadValue(token, 32);
  const wrapped: string = await bridge["wrappedAsset"](srcWormholeId, token32);

  console.log(JSON.stringify({ source, dest, srcWormholeId, token, token32, bridge: destBridge, wrapped }, null, 2));
  if (wrapped === ethers.ZeroAddress) {
    console.error("Wrapped asset not found (ZeroAddress). Did you run attest/createWrapped?");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


