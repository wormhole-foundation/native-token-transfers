#!/usr/bin/env ts-node

import { ethers } from "ethers";

function usage() {
  console.error("Usage: recover-vaa.ts --vaa=0x...");
  process.exit(1);
}

const args = process.argv.slice(2);
let vaa = "";
for (const a of args) {
  const [k, v] = a.split("=");
  if (k === "--vaa") vaa = v;
}
if (!vaa || !vaa.startsWith("0x")) usage();

const buf = Buffer.from(vaa.slice(2), "hex");
let o = 0;
const version = buf.readUInt8(o); o += 1;
const gsi = buf.readUInt32BE(o); o += 4;
const nSigs = buf.readUInt8(o); o += 1;

if (nSigs < 1) {
  console.error("No signatures in VAA");
  process.exit(1);
}

const guardianIndex = buf.readUInt8(o); o += 1;
const r = "0x" + buf.slice(o, o + 32).toString("hex"); o += 32;
const s = "0x" + buf.slice(o, o + 32).toString("hex"); o += 32;
const vByte = buf.readUInt8(o); o += 1;
const body = buf.slice(o);

const doubleKeccak = Buffer.from(ethers.keccak256(ethers.keccak256(body)).slice(2), "hex");
let recoveredDouble = "";
try {
  recoveredDouble = ethers.recoverAddress(doubleKeccak, { r, s, v: vByte });
} catch (e) {
  recoveredDouble = `(recover failed: ${(e as Error).message})`;
}

const ethMsgHash = Buffer.from(ethers.hashMessage(Buffer.from(ethers.keccak256(body).slice(2), "hex")).slice(2), "hex");
let recoveredEth = "";
try {
  recoveredEth = ethers.recoverAddress(ethMsgHash, { r, s, v: vByte });
} catch (e) {
  recoveredEth = `(recover failed: ${(e as Error).message})`;
}

console.log(JSON.stringify({
  version,
  guardianSetIndex: gsi,
  nSigs,
  sig: { guardianIndex, r, s, v: vByte },
  digests: {
    doubleKeccak: "0x" + doubleKeccak.toString("hex"),
    ethSignedMsgHash32: "0x" + ethMsgHash.toString("hex"),
  },
  recovered: {
    doubleKeccak: recoveredDouble,
    ethSignedMsgHash32: recoveredEth,
  }
}, null, 2));


