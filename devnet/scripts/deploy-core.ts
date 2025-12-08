#!/usr/bin/env ts-node

import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import "dotenv/config";

// Required keys
const DEPLOYER_KEY = process.env["DEPLOYER_KEY"];
const DEV_GUARDIAN_KEY = process.env["DEV_GUARDIAN_KEY"];

if (!DEPLOYER_KEY) {
  console.error("DEPLOYER_KEY missing. Set it in env or devnet/config/env.example.");
  process.exit(1);
}
if (!DEV_GUARDIAN_KEY) {
  console.error("DEV_GUARDIAN_KEY missing. Set it in env or devnet/config/env.example.");
  process.exit(1);
}

// Artifacts (vendored)
const WORMHOLE_PROXY_ARTIFACT =
  process.env["WORMHOLE_PROXY_ARTIFACT"] ?? "devnet/artifacts/Wormhole.json";
const WORMHOLE_SETUP_ARTIFACT =
  process.env["WORMHOLE_SETUP_ARTIFACT"] ?? "devnet/artifacts/Setup.json";
const WORMHOLE_IMPLEMENTATION_ARTIFACT =
  process.env["WORMHOLE_IMPLEMENTATION_ARTIFACT"] ?? "devnet/artifacts/Implementation.json";

for (const p of [
  WORMHOLE_PROXY_ARTIFACT,
  WORMHOLE_SETUP_ARTIFACT,
  WORMHOLE_IMPLEMENTATION_ARTIFACT,
]) {
  if (!fs.existsSync(p)) {
    console.error(`Artifact not found: ${p}. Ensure Core artifacts are in devnet/artifacts/`);
    process.exit(1);
  }
}

const wormholeProxyArtifact = JSON.parse(fs.readFileSync(WORMHOLE_PROXY_ARTIFACT, "utf8"));
const setupArtifact = JSON.parse(fs.readFileSync(WORMHOLE_SETUP_ARTIFACT, "utf8"));
const implArtifact = JSON.parse(fs.readFileSync(WORMHOLE_IMPLEMENTATION_ARTIFACT, "utf8"));

const chains = ["chainA", "chainB"];
const deploymentPath = "devnet/config/deployment.local.json";
let deployment: any = { chains: {} };
if (fs.existsSync(deploymentPath)) {
  deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
}

function bytes32Zero(): string {
  return ethers.hexlify(ethers.zeroPadValue("0x00", 32));
}

async function deployToChain(envFile: string) {
  const envPath = path.join("devnet", "chains", envFile + ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing env file ${envPath}`);
  }
  const cfg = parseSimpleEnv(fs.readFileSync(envPath, "utf8"));
  console.log("cfg:", cfg);
  const rpcUrl = cfg["RPC_URL"];
  const wormholeChainId = Number(cfg["WORMHOLE_CHAIN_ID"]);
  const evmChainId = Number(cfg["CHAIN_ID"]);
  if (!rpcUrl || !wormholeChainId || !evmChainId) {
    throw new Error(`RPC_URL/CHAIN_ID/WORMHOLE_CHAIN_ID missing in ${envPath}`);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(DEPLOYER_KEY!, provider);
  const guardian = new ethers.Wallet(DEV_GUARDIAN_KEY!);
  const guardianAddr = await guardian.getAddress();

  // Governance settings for dev: point to itself and zero contract
  const governanceChainId = wormholeChainId;
  const governanceContract = bytes32Zero();

  console.log(`\n[${envFile}] Deploying Wormhole Core (rpc: ${rpcUrl})`);

  // 1) Deploy Implementation
  const implFactory = new ethers.ContractFactory(implArtifact.abi, implArtifact.bytecode, wallet);
  const impl = await implFactory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`  → Implementation at ${implAddr}`);

  // 2) Deploy Setup
  const setupFactory = new ethers.ContractFactory(setupArtifact.abi, setupArtifact.bytecode, wallet);
  const setup = await setupFactory.deploy();
  await setup.waitForDeployment();
  const setupAddr = await setup.getAddress();
  console.log(`  → Setup at ${setupAddr}`);

  // 3) Encode init data for Setup.setup(...)
  const setupIface = new ethers.Interface(setupArtifact.abi);
  const initData = setupIface.encodeFunctionData("setup", [
    implAddr,
    [guardianAddr],
    wormholeChainId,
    governanceChainId,
    governanceContract,
    evmChainId,
  ]);

  // 4) Deploy Proxy (Wormhole) pointing to Setup with initData
  const proxyFactory = new ethers.ContractFactory(
    wormholeProxyArtifact.abi,
    wormholeProxyArtifact.bytecode,
    wallet,
  );
  const proxy = await proxyFactory.deploy(setupAddr, initData);
  await proxy.waitForDeployment();
  const coreAddr = await proxy.getAddress();
  console.log(`  → Wormhole (proxy) at ${coreAddr}`);

  // Save
  deployment.chains[envFile] = {
    ...(deployment.chains[envFile] ?? {}),
    core: coreAddr,
    core_setup: setupAddr,
    core_impl: implAddr,
    guardian: guardianAddr,
    wormholeChainId,
    evmChainId,
  };
}

async function main() {
  for (const chain of chains) {
    await deployToChain(chain);
  }
  fs.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2) + "\n", "utf8");
  console.log(`\nDeployment manifest updated at ${deploymentPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

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
