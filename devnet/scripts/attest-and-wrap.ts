#!/usr/bin/env ts-node

import "dotenv/config";
import fs from "fs";
import path from "path";
import { ethers } from "ethers";

type ChainName = "chainA" | "chainB";

type Cli = {
  source: ChainName;
  dest: ChainName;
  token: string;
  deployerKey?: string;
  guardianKey?: string;
  guardianSetIndex?: number;
  r?: string;
  s?: string;
  v?: string; // accepts 0/1/27/28 or hex byte
  sequence?: string; // optional manual override
  noSend?: boolean; // build-only
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
  const deployerKey = args["deployerKey"] || process.env["DEPLOYER_KEY"];
  const guardianKey = args["guardianKey"] || process.env["DEV_GUARDIAN_KEY"];
  const guardianSetIndex = args["guardianSetIndex"] ? Number(args["guardianSetIndex"]) : undefined;
  const r = args["r"];
  const s = args["s"];
  const v = args["v"];
  const sequence = args["sequence"];
  const noSend = args["noSend"] === "true" || args["noSend"] === "1";
  return { source, dest, token, deployerKey, guardianKey, guardianSetIndex, r, s, v, sequence, noSend };
}

function loadChainEnv(chain: ChainName) {
  const envPath = path.join("devnet", "chains", `${chain}.env`);
  if (!fs.existsSync(envPath)) fail(`Missing ${envPath}. Start local nets first.`);
  const cfg = parseSimpleEnv(fs.readFileSync(envPath, "utf8"));
  const RPC_URL = cfg["RPC_URL"];
  const WORMHOLE_CHAIN_ID = Number(cfg["WORMHOLE_CHAIN_ID"]);
  if (!RPC_URL) fail(`RPC_URL missing in ${envPath}`);
  if (!WORMHOLE_CHAIN_ID) fail(`WORMHOLE_CHAIN_ID missing/invalid in ${envPath}`);
  return { RPC_URL, WORMHOLE_CHAIN_ID };
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
function normalizeV(input: string | number | undefined): number | undefined {
  if (input === undefined) return undefined;
  let vNum: number;
  if (typeof input === "string") {
    if (input.startsWith("0x")) {
      vNum = parseInt(input, 16);
    } else {
      vNum = Number(input);
    }
  } else {
    vNum = input;
  }
  if (vNum >= 27) vNum = vNum - 27;
  if (vNum !== 0 && vNum !== 1) fail("v must normalize to 0 or 1");
  return vNum;
}

async function main() {
  const cli = parseArgs();
  const deployment = loadDeployment();

  const src = cli.source;
  const dst = cli.dest;
  const srcEnv = loadChainEnv(src);
  const dstEnv = loadChainEnv(dst);

  const coreSrc: string | undefined = deployment.chains?.[src]?.core;
  const bridgeSrc: string | undefined = deployment.chains?.[src]?.bridge;
  const bridgeDst: string | undefined = deployment.chains?.[dst]?.bridge;
  if (!coreSrc || !bridgeSrc || !bridgeDst) {
    fail(`Missing Core/Bridge addresses in deployment.local.json for ${src} or ${dst}`);
  }

  const providerSrc = new ethers.JsonRpcProvider(srcEnv.RPC_URL);
  const providerDst = new ethers.JsonRpcProvider(dstEnv.RPC_URL);

  const deployerKey = cli.deployerKey;
  if (!deployerKey) fail("Missing deployer key. Provide --deployerKey or DEPLOYER_KEY env.");
  const deployer = new ethers.Wallet(deployerKey, providerSrc);

  // 1) Attest on source chain
  const coreIface = new ethers.Interface([
    "function messageFee() view returns (uint256)",
  ]);
  const bridgeIface = new ethers.Interface([
    "function attestToken(address token, uint32 nonce)",
    "event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)",
  ]);

  const coreSrcC: any = new ethers.Contract(coreSrc, coreIface, providerSrc);
  const messageFee = await coreSrcC["messageFee"]();
  const bridgeSrcC: any = new ethers.Contract(bridgeSrc, bridgeIface, deployer);
  const tx = await bridgeSrcC["attestToken"](cli.token, 0, { value: messageFee });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) fail("attestToken tx failed");

  // 2) Extract Core message from receipt (emitter = sender, payload, seq, CL)
  const logTopic = bridgeIface.getEvent("LogMessagePublished")!.topicHash;
  const coreLogs = receipt.logs.filter((l: any) =>
    l.topics[0] === logTopic && l.address.toLowerCase() === coreSrc.toLowerCase()
  );
  if (coreLogs.length === 0) fail("No LogMessagePublished found for Core in attest tx");
  const decodedAny: any = bridgeIface.decodeEventLog("LogMessagePublished", coreLogs[0].data, coreLogs[0].topics);
  const sender = decodedAny["sender"] as string;
  const sequence = decodedAny["sequence"] as bigint;
  const payload = decodedAny["payload"] as string;
  const consistencyLevel = Number(decodedAny["consistencyLevel"]);
  const emitterAddress32 = ethers.hexlify(ethers.zeroPadValue(sender, 32));

  console.log("attest.tx:", tx.hash);
  console.log("emitter:", sender);
  console.log("sequence:", sequence.toString());
  console.log("payload:", payload);
  console.log("consistencyLevel:", consistencyLevel);

  // 3) Determine guardianSetIndex from destination Core
  const coreDstIface = new ethers.Interface([
    "function getCurrentGuardianSetIndex() view returns (uint32)"
  ]);
  let guardianSetIndex: number;
  if (cli.guardianSetIndex !== undefined) {
    guardianSetIndex = cli.guardianSetIndex;
  } else {
    const coreDstC: any = new ethers.Contract(deployment.chains?.[dst]?.core, coreDstIface, providerDst);
    const gsi = await coreDstC["getCurrentGuardianSetIndex"]();
    guardianSetIndex = Number(gsi);
  }

  // 4) Build body (timestamp=0, nonce=0)
  const body = Buffer.concat([
    Buffer.from([0,0,0,0]),
    Buffer.from([0,0,0,0]),
    beUint16(srcEnv.WORMHOLE_CHAIN_ID),
    hexToBuf(emitterAddress32),
    beUint64(sequence),
    Buffer.from([consistencyLevel & 0xff]),
    hexToBuf(payload),
  ]);
  const bodyDigest = Buffer.from(ethers.keccak256(ethers.keccak256(body)).slice(2), "hex");

  // 5) Signature: either provided r/s/v or sign with guardian key (no EIP-191)
  let r = cli.r;
  let s = cli.s;
  let vNorm = normalizeV(cli.v);
  if (!r || !s || vNorm === undefined) {
    const guardianKey = cli.guardianKey;
    if (!guardianKey) fail("Missing guardian signature and guardianKey. Provide --r/--s/--v or --guardianKey/DEV_GUARDIAN_KEY.");
    const wallet = new ethers.Wallet(guardianKey);
    console.log("guardian:", wallet.address);
    const sig = wallet.signingKey.sign(bodyDigest);
    r = sig.r;
    s = sig.s;
    const anySig: any = sig;
    vNorm = anySig.recoveryParam ?? (typeof sig.v === "number" ? (sig.v >= 27 ? sig.v - 27 : sig.v) : undefined);
    if (vNorm === undefined) fail("Unable to compute v from signature");
  }
  if (!r!.startsWith("0x")) r = "0x"+r;
  if (!s!.startsWith("0x")) s = "0x"+s;
  if (vNorm !== 0 && vNorm !== 1) fail("v must be 0 or 1 after normalization");

  // 6) Pack VAA
  const header = Buffer.concat([
    Buffer.from([1]),
    beUint32(guardianSetIndex),
    Buffer.from([1]), // nSigs
  ]);
  const sigBytes = Buffer.concat([
    Buffer.from([0]), // guardian index
    hexToBuf(r!),
    hexToBuf(s!),
    Buffer.from([vNorm]),
  ]);
  const vaa = Buffer.concat([header, sigBytes, body]);
  const VAA_HEX = "0x" + vaa.toString("hex");

  console.log("bodyDigest:", "0x"+bodyDigest.toString("hex"));
  console.log("r:", r);
  console.log("s:", s);
  console.log("v:", vNorm);
  console.log("VAA:", VAA_HEX);

  if (cli.noSend) {
    console.log("noSend=true; skipping createWrapped submission");
    return;
  }

  // 7) Submit createWrapped on destination Bridge
  const deployerDst = new ethers.Wallet(deployerKey, providerDst);
  const bridgeDstIface = new ethers.Interface([
    "function createWrapped(bytes encodedVm)"
  ]);
  const bridgeDstC: any = new ethers.Contract(bridgeDst, bridgeDstIface, deployerDst);
  try {
    const tx2 = await bridgeDstC["createWrapped"](VAA_HEX);
    const rc2 = await tx2.wait();
    console.log("createWrapped.tx:", tx2.hash);
    console.log("status:", rc2?.status);
  } catch (e: any) {
    console.error("createWrapped reverted:", e?.reason || e?.message || e);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


