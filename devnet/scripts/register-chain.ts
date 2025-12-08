#!/usr/bin/env ts-node

import "dotenv/config";
import fs from "fs";
import path from "path";
import { parse as parseEnvFile } from "dotenv";
import { ethers } from "ethers";

type ChainName = "chainA" | "chainB";

type Cli = {
  source: ChainName;        // chain whose Bridge is being registered
  dest: ChainName;          // chain where we submit registerChain
  deployerKey?: string;     // tx sender on dest
  guardianKey?: string;     // signer for VAA
  guardianSetIndex?: number;// defaults to dest Core current GSI
  sequence?: number;        // defaults to 1
  payloadChainId?: number;  // defaults to 0 (allowed per BridgeGovernance)
  noSend?: boolean;         // print VAA only
};

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function parseArgs(): Cli {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, v] = a.split("=");
    return [k.replace(/^--/, ""), v ?? ""];
  }));
  const source = (args.source as ChainName) || "chainA";
  const dest = (args.dest as ChainName) || (source === "chainA" ? "chainB" : "chainA");
  const deployerKey = args.deployerKey || process.env.DEPLOYER_KEY;
  const guardianKey = args.guardianKey || process.env.DEV_GUARDIAN_KEY;
  const guardianSetIndex = args.guardianSetIndex ? Number(args.guardianSetIndex) : undefined;
  const sequence = args.sequence ? Number(args.sequence) : 1;
  const payloadChainId = args.payloadChainId ? Number(args.payloadChainId) : 0;
  const noSend = args.noSend === "true" || args.noSend === "1";
  return { source, dest, deployerKey, guardianKey, guardianSetIndex, sequence, payloadChainId, noSend };
}

function loadChainEnv(chain: ChainName) {
  const envPath = path.join("devnet", "chains", `${chain}.env`);
  if (!fs.existsSync(envPath)) fail(`Missing ${envPath}. Start local nets first.`);
  const cfg = parseEnvFile(fs.readFileSync(envPath));
  const RPC_URL = cfg.RPC_URL;
  const WORMHOLE_CHAIN_ID = Number(cfg.WORMHOLE_CHAIN_ID);
  if (!RPC_URL) fail(`RPC_URL missing in ${envPath}`);
  if (!WORMHOLE_CHAIN_ID) fail(`WORMHOLE_CHAIN_ID missing/invalid in ${envPath}`);
  return { RPC_URL, WORMHOLE_CHAIN_ID };
}

function loadDeployment() {
  const p = path.join("devnet", "config", "deployment.local.json");
  if (!fs.existsSync(p)) fail("deployment.local.json not found. Run deploy scripts first.");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function beUint16(n: number): Buffer {
  return Buffer.from([(n >> 8) & 0xff, n & 0xff]);
}
function beUint32(n: number): Buffer {
  return Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function beUint64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
}
function hexToBuf(hex: string): Buffer {
  return Buffer.from(hex.replace(/^0x/, ""), "hex");
}

async function main() {
  const cli = parseArgs();
  if (!cli.deployerKey) fail("Missing deployer key (DEPLOYER_KEY or --deployerKey)");
  if (!cli.guardianKey) fail("Missing guardian key (DEV_GUARDIAN_KEY or --guardianKey)");

  console.log("cli:", cli);

  const d = loadDeployment();
  console.log("d:", d);

  const src = cli.source;
  const dst = cli.dest;

  const srcEnv = loadChainEnv(src);
  const dstEnv = loadChainEnv(dst);

  const coreSrc: string | undefined = d.chains?.[src]?.core;
  const bridgeSrc: string | undefined = d.chains?.[src]?.bridge;
  const coreDst: string | undefined = d.chains?.[dst]?.core;
  const bridgeDst: string | undefined = d.chains?.[dst]?.bridge;
  if (!coreSrc || !bridgeSrc || !coreDst || !bridgeDst) fail("Missing Core/Bridge addresses in deployment.local.json");

  const provDst = new ethers.JsonRpcProvider(dstEnv.RPC_URL);
  const deployer = new ethers.Wallet(cli.deployerKey!, provDst);

  // Read governance config from destination Bridge
  const bridgeDstIface = new ethers.Interface([
    "function governanceChainId() view returns (uint16)",
    "function governanceContract() view returns (bytes32)",
    "function registerChain(bytes vm)"
  ]);
  const bridgeDstC = new ethers.Contract(bridgeDst, bridgeDstIface, deployer);
  const governanceChainId: number = Number(await bridgeDstC.governanceChainId());
  const governanceContract: string = await bridgeDstC.governanceContract();
  console.log("governanceChainId:", governanceChainId);
  console.log("governanceContract:", governanceContract);

  // guardian set index from destination Core (default 0)
  const coreDstIface = new ethers.Interface([
    "function getCurrentGuardianSetIndex() view returns (uint32)"
  ]);
  const gsi = cli.guardianSetIndex !== undefined
    ? cli.guardianSetIndex
    : Number(await new ethers.Contract(coreDst, coreDstIface, provDst).getCurrentGuardianSetIndex());
  console.log("gsi:", gsi);

  // Build payload: left‑padded bytes32("TokenBridge") | action=1 | chainId=cli.payloadChainId | emitterChainID=src WORMHOLE_CHAIN_ID | emitterAddress=bytes32(bridgeSrc)
  const name = ethers.toUtf8Bytes("TokenBridge");
  const moduleLP = ethers.hexlify(ethers.concat([new Uint8Array(32 - name.length), name]));
  const action = "0x01";
  const chainIdField = beUint16(cli.payloadChainId);
  const emitterChain = beUint16(srcEnv.WORMHOLE_CHAIN_ID);
  const emitterAddr32 = ethers.zeroPadValue(bridgeSrc, 32);
  const payload = Buffer.concat([
    hexToBuf(moduleLP),
    hexToBuf(action),
    chainIdField,
    emitterChain,
    hexToBuf(emitterAddr32),
  ]);

  // Build VAA body (timestamp=0, nonce=0, emitter = governance emitter on dest)
  const body = Buffer.concat([
    Buffer.from([0,0,0,0]),
    Buffer.from([0,0,0,0]),
    beUint16(governanceChainId),
    hexToBuf(governanceContract),
    beUint64(BigInt(cli.sequence!)),
    Buffer.from([1]), // consistencyLevel
    payload,
  ]);
  console.log("body:", body);
  const bodyDigest = Buffer.from(ethers.keccak256(ethers.keccak256(body)).slice(2), "hex");
  console.log("bodyDigest:", bodyDigest);

  // Sign digest with guardian (no EIP-191)
  const guardian = new ethers.Wallet(cli.guardianKey!);
  console.log("guardian:", guardian.address);
  const sig = guardian.signingKey.sign(bodyDigest);
  const vNorm = (sig.recoveryParam ?? (sig.v ? (sig.v >= 27 ? sig.v - 27 : sig.v) : 0)) as number;
  if (vNorm !== 0 && vNorm !== 1) fail("guardian v must be 0/1 after normalization");

  // Pack VAA
  const header = Buffer.concat([
    Buffer.from([1]),
    beUint32(gsi),
    Buffer.from([1]),
  ]);
  const sigBytes = Buffer.concat([
    Buffer.from([0]),
    hexToBuf(sig.r),
    hexToBuf(sig.s),
    Buffer.from([vNorm]),
  ]);
  const vaa = Buffer.concat([header, sigBytes, body]);
  const VAA_HEX = "0x" + vaa.toString("hex");

  console.log("payloadPrefix:", "0x"+payload.slice(0,32).toString("hex"));
  console.log("bodyDigest:", "0x"+bodyDigest.toString("hex"));
  console.log("guardianSetIndex:", gsi);
  console.log("VAA:", VAA_HEX);

  if (cli.noSend) {
    console.log("noSend=true; skipping registerChain submission");
    return;
  }

  // Submit registerChain on destination
  try {
    const tx = await bridgeDstC.registerChain(VAA_HEX);
    const rc = await tx.wait();
    console.log("registerChain.tx:", tx.hash);
    console.log("status:", rc?.status);
  } catch (e: any) {
    console.error("registerChain reverted:", e?.reason || e?.message || e);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


