#!/usr/bin/env ts-node

import fs from "fs";
import { ethers } from "ethers";

/*
One-shot VAA lab: builds governance payload (registerChain), constructs body,
computes double-keccak digest, signs with provided key, packs VAA, recovers
addresses, and optionally verifies against Core.

Usage (registerChain):
  npx tsx devnet/tools/vaa-lab.ts \
    --wchainA=2 \
    --bridgeA=0x... (20-byte address) \
    --gsi=0 \
    --key=0x... (guardian private key for 0x30Ab12...) \
    [--sequence=1] \
    [--coreRpc=http://127.0.0.1:8546] \
    [--core=0x...]
*/

type Args = {
  wchainA: number;
  bridgeA: string;
  gsi: number;
  key: string;
  sequence: bigint;
  coreRpc?: string;
  core?: string;
  govChainId?: number;
  govEmitter32?: string;
};

function parseArgs(): Args {
  const a = Object.fromEntries(process.argv.slice(2).map(s => {
    const [k, v] = s.split("="); return [k.replace(/^--/, ""), v];
  }));
  const wchainA = Number(a["wchainA"] || "");
  const bridgeA = a["bridgeA"] || "";
  const gsi = Number(a["gsi"] || "0");
  const key = a["key"] || "";
  const sequence = BigInt(a["sequence"] || "1");
  const coreRpc = a["coreRpc"];
  const core = a["core"];
  const govChainId = a["govChainId"] ? Number(a["govChainId"]) : undefined;
  const govEmitter32 = a["govEmitter32"];

  if (!wchainA || !bridgeA || !key) {
    console.error("Missing required args. Example:");
    console.error("  --wchainA=2 --bridgeA=0x... --gsi=0 --key=0x... [--sequence=1] [--coreRpc=...] [--core=0x...] [--govChainId=...] [--govEmitter32=0x..32]");
    process.exit(1);
  }
  return { wchainA, bridgeA, gsi, key, sequence, coreRpc, core, govChainId, govEmitter32 };
}

function toBytes32(addr: string): string {
  return ethers.zeroPadValue(addr, 32);
}

function buildRegisterChainPayload(wchainA: number, bridgeA: string): string {
  // TokenBridge governance module id = keccak256("TokenBridge")
  const modHash = ethers.keccak256(ethers.toUtf8Bytes("TokenBridge")); // 32 bytes
  const action = ethers.toBeHex(1, 1); // RegisterChain
  const chain = ethers.toBeHex(wchainA, 2);
  const emitter = toBytes32(bridgeA);
  return ethers.hexlify(ethers.concat([modHash, action, chain, emitter]));
}

function buildBody(wchainA: number, emitter32: string, sequence: bigint, consistencyLevel: number, payload: string): Buffer {
  const parts = [
    Buffer.from([0,0,0,0]), // timestamp
    Buffer.from([0,0,0,0]), // nonce
    Buffer.from([(wchainA >> 8) & 0xff, wchainA & 0xff]),
    Buffer.from(emitter32.slice(2), "hex"),
    Buffer.from(new Uint8Array([
      Number((sequence>>56n)&0xffn), Number((sequence>>48n)&0xffn),
      Number((sequence>>40n)&0xffn), Number((sequence>>32n)&0xffn),
      Number((sequence>>24n)&0xffn), Number((sequence>>16n)&0xffn),
      Number((sequence>>8n)&0xffn),  Number(sequence & 0xffn),
    ])),
    Buffer.from([consistencyLevel & 0xff]),
    Buffer.from((payload.startsWith("0x") ? payload.slice(2) : payload), "hex"),
  ];
  return Buffer.concat(parts);
}

function doubleKeccak(data: Buffer): string {
  return ethers.keccak256(ethers.keccak256(data));
}

async function main() {
  const { wchainA, bridgeA, gsi, key, sequence, core, coreRpc, govChainId, govEmitter32 } = parseArgs();
  const guardianAddr = new ethers.Wallet(key).address;

  const emitter32 = toBytes32(bridgeA);
  const payload = buildRegisterChainPayload(wchainA, bridgeA);
  // Use governance emitter override for the body if provided
  const bodyEmitterChain = (govChainId !== undefined) ? govChainId : wchainA;
  const bodyEmitter32 = (govEmitter32 && govEmitter32.length === 66) ? govEmitter32 : emitter32;
  const body = buildBody(bodyEmitterChain, bodyEmitter32, sequence, 1, payload);
  const digest = doubleKeccak(body);

  const sk = new ethers.SigningKey(key);
  const sig = sk.sign(ethers.getBytes(digest));
  const vNorm = (sig.recoveryParam ?? 0); // 0/1 in VAA
  const recoveredV0 = ethers.recoverAddress(digest, { r: sig.r, s: sig.s, v: vNorm });
  const recoveredV27 = ethers.recoverAddress(digest, { r: sig.r, s: sig.s, v: 27 + vNorm });

  const sigBytes = Buffer.concat([
    Buffer.from([0]), // guardian index
    Buffer.from(sig.r.slice(2), "hex"),
    Buffer.from(sig.s.slice(2), "hex"),
    Buffer.from([vNorm]),
  ]);
  const header = Buffer.concat([
    Buffer.from([1]),
    Buffer.from([(gsi>>24)&0xff, (gsi>>16)&0xff, (gsi>>8)&0xff, gsi&0xff]),
    Buffer.from([1]),
  ]);
  const vaa = Buffer.concat([header, sigBytes, body]);

  const vaaHex = "0x" + vaa.toString("hex");

  const result: any = {
    signer: guardianAddr,
    fields: {
      wchainA,
      bridgeA,
      payloadEmitter32: emitter32,
      bodyEmitterChain: bodyEmitterChain,
      bodyEmitter32: bodyEmitter32,
      sequence: sequence.toString(),
      gsi
    },
    payload,
    body: "0x" + body.toString("hex"),
    digest,
    signature: { r: sig.r, s: sig.s, v: vNorm },
    recovered: { v0: recoveredV0, v27: recoveredV27 },
    vaa: vaaHex,
  };

  if (core && coreRpc) {
    const abi = JSON.parse(fs.readFileSync("devnet/artifacts/Implementation.json","utf8")).abi;
    const provider = new ethers.JsonRpcProvider(coreRpc);
    const coreC = new ethers.Contract(core, abi, provider);
    try {
      const res = await coreC.parseAndVerifyVM(vaaHex);
      result.coreVerify = { valid: res[1], reason: res[2] };
    } catch (e: any) {
      result.coreVerify = { error: e.reason || e.message || String(e) };
    }
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


