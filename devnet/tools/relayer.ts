#!/usr/bin/env ts-node

import "dotenv/config";
import fs from "fs";
import path from "path";
import { parse as parseEnvFile } from "dotenv";
import { ethers } from "ethers";

type ChainName = "chainA" | "chainB";

type Cli = {
  guardianKey?: string;
  deployerKey?: string;
  fromBlockA?: number;
  fromBlockB?: number;
  dryRun?: boolean;
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
  return {
    guardianKey: args.guardianKey || process.env.DEV_GUARDIAN_KEY,
    deployerKey: args.deployerKey || process.env.DEPLOYER_KEY,
    fromBlockA: args.fromBlockA ? Number(args.fromBlockA) : undefined,
    fromBlockB: args.fromBlockB ? Number(args.fromBlockB) : undefined,
    dryRun: args.dryRun === "true" || args.dryRun === "1",
  };
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
  // Parse CLI flags and env (guardian/deployer keys, optional fromBlock hints, dryRun)
  const cli = parseArgs();
  if (!cli.guardianKey) fail("Missing guardian key (DEV_GUARDIAN_KEY or --guardianKey)");
  if (!cli.deployerKey) fail("Missing deployer key (DEPLOYER_KEY or --deployerKey)");

  // Load deployment manifest and chain envs (RPC + Wormhole chain IDs)
  const d = loadDeployment();
  const A = loadChainEnv("chainA");
  const B = loadChainEnv("chainB");

  const coreA: string | undefined = d.chains?.chainA?.core;
  const coreB: string | undefined = d.chains?.chainB?.core;
  const bridgeA: string | undefined = d.chains?.chainA?.bridge;
  const bridgeB: string | undefined = d.chains?.chainB?.bridge;
  if (!coreA || !coreB || !bridgeA || !bridgeB) fail("Core/Bridge addresses missing in deployment.local.json");

  // Providers and signers for both chains. Deployer signs destination txs; guardian signs VAAs.
  const provA = new ethers.JsonRpcProvider(A.RPC_URL);
  const provB = new ethers.JsonRpcProvider(B.RPC_URL);
  const signerA = new ethers.Wallet(cli.deployerKey!, provA);
  const signerB = new ethers.Wallet(cli.deployerKey!, provB);
  const guardian = new ethers.Wallet(cli.guardianKey!);
  console.log("guardian:", guardian.address);
  console.log("deployer:", signerA.address);

  // Core interface for LogMessagePublished and guardian set index (GSI)
  const coreIface = new ethers.Interface([
    "event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)",
    "function getCurrentGuardianSetIndex() view returns (uint32)"
  ]);
  const topic0 = coreIface.getEvent("LogMessagePublished")!.topicHash;

  // TokenBridge entrypoints used for delivery (createWrapped, completeTransfer)
  const bridgeIface = new ethers.Interface([
    "function createWrapped(bytes encodedVm)",
    "function completeTransfer(bytes encodedVm)"
  ]);
  const bridgeAContract = new ethers.Contract(bridgeA, bridgeIface, signerA);
  const bridgeBContract = new ethers.Contract(bridgeB, bridgeIface, signerB);
  // NTT transceiver (manual mode) support
  // We only need receiveMessage(bytes) for delivery.
  const transceiverIface = new ethers.Interface([
    "function receiveMessage(bytes encodedMessage)",
  ]);
  const transceiverA: string | undefined = d.chains?.chainA?.ntt_transceiver;
  const transceiverB: string | undefined = d.chains?.chainB?.ntt_transceiver;
  const transceiverAContract = transceiverA
    ? new ethers.Contract(transceiverA, transceiverIface, signerA)
    : undefined;
  const transceiverBContract = transceiverB
    ? new ethers.Contract(transceiverB, transceiverIface, signerB)
    : undefined;

  async function getGSI(dest: "A" | "B"): Promise<number> {
    const coreAddr = dest === "A" ? coreA : coreB;
    const prov = dest === "A" ? provA : provB;
    const gsi: bigint = await new ethers.Contract(coreAddr!, coreIface, prov).getCurrentGuardianSetIndex();
    return Number(gsi);
  }

  // Pack a VAA (body + header + 1 signature) given the decoded core event and guardian signature
  function packVAA(opts: {
    emitterChainId: number;
    emitterAddress32: string;
    sequence: bigint;
    consistencyLevel: number;
    payload: string;
    guardianSetIndex: number;
    r: string; s: string; v: number;
  }): { bodyDigest: string; vaa: string } {
    const body = Buffer.concat([
      Buffer.from([0,0,0,0]),
      Buffer.from([0,0,0,0]),
      beUint16(opts.emitterChainId),
      hexToBuf(opts.emitterAddress32),
      beUint64(opts.sequence),
      Buffer.from([opts.consistencyLevel & 0xff]),
      hexToBuf(opts.payload),
    ]);
    const digest = Buffer.from(ethers.keccak256(ethers.keccak256(body)).slice(2), "hex");
    const header = Buffer.concat([
      Buffer.from([1]),
      beUint32(opts.guardianSetIndex),
      Buffer.from([1]),
    ]);
    const sig = Buffer.concat([
      Buffer.from([0]),
      hexToBuf(opts.r),
      hexToBuf(opts.s),
      Buffer.from([opts.v]),
    ]);
    const vaa = Buffer.concat([header, sig, body]);
    return { bodyDigest: "0x"+digest.toString("hex"), vaa: "0x"+vaa.toString("hex") };
  }

  // Sign the VAA body digest with the dev guardian key; normalize v to 0/1
  function signDigest(digestHex: string): { r: string; s: string; v: number } {
    const sig = guardian.signingKey.sign(digestHex);
    const v = (sig.recoveryParam ?? (sig.v ? (sig.v >= 27 ? sig.v - 27 : sig.v) : 0)) as number;
    if (v !== 0 && v !== 1) fail("guardian v must be 0/1 after normalization");
    return { r: sig.r, s: sig.s, v };
  }

  async function handleCoreLog(which: "A" | "B", log: ethers.Log) {
    try {
      // Identify src/dest contexts and contracts for this event
      const chain = which === "A" ? A : B;
      const dest = which === "A" ? "B" : "A";
      const coreAddr = which === "A" ? coreA! : coreB!;
      const bridgeLocal = which === "A" ? bridgeA! : bridgeB!;
      const bridgeRemote = which === "A" ? bridgeBContract : bridgeAContract;
      const nttLocal = which === "A" ? transceiverA : transceiverB;
      const nttRemote = which === "A" ? transceiverBContract : transceiverAContract;

      // Only process Core's LogMessagePublished
      if (log.address.toLowerCase() !== coreAddr.toLowerCase()) return;
      if (log.topics[0] !== topic0) return;

      // Decode core event; derive 32-byte emitter address
      const decoded = coreIface.decodeEventLog("LogMessagePublished", log.data, log.topics);
      const sender = decoded.sender as string;
      const sequence = decoded.sequence as bigint;
      const payload = decoded.payload as string;
      const cl = Number(decoded.consistencyLevel);
      const emitter32 = ethers.hexlify(ethers.zeroPadValue(sender, 32));

      // Determine protocol by emitter address (Bridge vs NTT Transceiver)
      const isBridgeMsg = sender.toLowerCase() === bridgeLocal.toLowerCase();
      const isNttMsg = nttLocal && sender.toLowerCase() === nttLocal.toLowerCase();
      if (!isBridgeMsg && !isNttMsg) return;

      // Build and sign a VAA for this message with the dev guardian
      const gsi = await getGSI(dest);
      const { bodyDigest } = packVAA({
        emitterChainId: chain.WORMHOLE_CHAIN_ID,
        emitterAddress32: emitter32,
        sequence,
        consistencyLevel: cl,
        payload,
        guardianSetIndex: gsi,
        r: "0x"+("".padStart(64,"0")), s: "0x"+("".padStart(64,"0")), v: 0
      });
      const { r, s, v } = signDigest(bodyDigest);
      const { vaa } = packVAA({
        emitterChainId: chain.WORMHOLE_CHAIN_ID,
        emitterAddress32: emitter32,
        sequence,
        consistencyLevel: cl,
        payload,
        guardianSetIndex: gsi,
        r, s, v
      });

      // TokenBridge type (first byte). NTT uses a 4-byte prefix.
      const typeByte = Number(hexToBuf(payload)[0] ?? 0xff);
      const prefix4 = payload.slice(0, 10).toLowerCase(); // 0x + 8 hex chars
      console.log(
        `[${which}] seq=${sequence.toString()} ${isBridgeMsg ? `tbType=${typeByte}` : `nttPrefix=${prefix4}`} digest=${bodyDigest}`
      );
      if (cli.dryRun) {
        console.log("VAA:", vaa);
        return;
      }

      // TokenBridge delivery
      if (isBridgeMsg) {
        if (typeByte === 2) {
          // Attestation -> createWrapped
          const tx = await bridgeRemote.createWrapped(vaa);
          const rc = await tx.wait();
          console.log(`[${which}] createWrapped.tx:`, tx.hash, "status:", rc?.status);
        } else if (typeByte === 1) {
          // Transfer -> completeTransfer
          const tx = await bridgeRemote.completeTransfer(vaa);
          const rc = await tx.wait();
          console.log(`[${which}] completeTransfer.tx:`, tx.hash, "status:", rc?.status);
        } else {
          console.log(`[${which}] Unknown TokenBridge payload type ${typeByte}; skipping`);
        }
        return;
      }

      // NTT Transceiver manual delivery path. Only forward "TransceiverMessage" payloads.
      // Prefixes (first 4 bytes):
      //  - Transceiver payload:  0x9945ff10
      //  - Init:                 0x9c23bd3b
      //  - Peer registration:    0x18fc67c2
      if (isNttMsg) {
        if (!nttRemote) {
          console.log(`[${which}] NTT remote transceiver not configured; skipping`);
          return;
        }
        if (prefix4 !== "0x9945ff10") {
          console.log(`[${which}] Non-transfer NTT payload (${prefix4}); skipping`);
          return;
        }
        // Submit VAA to destination transceiver
        const tx = await nttRemote.receiveMessage(vaa);
        const rc = await tx.wait();
        console.log(`[${which}] ntt.receiveMessage.tx:`, tx.hash, "status:", rc?.status);
        return;
      }
    } catch (e: any) {
      console.error(`[${which}] relay error:`, e?.reason || e?.message || e);
    }
  }

  // Live listeners
  const filterA = { address: coreA, topics: [topic0] };
  const filterB = { address: coreB, topics: [topic0] };
  provA.on(filterA, (log) => handleCoreLog("A", log));
  provB.on(filterB, (log) => handleCoreLog("B", log));

  // Optional: process past logs from a starting block
  if (cli.fromBlockA) {
    const past = await provA.getLogs({ address: coreA, topics: [topic0], fromBlock: cli.fromBlockA, toBlock: "latest" });
    for (const l of past) await handleCoreLog("A", l);
  }
  if (cli.fromBlockB) {
    const past = await provB.getLogs({ address: coreB, topics: [topic0], fromBlock: cli.fromBlockB, toBlock: "latest" });
    for (const l of past) await handleCoreLog("B", l);
  }

  console.log("Relayer running. Press Ctrl+C to exit.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


