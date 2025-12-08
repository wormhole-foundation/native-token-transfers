#!/usr/bin/env ts-node

import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import "dotenv/config";

const DEPLOYER_KEY = process.env["DEPLOYER_KEY"];
if (!DEPLOYER_KEY) {
  console.error("DEPLOYER_KEY missing. Configure it in devnet/config/env.example.");
  process.exit(1);
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

// Vendored artifacts
const BRIDGE_PROXY_ARTIFACT =
  process.env["BRIDGE_PROXY_ARTIFACT"] ?? "devnet/artifacts/TokenBridge.json";
const BRIDGE_SETUP_ARTIFACT =
  process.env["BRIDGE_SETUP_ARTIFACT"] ?? "devnet/artifacts/BridgeSetup.json";
const BRIDGE_IMPLEMENTATION_ARTIFACT =
  process.env["BRIDGE_IMPLEMENTATION_ARTIFACT"] ?? "devnet/artifacts/BridgeImplementation.json";
const TOKEN_IMPLEMENTATION_ARTIFACT =
  process.env["TOKEN_IMPLEMENTATION_ARTIFACT"] ?? "devnet/artifacts/TokenImplementation.json";
const WETH_ARTIFACT = process.env["WETH_ARTIFACT"] ?? "devnet/artifacts/MockWETH9.json";

for (const p of [
  BRIDGE_PROXY_ARTIFACT,
  BRIDGE_SETUP_ARTIFACT,
  BRIDGE_IMPLEMENTATION_ARTIFACT,
  TOKEN_IMPLEMENTATION_ARTIFACT,
  WETH_ARTIFACT,
]) {
  if (!fs.existsSync(p)) {
    console.error(`Artifact not found: ${p}. Ensure Bridge artifacts are in devnet/artifacts/`);
  process.exit(1);
}
}

const bridgeProxyArtifact = JSON.parse(fs.readFileSync(BRIDGE_PROXY_ARTIFACT, "utf8"));
const bridgeSetupArtifact = JSON.parse(fs.readFileSync(BRIDGE_SETUP_ARTIFACT, "utf8"));
const bridgeImplArtifact = JSON.parse(fs.readFileSync(BRIDGE_IMPLEMENTATION_ARTIFACT, "utf8"));
const tokenImplArtifact = JSON.parse(fs.readFileSync(TOKEN_IMPLEMENTATION_ARTIFACT, "utf8"));
const wethArtifact = JSON.parse(fs.readFileSync(WETH_ARTIFACT, "utf8"));

const deploymentPath = "devnet/config/deployment.local.json";
if (!fs.existsSync(deploymentPath)) {
  console.error("deployment.local.json not found. Run deploy-core.ts first.");
  process.exit(1);
}
const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
const chains = ["chainA", "chainB"];

function bytes32Zero(): string {
  return ethers.hexlify(ethers.zeroPadValue("0x00", 32));
}

async function deployBridge(envFile: string) {
  const envPath = path.join("devnet", "chains", envFile + ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing env file ${envPath}`);
  }
  const cfg = parseSimpleEnv(fs.readFileSync(envPath, "utf8"));
  const rpcUrl = cfg["RPC_URL"];
  const wormholeChainId = Number(cfg["WORMHOLE_CHAIN_ID"]);
  const evmChainId = Number(cfg["CHAIN_ID"]);
  if (!rpcUrl || !wormholeChainId || !evmChainId) {
    throw new Error(`RPC_URL/CHAIN_ID/WORMHOLE_CHAIN_ID missing in ${envPath}`);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(DEPLOYER_KEY!, provider);

  const chainDeployment = deployment.chains?.[envFile];
  if (!chainDeployment?.core) {
    throw new Error(`Core address missing for ${envFile}. Run deploy-core.ts first.`);
  }
  const coreAddr = chainDeployment.core;

  console.log(`\n[${envFile}] Deploying Token Bridge (rpc: ${rpcUrl})`);

  // 1) TokenImplementation
  const tokenImplFactory = new ethers.ContractFactory(
    tokenImplArtifact.abi,
    tokenImplArtifact.bytecode,
    wallet,
  );
  const tokenImpl = await tokenImplFactory.deploy();
  await tokenImpl.waitForDeployment();
  const tokenImplAddr = await tokenImpl.getAddress();
  console.log(`  → TokenImplementation at ${tokenImplAddr}`);

  // 2) BridgeImplementation
  const bridgeImplFactory = new ethers.ContractFactory(
    bridgeImplArtifact.abi,
    bridgeImplArtifact.bytecode,
    wallet,
  );
  const bridgeImpl = await bridgeImplFactory.deploy();
  await bridgeImpl.waitForDeployment();
  const bridgeImplAddr = await bridgeImpl.getAddress();
  console.log(`  → BridgeImplementation at ${bridgeImplAddr}`);

  // 3) BridgeSetup
  const bridgeSetupFactory = new ethers.ContractFactory(
    bridgeSetupArtifact.abi,
    bridgeSetupArtifact.bytecode,
    wallet,
  );
  const bridgeSetup = await bridgeSetupFactory.deploy();
  await bridgeSetup.waitForDeployment();
  const bridgeSetupAddr = await bridgeSetup.getAddress();
  console.log(`  → BridgeSetup at ${bridgeSetupAddr}`);

  // 4) WETH (deploy mock if not provided)
  let wethAddr = process.env["WETH_ADDRESS"];
  if (!wethAddr || wethAddr === "") {
    const wethFactory = new ethers.ContractFactory(wethArtifact.abi, wethArtifact.bytecode, wallet);
    const weth = await wethFactory.deploy();
    await weth.waitForDeployment();
    wethAddr = await weth.getAddress();
    console.log(`  → MockWETH9 at ${wethAddr}`);
  } else {
    console.log(`  → Using provided WETH at ${wethAddr}`);
  }

  // 5) Encode init for BridgeSetup.setup(...)
  const governanceChainId = wormholeChainId;
  const governanceContract = bytes32Zero();
  const finality = Number(process.env["BRIDGE_FINALITY"] ?? 1);
  const setupIface = new ethers.Interface(bridgeSetupArtifact.abi);
  const initData = setupIface.encodeFunctionData("setup", [
    bridgeImplAddr,
    wormholeChainId,
    coreAddr,
    governanceChainId,
    governanceContract,
    tokenImplAddr,
    wethAddr,
    finality,
    evmChainId,
  ]);

  // 6) Deploy Proxy (TokenBridge) pointing to BridgeSetup with initData
  const proxyFactory = new ethers.ContractFactory(
    bridgeProxyArtifact.abi,
    bridgeProxyArtifact.bytecode,
    wallet,
  );
  const proxy = await proxyFactory.deploy(bridgeSetupAddr, initData);
  await proxy.waitForDeployment();
  const bridgeAddr = await proxy.getAddress();
  console.log(`  → TokenBridge (proxy) at ${bridgeAddr}`);

  // Save
  deployment.chains[envFile] = {
    ...(deployment.chains[envFile] ?? {}),
    bridge: bridgeAddr,
    bridge_setup: bridgeSetupAddr,
    bridge_impl: bridgeImplAddr,
    token_impl: tokenImplAddr,
    weth: wethAddr,
  };
}

async function main() {
  for (const chain of chains) {
    await deployBridge(chain);
  }
  fs.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2) + "\n", "utf8");
  console.log(`\nDeployment manifest updated at ${deploymentPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
