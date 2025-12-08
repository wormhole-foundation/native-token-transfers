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

type ChainName = "chainA" | "chainB";
const deploymentPath = "devnet/config/deployment.local.json";
if (!fs.existsSync(deploymentPath)) {
  console.error("deployment.local.json not found. Run deploy scripts first.");
  process.exit(1);
}
const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

function toWormholeFormat(addr: string): string {
  return ethers.hexlify(ethers.zeroPadValue(addr, 32));
}

async function getProviderAndWallet(chain: ChainName) {
  const envPath = path.join("devnet", "chains", `${chain}.env`);
  if (!fs.existsSync(envPath)) throw new Error(`Missing ${envPath}`);
  const cfg = parseSimpleEnv(fs.readFileSync(envPath, "utf8"));
  const rpcUrl = cfg["RPC_URL"];
  const wormholeChainId = Number(cfg["WORMHOLE_CHAIN_ID"]);
  if (!rpcUrl || !wormholeChainId) throw new Error(`RPC_URL/WORMHOLE_CHAIN_ID missing in ${envPath}`);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(DEPLOYER_KEY!, provider);
  return { provider, wallet, wormholeChainId };
}

async function configurePeers() {
  // Read chain sections from the manifest and validate required NTT fields exist.
  // We need manager/transceiver addresses on both chains and the token (WETH) addresses
  // because we fetch decimals and prefund inventory for LOCKING mode.
  const a = deployment.chains?.chainA;
  const b = deployment.chains?.chainB;
  if (!a?.ntt_manager || !a?.ntt_transceiver || !b?.ntt_manager || !b?.ntt_transceiver) {
    throw new Error("NTT manager/transceiver missing in deployment.local.json. Run deploy-ntt.ts first.");
  }
  if (!a?.weth || !b?.weth) throw new Error("WETH addresses missing; run deploy-tokenbridge.ts first.");

  // Create providers and wallets for both chains using devnet/chains/*.env and DEPLOYER_KEY.
  // All subsequent admin calls (peers, isEvm) are onlyOwner on their respective contracts.
  const A = await getProviderAndWallet("chainA");
  const B = await getProviderAndWallet("chainB");

  // ABIs
  // Minimal ABIs to perform only the required calls for wiring peers and checking state.
  const nttManagerAbi = [
    "function setPeer(uint16 peerChainId, bytes32 peerContract, uint8 decimals, uint256 inboundLimit)",
    "function token() view returns (address)",
  ];
  const erc20Abi = [
    "function decimals() view returns (uint8)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function deposit() payable", // for WETH
  ];
  const wormholeStateAbi = [
    // Transceiver peer registry (used to authorize cross-chain messages by emitter)
    "function getWormholePeer(uint16 chainId) view returns (bytes32)",
    "function setWormholePeer(uint16 chainId, bytes32 peerContract) payable",
    "function setIsWormholeEvmChain(uint16 chainId, bool isEvm)",
  ];

  // Contracts
  // Bind the manager/transceiver/token contracts on each chain with the admin wallet.
  const mgrA = new ethers.Contract(a.ntt_manager, nttManagerAbi, A.wallet);
  const mgrB = new ethers.Contract(b.ntt_manager, nttManagerAbi, B.wallet);
  const whA = new ethers.Contract(a.ntt_transceiver, wormholeStateAbi, A.wallet);
  const whB = new ethers.Contract(b.ntt_transceiver, wormholeStateAbi, B.wallet);
  const tokenA = new ethers.Contract(a.weth, erc20Abi, A.wallet);
  const tokenB = new ethers.Contract(b.weth, erc20Abi, B.wallet);
  // core (for exact messageFee)
  const coreAbi = [
    "function messageFee() view returns (uint256)",
  ];
  // Validate Core is present to compute the exact fee required by setWormholePeer.
  if (!a.core || !b.core) {
    throw new Error("Core addresses missing; run deploy-core.ts first.");
  }
  const coreA = new ethers.Contract(a.core, coreAbi, A.provider);
  const coreB = new ethers.Contract(b.core, coreAbi, B.provider);

  // Fetch decimals on each chain
  // These are used to compute the inbound limit in native token units.
  const decA: number = await tokenA.decimals();
  const decB: number = await tokenB.decimals();

  // Register transceiver peers (publish messages; needs a tiny message fee on Core)
  // Pay EXACT Wormhole Core message fee
  // setWormholePeer requires msg.value == Core.messageFee(). We also no-op if peer already set.
  const msgFeeA: bigint = await coreA.messageFee();
  const msgFeeB: bigint = await coreB.messageFee();
  console.log("Setting WormholeTransceiver peers...");
  // Only set if not already set
  const wantPeerOnA = toWormholeFormat(b.ntt_transceiver);
  const wantPeerOnB = toWormholeFormat(a.ntt_transceiver);
  const hasPeerOnA: string = await whA.getWormholePeer(B.wormholeChainId);
  if (hasPeerOnA.toLowerCase() !== wantPeerOnA.toLowerCase()) {
    await (await whA.setWormholePeer(B.wormholeChainId, wantPeerOnA, { value: msgFeeA })).wait();
  }
  const hasPeerOnB: string = await whB.getWormholePeer(A.wormholeChainId);
  if (hasPeerOnB.toLowerCase() !== wantPeerOnB.toLowerCase()) {
    await (await whB.setWormholePeer(A.wormholeChainId, wantPeerOnB, { value: msgFeeB })).wait();
  }
  // Mark the counterparty Wormhole chain IDs as EVM (affects how emitter address comparisons are performed).
  await (await whA.setIsWormholeEvmChain(B.wormholeChainId, true)).wait();
  await (await whB.setIsWormholeEvmChain(A.wormholeChainId, true)).wait();
  console.log("  → Wormhole peers set");

  // Register manager peers
  // Each manager must know its remote manager (bytes32 address) and remote decimals.
  // We also set a generous inboundLimit to avoid rate-limit reverts during local testing.
  console.log("Setting NttManager peers...");
  // Large inbound limits for local dev
  const maxDecimals = Math.max(Number(decA), Number(decB));
  const MAX_LIMIT = ethers.parseUnits("1000000000", maxDecimals);
  await (await mgrA.setPeer(B.wormholeChainId, toWormholeFormat(b.ntt_manager), decB, MAX_LIMIT)).wait();
  await (await mgrB.setPeer(A.wormholeChainId, toWormholeFormat(a.ntt_manager), decA, MAX_LIMIT)).wait();
  console.log("  → Manager peers set");

  // Prefund chainB manager with WETH (LOCKING mode requires inventory to unlock)
  // Deposit some ETH into WETH and transfer to manager
  // The destination manager must hold inventory to unlock in LOCKING mode. We deposit via WETH
  // and transfer to manager so the first transfers will succeed without manual top-ups.
  const prefundAmount = ethers.parseEther(process.env["NTT_PREFUND_WETH"] ?? "100");
  console.log(`Prefunding chainB manager with ${ethers.formatEther(prefundAmount)} WETH...`);
  await (await tokenB.deposit({ value: prefundAmount })).wait();
  await (await tokenB.transfer(b.ntt_manager, prefundAmount)).wait();
  const mgrBBal = await tokenB.balanceOf(b.ntt_manager);
  console.log(`  → chainB manager WETH balance: ${ethers.formatEther(mgrBBal)} WETH`);
}

async function main() {
  await configurePeers();
  console.log("NTT configuration complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


