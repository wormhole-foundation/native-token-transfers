#!/usr/bin/env ts-node

import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import "dotenv/config";

type ChainName = "chainA" | "chainB";

function parseArgs() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, v] = a.split("=");
    return [k.replace(/^--/, ""), v ?? ""];
  }));
  const source = args.source as ChainName;
  const dest = args.dest as ChainName;
  const amount = args.amount as string; // base units
  const recipient = args.recipient as string; // evm address
  if (!source || !dest || !amount || !recipient) {
    console.error("Usage: npx tsx devnet/scripts/ntt-transfer.ts --source=chainA --dest=chainB --amount=1000000000000000000 --recipient=0xabc...");
    process.exit(1);
  }
  return { source, dest, amount, recipient };
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

function toWormholeFormat(addr: string): string {
  return ethers.hexlify(ethers.zeroPadValue(addr, 32));
}

async function main() {
  const DEPLOYER_KEY = process.env["DEPLOYER_KEY"];
  if (!DEPLOYER_KEY) {
    console.error("DEPLOYER_KEY missing. Configure it in devnet/config/env.example.");
    process.exit(1);
  }

  const { source, dest, amount, recipient } = parseArgs();

  const deploymentPath = "devnet/config/deployment.local.json";
  if (!fs.existsSync(deploymentPath)) {
    console.error("deployment.local.json not found. Run deploy scripts first.");
    process.exit(1);
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

  const srcEnvPath = path.join("devnet", "chains", `${source}.env`);
  const dstEnvPath = path.join("devnet", "chains", `${dest}.env`);
  if (!fs.existsSync(srcEnvPath) || !fs.existsSync(dstEnvPath)) {
    console.error("Missing chain env files. Start local nets and create devnet/chains/*.env");
    process.exit(1);
  }
  const srcCfg = parseSimpleEnv(fs.readFileSync(srcEnvPath, "utf8"));
  const dstCfg = parseSimpleEnv(fs.readFileSync(dstEnvPath, "utf8"));
  const srcRPC = srcCfg["RPC_URL"];
  const dstRPC = dstCfg["RPC_URL"];
  const dstWhChainId = Number(dstCfg["WORMHOLE_CHAIN_ID"]);

  const src = deployment.chains?.[source];
  const dst = deployment.chains?.[dest];
  if (!src?.ntt_manager || !src?.weth || !dst?.weth) {
    console.error("Missing NTT manager/WETH in deployment.local.json. Run deploy-ntt.ts and deploy-tokenbridge.ts.");
    process.exit(1);
  }

  const srcProvider = new ethers.JsonRpcProvider(srcRPC);
  const dstProvider = new ethers.JsonRpcProvider(dstRPC);
  const srcWallet = new ethers.Wallet(DEPLOYER_KEY!, srcProvider);
  const dstWallet = new ethers.Wallet(DEPLOYER_KEY!, dstProvider); // for reads

  const nttManagerAbi = [
    "function transfer(uint256 amount, uint16 recipientChain, bytes32 recipient) payable returns (uint64)",
    "function quoteDeliveryPrice(uint16 recipientChain, bytes transceiverInstructions) view returns (uint256[] priceQuotes, uint256 totalPrice)",
    "function token() view returns (address)",
  ];
  const erc20Abi = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
  ];

  const manager = new ethers.Contract(src.ntt_manager, nttManagerAbi, srcWallet);
  const tokenAddr: string = src.weth; // await manager.token();
  const token = new ethers.Contract(tokenAddr, erc20Abi, srcWallet);

  // Approve manager
  const amt = BigInt(amount);
  const currentAllowance: bigint = await token.allowance(await srcWallet.getAddress(), manager.target as string);
  if (currentAllowance < amt) {
    console.log(`Approving ${manager.target} to spend ${amt.toString()} tokens...`);
    const tx = await token.approve(manager.target as string, amt);
    await tx.wait();
  }

  // Quote delivery price (manual mode fallback returns Core message fee)
  // IMPORTANT: transceiverInstructions must be length-prefixed; pass 0x00 for "no instructions"
  const emptyInstructions = "0x00";
  const [, totalPrice]: [bigint[], bigint] = await manager.quoteDeliveryPrice(dstWhChainId, emptyInstructions);
  console.log(`Delivery price (native): ${ethers.formatEther(totalPrice)} ETH`);

  // Destination balance before
  const dstToken = new ethers.Contract(dst.weth, erc20Abi, dstWallet);
  const beforeBal: bigint = await dstToken.balanceOf(recipient);
  console.log(`Dest balance before: ${beforeBal.toString()}`);

  // Send
  console.log("Sending NTT transfer...");
  const tx = await manager.transfer(amt, dstWhChainId, toWormholeFormat(recipient), { value: totalPrice });
  const rc = await tx.wait();
  console.log(`transfer.tx: ${tx.hash} status: ${rc?.status}`);

  // Poll destination balance for change
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const b: bigint = await dstToken.balanceOf(recipient);
    if (b > beforeBal) {
      console.log(`Dest balance after: ${b.toString()} (increased)`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("Timed out waiting for destination balance to increase. Check relayer logs.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


